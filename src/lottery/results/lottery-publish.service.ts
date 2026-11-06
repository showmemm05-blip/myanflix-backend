import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryPayoutStatus,
  LotteryResultStatus,
  LotteryTicketStatus,
  Prisma,
  type LotteryDraw,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lotteryDrawSnapshot } from '../../audit/audit-snapshots';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PrismaService } from '../../prisma/prisma.service';
import { DAY_MS } from '../analytics/lottery-analytics-period';
import {
  payoutClaimStatus,
  type PrizeClaimStatusWire,
} from '../claims/claim-status';
import { DRAW_PAGE_SIZE_DEFAULT } from '../dto/lottery-draw.dto';
import type {
  AdminWinnersQueryDto,
  PublishDrawDto,
} from '../dto/lottery-publish.dto';
import {
  drawLabel,
  LotteryDrawsAdminService,
  type AdminDrawView,
} from '../lottery-draws-admin.service';
import { drawStatusToWire } from '../lottery-draws.service';
import { drawNotFound, LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { LotterySettingsService } from '../lottery-settings.service';
import {
  LotteryResultsService,
  resultSourceToWire,
} from './lottery-results.service';
import {
  parseStoredPayoutGroups,
  payoutGroupsJson,
  winnerGroupsOf,
  type WinnerGroup,
} from './payout-groups';
import {
  isCompletePrizeSheet,
  PRIZE_GROUP_KEYS,
  type PrizeGroup,
  type PrizeGroupKey,
} from './prize-groups';
import { ticketPrize, winsWithKs, type TicketPrize } from './prize-matcher';

/**
 * Tickets settled per transaction. One chunk is one commit, so a failure
 * part-way costs at most this many tickets' worth of work, and the
 * draw's row lock is never held for longer than one chunk.
 */
export const PUBLISH_CHUNK_SIZE = 100;
/** A chunk queues on the draw's row lock behind the previous one (or a second staff member's run). */
export const PUBLISH_TRANSACTION_MAX_WAIT_MS = 5_000;
/**
 * Up to 100 winners, each a ticket and a payout write (no money moves at
 * publish since 2026-10-24); the claim confirm — one wallet, one
 * transaction, the payouts, the claim, the draw — runs on the same budget.
 */
export const PUBLISH_TRANSACTION_TIMEOUT_MS = 30_000;
/**
 * The Decimal(12,2) ceiling of every Ks column a prize touches
 * (lottery_payouts.ks, lottery_tickets.prizeKs, transactions.amount,
 * wallets.balance, lottery_draws.prizesPaidKs). A prize past it would
 * fail its chunk with a numeric overflow on every retry, after the draw
 * was flipped and the sheet locked — so publish refuses before the flip.
 */
export const KS_MAX = new Prisma.Decimal('9999999999.99');

/** The customer columns the admin winners list shows (the same as the ticket list). */
const WINNER_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/** A payout as stored, with the ticket, the customer and the claim (if requested) the admin row shows. */
const WINNER_INCLUDE = {
  ticket: { select: { ticketNo: true, number: true } },
  user: { select: WINNER_USER_SELECT },
  claim: {
    select: {
      id: true,
      status: true,
      decidedAt: true,
      paidAtPublish: true,
      transactionId: true,
    },
  },
} satisfies Prisma.LotteryPayoutInclude;

type StoredWinner = Prisma.LotteryPayoutGetPayload<{
  include: typeof WINNER_INCLUDE;
}>;

/** What "Publish results" would award, counted without writing (the admin reads it as "prizes owed"). */
export interface PublishPreview {
  /** Ks per Baht the figures use. */
  rate: number;
  /** Winning tickets. */
  winners: number;
  /** Tickets checked. */
  tickets: number;
  prizesBaht: number;
  prizesKs: number;
  /** Every group in the fixed order; `winners` counts the wins in that group. */
  byGroup: Array<{ key: PrizeGroupKey; winners: number; ks: number }>;
}

/** The preview plus the biggest single prize — what the overflow check needs and the wire does not carry. */
export interface PublishTally extends PublishPreview {
  maxTicketKs: number;
}

/** One winning ticket as the admin "Winners" table reads it. */
export interface AdminWinnerView {
  ticketNo: string;
  number: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    phone: string | null;
    email: string | null;
  };
  groups: WinnerGroup[];
  baht: number;
  ks: number;
  /** Where the prize is in the claim flow (2026-10-24). */
  claimStatus: PrizeClaimStatusWire;
  /** The claim it was requested under, once the customer asked. */
  claimId: string | null;
  /**
   * When the prize was paid: the claim's decision time, or — for a draw
   * paid at publish before 2026-10-24 — the payout's own time. Null until paid.
   */
  paidAt: Date | null;
  /** The LOTTERY_PRIZE row: the payout's own (paid at publish) else the claim's. */
  transactionId: string | null;
}

export interface AdminWinnerPage {
  items: AdminWinnerView[];
  total: number;
  page: number;
  pageSize: number;
}

/** The draw as the status flip left it, plus what the chunks need. */
interface PublishStart {
  /** The draw before this call touched it (the audit row's `before`). */
  before: LotteryDraw;
  draw: LotteryDraw;
  sheet: PrizeGroup[];
  rate: Prisma.Decimal;
  source: 'api' | 'manual' | null;
  /** True when the draw was PUBLISHED already and tickets were still waiting. */
  resumed: boolean;
}

/** What one committed chunk did. */
interface ChunkResult {
  /** Tickets marked WON or NOT_WON. */
  settled: number;
  /** Tickets awarded a prize (WON). */
  awarded: number;
  ks: Prisma.Decimal;
}

/** The running totals of one publish call. */
interface PublishRun {
  settled: number;
  awarded: number;
  ks: Prisma.Decimal;
}

/**
 * "Publish results" (lottery backend phase 3; "Publish and pay winners"
 * until 2026-10-24): the dry run, the publish itself and the admin's
 * winners list. A publish flips a CLOSED draw with a full FETCHED sheet to
 * PUBLISHED under its row lock (so two staff members cannot both start
 * it), then settles the tickets in chunks of PUBLISH_CHUNK_SIZE — each
 * chunk one transaction under the same lock: every ticket WON (its prize
 * and an UNCLAIMED payout row) or NOT_WON. NO money moves here: the
 * customer requests payment in the app and a staff member confirms the
 * claim (claims/). A chunk that fails rolls back alone and the call
 * answers LOTTERY_PUBLISH_INCOMPLETE; the next call on the PUBLISHED draw
 * takes up the tickets still WAITING, and the unique payout per ticket
 * means no ticket is ever awarded twice. The draw's counters (winners,
 * the prize total, prizes paid = 0, the claim deadline) and the one audit
 * row are written when the last chunk is in.
 */
@Injectable()
export class LotteryPublishService {
  private readonly logger = new Logger(LotteryPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: LotterySettingsService,
    private readonly results: LotteryResultsService,
    private readonly adminDraws: LotteryDrawsAdminService,
  ) {}

  /**
   * GET /lottery/admin/draws/:id/publish-preview — the same matcher over
   * every ticket of the draw, nothing written. Priced at the asked rate,
   * else the draw's own (once published), else the settings'. 409
   * LOTTERY_RESULTS_NOT_READY without a full sheet.
   */
  async preview(
    drawId: string,
    exchangeRate?: number,
  ): Promise<PublishPreview> {
    const draw = await this.findDraw(drawId);
    const row = await this.results.getOrCreateRow(drawId);
    const sheet = this.results.sheetOf(row);
    if (!isFullSheet(sheet)) throw this.notReady();
    const rate =
      exchangeRate !== undefined
        ? new Prisma.Decimal(exchangeRate)
        : (draw.exchangeRate ??
          (await this.settings.getOrCreate()).exchangeRate);
    const tickets = await this.prisma.lotteryTicket.findMany({
      where: { drawId },
      select: { number: true },
    });
    return previewOf(this.fits(tally(tickets, sheet, rate)));
  }

  /**
   * POST /lottery/admin/draws/:id/publish { exchangeRate? } — refused
   * unless the draw is CLOSED (409 LOTTERY_DRAW_STATE: the staff member
   * closes it first) with a FETCHED full sheet (409
   * LOTTERY_RESULTS_NOT_READY). The rate is the body's, else the
   * settings'; a resumed publish keeps the rate the draw was published
   * at. The claim deadline is the settings' claimDeadlineDays from now
   * (copied like ticketPrice). Answers the admin draw once every ticket is
   * settled.
   */
  async publish(
    drawId: string,
    dto: PublishDrawDto,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<AdminDrawView> {
    const found = await this.findDraw(drawId);
    const settings = await this.settings.getOrCreate();
    const askedRate =
      dto.exchangeRate === undefined
        ? settings.exchangeRate
        : new Prisma.Decimal(dto.exchangeRate);
    // The same budget as a chunk: the flip queues on the draw's row lock
    // behind a chunk of another run (up to a chunk's timeout), and Prisma's
    // default 5 s would expire mid-wait as a bare P2028.
    const start = await this.prisma.$transaction(
      (tx) => this.start(tx, found.id, actor, askedRate, now),
      {
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      },
    );

    const run: PublishRun = {
      settled: 0,
      awarded: 0,
      ks: new Prisma.Decimal(0),
    };
    for (;;) {
      let chunk: ChunkResult;
      try {
        chunk = await this.prisma.$transaction(
          (tx) => this.settleChunk(tx, start.draw, start.sheet, start.rate),
          {
            maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
            timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        throw await this.incomplete(start.draw, run, error);
      }
      if (chunk.settled === 0) break;
      run.settled += chunk.settled;
      run.awarded += chunk.awarded;
      run.ks = run.ks.add(chunk.ks);
    }

    await this.finish(start, actor, run, settings.claimDeadlineDays, now);
    return this.adminDraws.findOne(drawId);
  }

  /**
   * GET /lottery/admin/draws/:id/winners — the winning tickets of a draw,
   * biggest prize first then by ticket number, each with where its prize
   * is in the claim flow. `q` finds a ticket number, the start of a
   * lottery number, or the customer by username, display name or phone.
   * Empty (not an error) before publish.
   */
  async listWinners(
    drawId: string,
    query: AdminWinnersQueryDto,
  ): Promise<AdminWinnerPage> {
    await this.findDraw(drawId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryPayoutWhereInput = {
      drawId,
      ...(query.q ? winnerSearchWhere(query.q) : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.lotteryPayout.findMany({
        where,
        orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: WINNER_INCLUDE,
      }),
      this.prisma.lotteryPayout.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.winnerView(row)),
      total,
      page,
      pageSize,
    };
  }

  winnerView(row: StoredWinner): AdminWinnerView {
    return {
      ticketNo: row.ticket.ticketNo,
      number: row.ticket.number,
      user: row.user,
      groups: winnerGroupsOf(parseStoredPayoutGroups(row.groups)),
      baht: row.baht.toNumber(),
      ks: row.ks.toNumber(),
      claimStatus: payoutClaimStatus(row.status),
      claimId: row.claim?.id ?? null,
      paidAt: winnerPaidAt(row),
      transactionId: row.transactionId ?? row.claim?.transactionId ?? null,
    };
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * The status flip, under the draw's row lock: everything is checked
   * against the row as it is now, and a second publish of the same draw
   * waits here and then sees PUBLISHED. A PUBLISHED draw with tickets
   * still WAITING is a publish that stopped part-way, and resumes at the
   * rate it was published with; so is one whose every ticket is settled
   * but whose counters were never written (the finish failed after the
   * last chunk — the resume settles nothing and writes them). One with
   * its counters in is done (409 LOTTERY_DRAW_STATE).
   */
  private async start(
    tx: Prisma.TransactionClient,
    id: string,
    actor: AuthenticatedUser,
    askedRate: Prisma.Decimal,
    now: Date,
  ): Promise<PublishStart> {
    await this.lockRow(tx, id);
    const draw = await tx.lotteryDraw.findUniqueOrThrow({ where: { id } });
    const row = await this.results.getOrCreateRow(id, tx);
    const sheet = this.results.sheetOf(row);
    const source = resultSourceToWire(row.source);

    if (draw.status === LotteryDrawStatus.PUBLISHED) {
      const waiting = await tx.lotteryTicket.count({
        where: { drawId: id, status: LotteryTicketStatus.WAITING },
      });
      const settled = waiting === 0 && draw.winnersCount !== null;
      if (settled || draw.exchangeRate === null) {
        throw lotteryError(
          HttpStatus.CONFLICT,
          LOTTERY_ERRORS.DRAW_STATE,
          'This draw is published and every ticket is settled',
          { status: drawStatusToWire(draw.status) },
        );
      }
      // The sheet the earlier chunks awarded from is the PUBLISHED row's;
      // a row in any other state was changed after the flip and must not
      // settle the rest.
      if (row.status !== LotteryResultStatus.PUBLISHED) {
        throw lotteryError(
          HttpStatus.CONFLICT,
          LOTTERY_ERRORS.RESULTS_NOT_READY,
          'The results of this published draw were changed after publishing — contact support before settling the rest',
        );
      }
      if (!isFullSheet(sheet)) throw this.notReady();
      return {
        before: draw,
        draw,
        sheet,
        rate: draw.exchangeRate,
        source,
        resumed: true,
      };
    }
    if (draw.status !== LotteryDrawStatus.CLOSED) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.DRAW_STATE,
        'Only a closed draw can be published — close sales first',
        { status: drawStatusToWire(draw.status) },
      );
    }
    if (row.status !== LotteryResultStatus.FETCHED || !isFullSheet(sheet)) {
      throw this.notReady();
    }
    // Before the flip, while the sheet and the rate can still change: no
    // single prize, and no draw total, may be more than a Ks column holds.
    const tickets = await tx.lotteryTicket.findMany({
      where: { drawId: id },
      select: { number: true },
    });
    this.fits(tally(tickets, sheet, askedRate));

    const after = await tx.lotteryDraw.update({
      where: { id },
      data: {
        status: LotteryDrawStatus.PUBLISHED,
        publishedAt: now,
        publishedByUserId: actor.id,
        exchangeRate: askedRate,
      },
    });
    await tx.lotteryResult.update({
      where: { id: row.id },
      data: { status: LotteryResultStatus.PUBLISHED },
    });
    return {
      before: draw,
      draw: after,
      sheet,
      rate: askedRate,
      source,
      resumed: false,
    };
  }

  /**
   * One chunk: the next PUBLISH_CHUNK_SIZE tickets still WAITING, read
   * under the draw's row lock so two runs of the same draw (a retry
   * racing a slow first run, or two staff members) take turns and never
   * the same tickets. Winners are awarded one by one; the rest are marked
   * NOT_WON in one statement. An empty chunk means the draw is settled.
   */
  private async settleChunk(
    tx: Prisma.TransactionClient,
    draw: LotteryDraw,
    sheet: readonly PrizeGroup[],
    rate: Prisma.Decimal,
  ): Promise<ChunkResult> {
    await this.lockRow(tx, draw.id);
    const tickets = await tx.lotteryTicket.findMany({
      where: { drawId: draw.id, status: LotteryTicketStatus.WAITING },
      orderBy: { seq: 'asc' },
      take: PUBLISH_CHUNK_SIZE,
      select: { id: true, ticketNo: true, userId: true, number: true },
    });
    const result: ChunkResult = {
      settled: tickets.length,
      awarded: 0,
      ks: new Prisma.Decimal(0),
    };
    const notWon: string[] = [];
    for (const ticket of tickets) {
      const prize = ticketPrize(ticket.number, sheet, rate);
      if (prize.wins.length === 0) {
        notWon.push(ticket.id);
        continue;
      }
      await this.award(tx, draw, ticket, prize, rate, result);
    }
    if (notWon.length > 0) {
      await tx.lotteryTicket.updateMany({
        where: { id: { in: notWon } },
        data: { status: LotteryTicketStatus.NOT_WON },
      });
    }
    return result;
  }

  /**
   * One winning ticket: WON with its prize, and one UNCLAIMED payout row
   * (ticketId unique — the guard against awarding twice). Nothing is
   * credited and no transaction row is written: the money moves when a
   * staff member confirms the customer's claim (LotteryClaimsAdminService).
   * A prize of 0 Ks (a group whose Baht prize is 0) is awarded the same
   * way; its claim will confirm without a credit.
   */
  private async award(
    tx: Prisma.TransactionClient,
    draw: LotteryDraw,
    ticket: { id: string; ticketNo: string; userId: string; number: string },
    prize: TicketPrize,
    rate: Prisma.Decimal,
    result: ChunkResult,
  ): Promise<void> {
    await tx.lotteryTicket.update({
      where: { id: ticket.id },
      data: { status: LotteryTicketStatus.WON, prizeKs: prize.ks },
    });
    await tx.lotteryPayout.create({
      data: {
        drawId: draw.id,
        ticketId: ticket.id,
        userId: ticket.userId,
        groups: payoutGroupsJson(winsWithKs(prize.wins, rate)),
        baht: prize.baht,
        ks: prize.ks,
        rate,
        transactionId: null,
        claimId: null,
        status: LotteryPayoutStatus.UNCLAIMED,
      },
    });
    result.awarded += 1;
    result.ks = result.ks.add(prize.ks);
  }

  /**
   * The last step once no ticket is WAITING: the draw's counters from
   * the payouts (every run's, not just this one's — a resume counts the
   * earlier chunks too): the winners, the prize total AWARDED, prizes
   * paid = what the PAID rows sum to (0 for a fresh publish; every
   * confirmed claim adds to it), the claim deadline
   * (`claimDeadlineDays` from now) — and the one lottery_draw.publish
   * audit row. Two runs that shared a draw's chunks (a retry racing the
   * first call, or two staff members) both get here: under the draw's
   * row lock the first to write the counters writes the audit row, and
   * the other finds them in and writes nothing.
   */
  private async finish(
    start: PublishStart,
    actor: AuthenticatedUser,
    run: PublishRun,
    claimDeadlineDays: number,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockRow(tx, start.draw.id);
      const totals = await tx.lotteryPayout.aggregate({
        where: { drawId: start.draw.id },
        _count: true,
        _sum: { ks: true },
      });
      const winnersCount = totals._count;
      const prizeTotalKs = totals._sum.ks ?? new Prisma.Decimal(0);
      // What is already paid comes from the rows too, not a constant: a
      // fresh publish has none (every payout is UNCLAIMED, so 0), but a
      // publish that stopped part-way before 2026-10-24 paid its earlier
      // chunks at publish time, and a resume must not record those as 0.
      const paid = await tx.lotteryPayout.aggregate({
        where: { drawId: start.draw.id, status: LotteryPayoutStatus.PAID },
        _sum: { ks: true },
      });
      const prizesPaidKs = paid._sum.ks ?? new Prisma.Decimal(0);
      const claimDeadlineAt = new Date(
        now.getTime() + claimDeadlineDays * DAY_MS,
      );
      const written = await tx.lotteryDraw.updateMany({
        where: { id: start.draw.id, winnersCount: null },
        data: { winnersCount, prizeTotalKs, prizesPaidKs, claimDeadlineAt },
      });
      if (written.count === 0) return;
      const after = await tx.lotteryDraw.findUniqueOrThrow({
        where: { id: start.draw.id },
      });
      await this.audit.record({
        action: 'lottery_draw.publish',
        actor,
        target: {
          type: 'lottery_draw',
          id: after.id,
          label: drawLabel(after),
        },
        before: lotteryDrawSnapshot(start.before),
        after: lotteryDrawSnapshot(after),
        metadata: {
          winners: winnersCount,
          prizeTotalKs: prizeTotalKs.toNumber(),
          prizesPaidKs: prizesPaidKs.toNumber(),
          claimDeadlineAt: claimDeadlineAt.toISOString(),
          rate: start.rate.toNumber(),
          source: start.source,
          resumed: start.resumed,
          tickets: run.settled,
        },
        tx,
      });
    });
  }

  /**
   * A chunk failed: it rolled back alone, the earlier ones stand. Logged
   * with what this call managed, and answered as a 500 the admin can act
   * on — publishing again resumes with the tickets still WAITING.
   */
  private async incomplete(
    draw: LotteryDraw,
    run: PublishRun,
    error: unknown,
  ): Promise<Error> {
    this.logger.error(
      `Publish of ${drawLabel(draw)} stopped after ${run.settled} tickets (${run.awarded} awarded): ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    const remaining = await this.prisma.lotteryTicket.count({
      where: { drawId: draw.id, status: LotteryTicketStatus.WAITING },
    });
    return lotteryError(
      HttpStatus.INTERNAL_SERVER_ERROR,
      LOTTERY_ERRORS.PUBLISH_INCOMPLETE,
      'Some tickets could not be settled — publish again to finish awarding the prizes',
      { details: { awarded: run.awarded, settled: run.settled, remaining } },
    );
  }

  private async findDraw(id: string): Promise<LotteryDraw> {
    const row = await this.prisma.lotteryDraw.findUnique({ where: { id } });
    if (!row) throw drawNotFound();
    return row;
  }

  /** The draw's row lock — the same statement a checkout takes (lottery-purchases.service.ts). */
  private async lockRow(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "lottery_draws" WHERE "id" = ${id} FOR UPDATE`;
  }

  private notReady() {
    return lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.RESULTS_NOT_READY,
      'The results are not in yet — fetch them or enter them by hand first',
    );
  }

  /**
   * The figures as counted, unless a single prize or the draw's total is
   * past KS_MAX: then 409 LOTTERY_RESULTS_NOT_READY with the figures, so
   * the staff member checks the sheet and the rate (a one-digit typo in
   * the rate is the likely cause) before anything is flipped.
   */
  private fits(totals: PublishTally): PublishTally {
    if (
      new Prisma.Decimal(totals.maxTicketKs).gt(KS_MAX) ||
      new Prisma.Decimal(totals.prizesKs).gt(KS_MAX)
    ) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.RESULTS_NOT_READY,
        'A prize at this rate is larger than a wallet can hold — check the sheet and the exchange rate',
        {
          details: {
            maxTicketKs: totals.maxTicketKs,
            prizesKs: totals.prizesKs,
            ksMax: KS_MAX.toNumber(),
          },
        },
      );
    }
    return totals;
  }
}

/**
 * When a winner row's prize was paid: never before the payout is PAID; a
 * claim-paid prize at the claim's decision; a prize paid at publish (a
 * draw from before 2026-10-24 — its backfilled claim says paidAtPublish,
 * or it has none) at the payout's own time.
 */
function winnerPaidAt(row: StoredWinner): Date | null {
  if (row.status !== LotteryPayoutStatus.PAID) return null;
  if (!row.claim || row.claim.paidAtPublish) return row.createdAt;
  return row.claim.decidedAt ?? row.createdAt;
}

/** The tally without `maxTicketKs` — the admin's LotteryPublishPreview exactly. */
function previewOf(totals: PublishTally): PublishPreview {
  const { rate, winners, tickets, prizesBaht, prizesKs, byGroup } = totals;
  return { rate, winners, tickets, prizesBaht, prizesKs, byGroup };
}

/** A sheet publish can pay from: every group in, every check passed. */
function isFullSheet(sheet: readonly PrizeGroup[]): boolean {
  return sheet.length > 0 && isCompletePrizeSheet(sheet);
}

/**
 * The preview's figures over a list of ticket numbers. `prizesKs` adds up
 * each ticket's prize — exactly what the payouts would hold — so the
 * preview and the publish agree to the satang; `maxTicketKs` is the
 * biggest single prize, for the overflow check.
 */
export function tally(
  tickets: ReadonlyArray<{ number: string }>,
  sheet: readonly PrizeGroup[],
  rate: Prisma.Decimal,
): PublishTally {
  const byGroup = new Map<
    PrizeGroupKey,
    { winners: number; ks: Prisma.Decimal }
  >(
    PRIZE_GROUP_KEYS.map((key) => [
      key,
      { winners: 0, ks: new Prisma.Decimal(0) },
    ]),
  );
  let winners = 0;
  let prizesBaht = 0;
  let prizesKs = new Prisma.Decimal(0);
  let maxTicketKs = new Prisma.Decimal(0);
  for (const ticket of tickets) {
    const prize = ticketPrize(ticket.number, sheet, rate);
    if (prize.wins.length === 0) continue;
    winners += 1;
    prizesBaht += prize.baht;
    prizesKs = prizesKs.add(prize.ks);
    if (prize.ks.gt(maxTicketKs)) maxTicketKs = prize.ks;
    for (const win of winsWithKs(prize.wins, rate)) {
      const group = byGroup.get(win.key);
      if (!group) continue;
      group.winners += 1;
      group.ks = group.ks.add(win.ks);
    }
  }
  return {
    rate: rate.toNumber(),
    winners,
    tickets: tickets.length,
    prizesBaht,
    prizesKs: prizesKs.toNumber(),
    maxTicketKs: maxTicketKs.toNumber(),
    byGroup: PRIZE_GROUP_KEYS.map((key) => {
      const group = byGroup.get(key);
      return {
        key,
        winners: group?.winners ?? 0,
        ks: group?.ks.toNumber() ?? 0,
      };
    }),
  };
}

/** The admin winners search: a ticket number, a number prefix, or the customer. */
export function winnerSearchWhere(q: string): Prisma.LotteryPayoutWhereInput {
  return {
    OR: [
      { ticket: { ticketNo: { contains: q, mode: 'insensitive' } } },
      { ticket: { number: { startsWith: q } } },
      {
        user: {
          OR: [
            { username: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
          ],
        },
      },
    ],
  };
}
