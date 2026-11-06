import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LotteryClaimStatus,
  LotteryDrawStatus,
  LotteryPayoutStatus,
  Prisma,
  type LotteryDraw,
} from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  type DrawStatusWire,
} from '../dto/lottery-draw.dto';
import type {
  MyClaimsQueryDto,
  RequestClaimDto,
} from '../dto/lottery-claim.dto';
import { drawStatusToWire } from '../lottery-draws.service';
import { drawNotFound, LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { toDateString } from '../lottery-time';
import {
  PUBLISH_TRANSACTION_MAX_WAIT_MS,
  PUBLISH_TRANSACTION_TIMEOUT_MS,
} from '../results/lottery-publish.service';
import {
  parseStoredPayoutGroups,
  type TicketWonGroup,
} from '../results/payout-groups';
import {
  claimStatusToWire,
  rejectReasonToWire,
  type ClaimRejectReasonWire,
  type ClaimStatusWire,
  type DrawClaimStatusWire,
} from './claim-status';

/** A payout with the ticket the customer's claim view lists. */
const PAYOUT_INCLUDE = {
  ticket: { select: { ticketNo: true, number: true } },
} satisfies Prisma.LotteryPayoutInclude;

type StoredPayout = Prisma.LotteryPayoutGetPayload<{
  include: typeof PAYOUT_INCLUDE;
}>;

/** A claim with the draw its list row names. */
const MY_CLAIM_INCLUDE = {
  draw: { select: { drawNo: true, thaiDrawDate: true } },
} satisfies Prisma.LotteryClaimInclude;

type StoredMyClaim = Prisma.LotteryClaimGetPayload<{
  include: typeof MY_CLAIM_INCLUDE;
}>;

/** One winning ticket inside the customer's claim view. */
export interface DrawClaimTicketView {
  ticketNo: string;
  number: string;
  ks: number;
  wonGroups: TicketWonGroup[];
}

/**
 * The customer's prize situation in one draw — what the "You won" panel,
 * the ticket view's prize card and the request sheet read. Numbers are JS
 * numbers like the rest of the customer lottery API.
 */
export interface DrawClaimView {
  drawNo: number;
  /** "YYYY-MM-DD", the Thai calendar date. */
  thaiDrawDate: string;
  drawStatus: DrawStatusWire;
  /** The caller's winning tickets in this draw (0 = nothing to claim). */
  wonTickets: number;
  /** Everything those tickets won, added up. */
  prizeKs: number;
  /** "none" without a winning ticket; else the claim's status, or not_requested / expired. */
  status: DrawClaimStatusWire;
  claimId: string | null;
  requestedAt: Date | null;
  decidedAt: Date | null;
  /** What the claim paid, once PAID. */
  paidKs: number | null;
  rejectReason: ClaimRejectReasonWire | null;
  rejectNote: string | null;
  /** Until when the prize may still be requested; null until the publish finished. */
  claimDeadlineAt: Date | null;
  tickets: DrawClaimTicketView[];
}

/** One of the caller's claims as GET /lottery/claims lists them. */
export interface MyClaimView {
  claimId: string;
  drawNo: number;
  thaiDrawDate: string;
  status: ClaimStatusWire;
  ks: number;
  ticketsCount: number;
  requestedAt: Date;
  decidedAt: Date | null;
}

export interface MyClaimPage {
  items: MyClaimView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The customer side of prize claims (2026-10-24): what they won in a draw
 * and where its claim stands, their list of claims, and "Request payment"
 * — ONE claim per customer per draw bundling every winning ticket they
 * hold in it. The request runs under the draw's row lock (the same one a
 * checkout and a publish take), so two taps, or a tap racing the last
 * publish chunk, never make two claims or leave a prize behind. No money
 * moves here: a staff member confirms the claim on the admin page.
 */
@Injectable()
export class LotteryClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /lottery/claims/draws/:drawNo — 404 LOTTERY_DRAW_NOT_FOUND for an unknown draw. */
  async drawView(
    userId: string,
    drawNo: number,
    now = new Date(),
  ): Promise<DrawClaimView> {
    const draw = await this.findDrawByNo(drawNo);
    return this.viewFor(userId, draw, now);
  }

  /** GET /lottery/claims — the caller's claims, newest request first. */
  async listMine(
    userId: string,
    query: MyClaimsQueryDto,
  ): Promise<MyClaimPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryClaimWhereInput = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.lotteryClaim.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: MY_CLAIM_INCLUDE,
      }),
      this.prisma.lotteryClaim.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.myClaimView(row)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * POST /lottery/claims { drawNo } — in one transaction under the draw's
   * row lock, the checks in the contract's order: the draw is PUBLISHED
   * and its publish finished (409 LOTTERY_DRAW_STATE) → no claim of mine
   * yet (REQUESTED / PAID → 409 CLAIM_ALREADY_REQUESTED, REJECTED → 409
   * CLAIM_REJECTED) → the claim deadline is still ahead (409
   * CLAIM_EXPIRED) → I hold UNCLAIMED prizes in it (else 409
   * CLAIM_NOTHING_TO_CLAIM). Then one REQUESTED claim with the sums and
   * the draw's rate, and those payouts REQUESTED under it. A repeat tap
   * after success answers CLAIM_ALREADY_REQUESTED (the app refetches).
   */
  async request(
    user: AuthenticatedUser,
    dto: RequestClaimDto,
    now = new Date(),
  ): Promise<DrawClaimView> {
    const draw = await this.findDrawByNo(dto.drawNo);
    try {
      await this.prisma.$transaction(
        (tx) => this.createClaim(tx, user.id, draw.id, now),
        {
          maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
          timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // Belt and braces under the lock: the unique (draw, user) says the
      // other tap won — answer as if we had seen its claim.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.alreadyRequested(LotteryClaimStatus.REQUESTED);
      }
      throw error;
    }
    return this.viewFor(user.id, draw, now);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async createClaim(
    tx: Prisma.TransactionClient,
    userId: string,
    drawId: string,
    now: Date,
  ): Promise<void> {
    await this.lockRow(tx, drawId);
    const draw = await tx.lotteryDraw.findUniqueOrThrow({
      where: { id: drawId },
    });
    if (draw.status !== LotteryDrawStatus.PUBLISHED) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.DRAW_STATE,
        'The results of this draw are not published yet',
        { status: drawStatusToWire(draw.status) },
      );
    }
    // Until the finish wrote the counters a chunk may still be awarding
    // prizes — a claim made now could miss one of this customer's tickets.
    if (draw.winnersCount === null) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.DRAW_STATE,
        'The results of this draw are still being published — try again in a moment',
        { status: drawStatusToWire(draw.status) },
      );
    }
    const existing = await tx.lotteryClaim.findUnique({
      where: { drawId_userId: { drawId, userId } },
    });
    if (existing) {
      if (existing.status === LotteryClaimStatus.REJECTED) {
        throw lotteryError(
          HttpStatus.CONFLICT,
          LOTTERY_ERRORS.CLAIM_REJECTED,
          'Your request for this draw was rejected — contact support',
          { claimId: existing.id },
        );
      }
      throw this.alreadyRequested(existing.status, existing.id);
    }
    if (
      draw.claimDeadlineAt !== null &&
      draw.claimDeadlineAt.getTime() <= now.getTime()
    ) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.CLAIM_EXPIRED,
        'The claim deadline for this draw has passed',
        { claimDeadlineAt: draw.claimDeadlineAt.toISOString() },
      );
    }
    const payouts = await tx.lotteryPayout.findMany({
      where: { drawId, userId, status: LotteryPayoutStatus.UNCLAIMED },
      select: { id: true, baht: true, ks: true, rate: true },
    });
    if (payouts.length === 0) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.CLAIM_NOTHING_TO_CLAIM,
        'You have no prize to request in this draw',
      );
    }
    const baht = payouts.reduce(
      (sum, payout) => sum.add(payout.baht),
      new Prisma.Decimal(0),
    );
    const ks = payouts.reduce(
      (sum, payout) => sum.add(payout.ks),
      new Prisma.Decimal(0),
    );
    const claim = await tx.lotteryClaim.create({
      data: {
        drawId,
        userId,
        status: LotteryClaimStatus.REQUESTED,
        ticketsCount: payouts.length,
        baht,
        ks,
        rate: draw.exchangeRate ?? payouts[0].rate,
        requestedAt: now,
      },
    });
    const linked = await tx.lotteryPayout.updateMany({
      where: {
        id: { in: payouts.map((payout) => payout.id) },
        status: LotteryPayoutStatus.UNCLAIMED,
      },
      data: { status: LotteryPayoutStatus.REQUESTED, claimId: claim.id },
    });
    // The draw's lock keeps a publish and other requests out, but not the
    // expiry sweep (it takes no lock): a payout it flipped between our read
    // and this write is skipped by the UPDATE's re-check. A claim whose
    // ticketsCount names prizes it does not hold could never be confirmed,
    // so roll the whole request back and let the app re-read the truth.
    if (linked.count !== payouts.length) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.CLAIM_NOTHING_TO_CLAIM,
        'Your prizes changed while requesting — please try again',
      );
    }
  }

  private async viewFor(
    userId: string,
    draw: LotteryDraw,
    now: Date,
  ): Promise<DrawClaimView> {
    const [payouts, claim] = await Promise.all([
      this.prisma.lotteryPayout.findMany({
        where: { drawId: draw.id, userId },
        orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
        include: PAYOUT_INCLUDE,
      }),
      this.prisma.lotteryClaim.findUnique({
        where: { drawId_userId: { drawId: draw.id, userId } },
      }),
    ]);
    const prizeKs = payouts.reduce(
      (sum, payout) => sum.add(payout.ks),
      new Prisma.Decimal(0),
    );
    return {
      drawNo: draw.drawNo,
      thaiDrawDate: toDateString(draw.thaiDrawDate),
      drawStatus: drawStatusToWire(draw.status),
      wonTickets: payouts.length,
      prizeKs: prizeKs.toNumber(),
      status: this.statusOf(payouts, claim, draw, now),
      claimId: claim?.id ?? null,
      requestedAt: claim?.requestedAt ?? null,
      decidedAt: claim?.decidedAt ?? null,
      paidKs:
        claim && claim.status === LotteryClaimStatus.PAID
          ? claim.ks.toNumber()
          : null,
      rejectReason: rejectReasonToWire(claim?.rejectReason ?? null),
      rejectNote: claim?.rejectNote ?? null,
      claimDeadlineAt: draw.claimDeadlineAt,
      tickets: payouts.map((payout) => ({
        ticketNo: payout.ticket.ticketNo,
        number: payout.ticket.number,
        ks: payout.ks.toNumber(),
        wonGroups: parseStoredPayoutGroups(payout.groups).map(
          ({ key, name, ks }) => ({ key, name, ks }),
        ),
      })),
    };
  }

  /**
   * No winning ticket → none; a claim → its status; the deadline passed
   * with no claim → expired (the same instant `request` starts refusing
   * with CLAIM_EXPIRED, not the hourly sweep that flips the rows later);
   * every prize EXPIRED → expired; else not_requested.
   */
  private statusOf(
    payouts: readonly StoredPayout[],
    claim: { status: LotteryClaimStatus } | null,
    draw: Pick<LotteryDraw, 'claimDeadlineAt'>,
    now: Date,
  ): DrawClaimStatusWire {
    if (payouts.length === 0) return 'none';
    if (claim) return claimStatusToWire(claim.status);
    if (
      draw.claimDeadlineAt !== null &&
      draw.claimDeadlineAt.getTime() <= now.getTime() &&
      payouts.some(
        (p) =>
          p.status === LotteryPayoutStatus.UNCLAIMED ||
          p.status === LotteryPayoutStatus.EXPIRED,
      )
    ) {
      return 'expired';
    }
    if (payouts.every((p) => p.status === LotteryPayoutStatus.EXPIRED)) {
      return 'expired';
    }
    return 'not_requested';
  }

  private myClaimView(row: StoredMyClaim): MyClaimView {
    return {
      claimId: row.id,
      drawNo: row.draw.drawNo,
      thaiDrawDate: toDateString(row.draw.thaiDrawDate),
      status: claimStatusToWire(row.status),
      ks: row.ks.toNumber(),
      ticketsCount: row.ticketsCount,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
    };
  }

  private alreadyRequested(status: LotteryClaimStatus, claimId?: string) {
    return lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.CLAIM_ALREADY_REQUESTED,
      status === LotteryClaimStatus.PAID
        ? 'This prize was already paid into your wallet'
        : 'You already requested this payment — it is waiting for confirmation',
      { status: claimStatusToWire(status), ...(claimId ? { claimId } : {}) },
    );
  }

  private async findDrawByNo(drawNo: number): Promise<LotteryDraw> {
    const row = await this.prisma.lotteryDraw.findUnique({
      where: { drawNo },
    });
    if (!row) throw drawNotFound();
    return row;
  }

  /** The draw's row lock — the same statement a checkout and a publish take. */
  private async lockRow(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "lottery_draws" WHERE "id" = ${id} FOR UPDATE`;
  }
}
