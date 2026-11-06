import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LotteryClaimStatus,
  LotteryPayoutStatus,
  Prisma,
  TransactionType,
  type LotteryClaim,
  type LotteryClaimRejectReason,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lotteryClaimSnapshot } from '../../audit/audit-snapshots';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { decimalToNumber } from '../../common/utils/decimal.util';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { WalletService } from '../../wallet/wallet.service';
import {
  addDays,
  DAY_MS,
  ksText,
  mmtDateOf,
  mmtDayStart,
} from '../analytics/lottery-analytics-period';
import {
  CLAIMS_PAGE_SIZE_DEFAULT,
  type AdminClaimsQueryDto,
  type RejectClaimDto,
} from '../dto/lottery-claim.dto';
import { drawLabel } from '../lottery-draws-admin.service';
import { LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { toDateString } from '../lottery-time';
import {
  PUBLISH_TRANSACTION_MAX_WAIT_MS,
  PUBLISH_TRANSACTION_TIMEOUT_MS,
} from '../results/lottery-publish.service';
import {
  parseStoredPayoutGroups,
  type PayoutGroup,
} from '../results/payout-groups';
import {
  claimStatusToWire,
  rejectReasonFromWire,
  rejectReasonToWire,
  type ClaimListStatusWire,
  type ClaimRejectReasonWire,
  type ClaimStatusWire,
} from './claim-status';

/** An account younger than this many days gets the "New account" badge on the review dialog. */
export const NEW_ACCOUNT_DAYS = 30;

/** The customer columns the admin rows show (the same as the winners list). */
const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/** The staff member who decided, as the row names them. */
const STAFF_SELECT = {
  id: true,
  username: true,
  displayName: true,
} satisfies Prisma.UserSelect;

/** A claim with everything the detail shows. */
const CLAIM_DETAIL_INCLUDE = {
  draw: {
    select: {
      id: true,
      drawNo: true,
      thaiDrawDate: true,
      exchangeRate: true,
      publishedAt: true,
      claimDeadlineAt: true,
    },
  },
  user: { select: { ...ADMIN_USER_SELECT, createdAt: true } },
  decidedBy: { select: STAFF_SELECT },
  payouts: {
    orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
    include: {
      ticket: { select: { ticketNo: true, number: true, createdAt: true } },
    },
  },
} satisfies Prisma.LotteryClaimInclude;

type StoredClaimDetail = Prisma.LotteryClaimGetPayload<{
  include: typeof CLAIM_DETAIL_INCLUDE;
}>;

/** A claim with the draw and the customer an audit label and a decision need. */
const CLAIM_DECIDE_INCLUDE = {
  draw: { select: { id: true, drawNo: true, thaiDrawDate: true } },
  user: { select: { username: true } },
} satisfies Prisma.LotteryClaimInclude;

type StoredClaimToDecide = Prisma.LotteryClaimGetPayload<{
  include: typeof CLAIM_DECIDE_INCLUDE;
}>;

export interface AdminClaimUser {
  id: string;
  username: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
}

export interface AdminStaffRef {
  id: string;
  username: string;
  displayName: string | null;
}

/** A row's status: a claim's, or "not_requested" for a synthesised row of UNCLAIMED prizes. */
export type AdminClaimRowStatus = ClaimStatusWire | 'not_requested';

/**
 * One row of the admin "Prize claims" table. A real claim has its id; a
 * "not requested" row is one customer's UNCLAIMED prizes in one draw,
 * synthesised from lottery_payouts (id null, key "<drawId>:<userId>").
 * Money is a two-place decimal string like the analytics wire.
 */
export interface AdminClaimRow {
  id: string | null;
  key: string;
  status: AdminClaimRowStatus;
  drawId: string;
  drawNo: number;
  /** "YYYY-MM-DD", the Thai calendar date. */
  thaiDrawDate: string;
  user: AdminClaimUser;
  ticketsCount: number;
  baht: string;
  ks: string;
  requestedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: AdminStaffRef | null;
  rejectReason: ClaimRejectReasonWire | null;
  rejectNote: string | null;
  /** True for the claims the migration backfilled over draws paid at publish. */
  paidAtPublish: boolean;
  transactionId: string | null;
}

export interface AdminClaimPage {
  items: AdminClaimRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** The four tiles of the admin page (plus the expired prizes, for the draw strip). */
export interface ClaimsSummary {
  waiting: { claims: number; ks: string };
  /** Confirmed on the current Myanmar calendar day. */
  paidToday: { claims: number; ks: string };
  notRequested: { customers: number; tickets: number; ks: string };
  rejected: { claims: number; ks: string };
  expired: { tickets: number; ks: string };
}

/** One ticket line of the review dialog. */
export interface AdminClaimTicket {
  ticketNo: string;
  number: string;
  groups: PayoutGroup[];
  baht: string;
  ks: string;
  boughtAt: Date;
}

/** The review dialog: the row plus the customer panel, the ticket lines and the draw. */
export interface AdminClaimDetail extends AdminClaimRow {
  customer: {
    memberSince: Date;
    walletBalance: string;
    earlierClaims: { paid: number; rejected: number };
    accountAgeDays: number;
    isNewAccount: boolean;
  };
  tickets: AdminClaimTicket[];
  draw: {
    id: string;
    drawNo: number;
    thaiDrawDate: string;
    exchangeRate: number | null;
    publishedAt: Date | null;
    claimDeadlineAt: Date | null;
  };
}

/** One row of the list query: claim columns, or the synthesised UNCLAIMED group. */
interface ListRow {
  id: string | null;
  key: string;
  status: 'REQUESTED' | 'PAID' | 'REJECTED' | 'UNCLAIMED';
  drawId: string;
  userId: string;
  ticketsCount: number;
  baht: string;
  ks: string;
  requestedAt: Date | null;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  rejectReason: string | null;
  rejectNote: string | null;
  paidAtPublish: boolean;
  transactionId: string | null;
  drawNo: number;
  thaiDrawDate: string | Date;
}

interface SummaryRow {
  waitingClaims: number;
  waitingKs: string;
  paidTodayClaims: number;
  paidTodayKs: string;
  notRequestedCustomers: number;
  notRequestedTickets: number;
  notRequestedKs: string;
  rejectedClaims: number;
  rejectedKs: string;
  expiredTickets: number;
  expiredKs: string;
}

/** What a confirm hands back out of its transaction, for the balance push after commit. */
interface ConfirmOutcome {
  userId: string;
  balance: Prisma.Decimal | null;
}

const CLAIM_STATUS_SQL: Record<ClaimStatusWire, Prisma.Sql> = {
  requested: Prisma.sql`'REQUESTED'::"LotteryClaimStatus"`,
  paid: Prisma.sql`'PAID'::"LotteryClaimStatus"`,
  rejected: Prisma.sql`'REJECTED'::"LotteryClaimStatus"`,
};
const PAYOUT_UNCLAIMED = Prisma.sql`'UNCLAIMED'::"LotteryPayoutStatus"`;
const PAYOUT_EXPIRED = Prisma.sql`'EXPIRED'::"LotteryPayoutStatus"`;

/** The list's ORDER BY per tab (the contract's sort rules). */
const LIST_ORDER: Record<ClaimListStatusWire, Prisma.Sql> = {
  requested: Prisma.sql`r."requestedAt" ASC, r."key" ASC`,
  paid: Prisma.sql`r."decidedAt" DESC NULLS LAST, r."requestedAt" DESC, r."key" ASC`,
  rejected: Prisma.sql`r."decidedAt" DESC NULLS LAST, r."requestedAt" DESC, r."key" ASC`,
  not_requested: Prisma.sql`r."at" DESC NULLS LAST, r."sortKs" DESC, r."key" ASC`,
  all: Prisma.sql`r."rank" ASC, CASE WHEN r."rank" = 0 THEN r."at" END ASC, r."at" DESC NULLS LAST, r."sortKs" DESC, r."key" ASC`,
};

/**
 * The staff side of prize claims (2026-10-24): the "Prize claims" page's
 * list, tiles and review dialog, and the three decisions. Confirm is the
 * ONLY place a prize's money moves: one transaction under the claim's row
 * lock, the total re-summed from the payouts and refused on any drift,
 * ONE wallet credit and ONE LOTTERY_PRIZE row for the whole claim, the
 * payouts and the claim PAID, the draw's prizesPaidKs added to, one audit
 * row — and the customer's balance pushed after commit. There is no
 * "pay all": every claim is confirmed one at a time.
 */
@Injectable()
export class LotteryClaimsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * GET /lottery/admin/claims — one tab. The claim tabs read
   * lottery_claims; "not requested" is one row per (draw, customer) over
   * the UNCLAIMED payouts, never a claim row; "all" is both, the waiting
   * claims first. One SQL per page plus one COUNT, then the customers and
   * deciders in one users query.
   */
  async list(query: AdminClaimsQueryDto): Promise<AdminClaimPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? CLAIMS_PAGE_SIZE_DEFAULT;
    const rowsSql = this.rowsSql(query);
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<ListRow[]>(Prisma.sql`/* lottery-claims:list */
        WITH rows AS (${rowsSql})
        SELECT r."id", r."key", r."status", r."drawId", r."userId", r."ticketsCount",
          r."baht", r."ks", r."requestedAt", r."decidedAt", r."decidedByUserId",
          r."rejectReason", r."rejectNote", r."paidAtPublish", r."transactionId",
          d."drawNo", d."thaiDrawDate"::text AS "thaiDrawDate"
        FROM rows r
        JOIN "lottery_draws" d ON d."id" = r."drawId"
        ORDER BY ${LIST_ORDER[query.status ?? 'requested']}
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`/* lottery-claims:count */
        WITH rows AS (${rowsSql})
        SELECT COUNT(*)::int AS "total" FROM rows r`,
      ),
    ]);
    const people = await this.peopleFor(rows);
    return {
      items: rows.map((row) => this.rowView(row, people)),
      total: Number(counted[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /**
   * GET /lottery/admin/claims/summary?drawId — the tiles in one query.
   * "Today" is the current Myanmar calendar day (UTC+6:30).
   */
  async summary(drawId?: string, now = new Date()): Promise<ClaimsSummary> {
    const today = mmtDateOf(now);
    const dayStart = mmtDayStart(today);
    const dayEnd = mmtDayStart(addDays(today, 1));
    const claimDraw = drawId
      ? Prisma.sql`AND c."drawId" = ${drawId}`
      : Prisma.empty;
    const payoutDraw = drawId
      ? Prisma.sql`AND p."drawId" = ${drawId}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<SummaryRow[]>(
      Prisma.sql`/* lottery-claims:summary */
      SELECT
        (SELECT COUNT(*)::int FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.requested} ${claimDraw}) AS "waitingClaims",
        (SELECT COALESCE(SUM(c."ks"), 0)::numeric(12,2)::text FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.requested} ${claimDraw}) AS "waitingKs",
        (SELECT COUNT(*)::int FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.paid} AND c."decidedAt" >= ${dayStart} AND c."decidedAt" < ${dayEnd} ${claimDraw}) AS "paidTodayClaims",
        (SELECT COALESCE(SUM(c."ks"), 0)::numeric(12,2)::text FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.paid} AND c."decidedAt" >= ${dayStart} AND c."decidedAt" < ${dayEnd} ${claimDraw}) AS "paidTodayKs",
        (SELECT COUNT(DISTINCT p."userId")::int FROM "lottery_payouts" p WHERE p."status" = ${PAYOUT_UNCLAIMED} ${payoutDraw}) AS "notRequestedCustomers",
        (SELECT COUNT(*)::int FROM "lottery_payouts" p WHERE p."status" = ${PAYOUT_UNCLAIMED} ${payoutDraw}) AS "notRequestedTickets",
        (SELECT COALESCE(SUM(p."ks"), 0)::numeric(12,2)::text FROM "lottery_payouts" p WHERE p."status" = ${PAYOUT_UNCLAIMED} ${payoutDraw}) AS "notRequestedKs",
        (SELECT COUNT(*)::int FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.rejected} ${claimDraw}) AS "rejectedClaims",
        (SELECT COALESCE(SUM(c."ks"), 0)::numeric(12,2)::text FROM "lottery_claims" c WHERE c."status" = ${CLAIM_STATUS_SQL.rejected} ${claimDraw}) AS "rejectedKs",
        (SELECT COUNT(*)::int FROM "lottery_payouts" p WHERE p."status" = ${PAYOUT_EXPIRED} ${payoutDraw}) AS "expiredTickets",
        (SELECT COALESCE(SUM(p."ks"), 0)::numeric(12,2)::text FROM "lottery_payouts" p WHERE p."status" = ${PAYOUT_EXPIRED} ${payoutDraw}) AS "expiredKs"`,
    );
    const row = rows[0];
    return {
      waiting: {
        claims: Number(row?.waitingClaims ?? 0),
        ks: ksText(row?.waitingKs),
      },
      paidToday: {
        claims: Number(row?.paidTodayClaims ?? 0),
        ks: ksText(row?.paidTodayKs),
      },
      notRequested: {
        customers: Number(row?.notRequestedCustomers ?? 0),
        tickets: Number(row?.notRequestedTickets ?? 0),
        ks: ksText(row?.notRequestedKs),
      },
      rejected: {
        claims: Number(row?.rejectedClaims ?? 0),
        ks: ksText(row?.rejectedKs),
      },
      expired: {
        tickets: Number(row?.expiredTickets ?? 0),
        ks: ksText(row?.expiredKs),
      },
    };
  }

  /** GET /lottery/admin/claims/:id — the review dialog. 404 LOTTERY_CLAIM_NOT_FOUND. */
  async detail(id: string, now = new Date()): Promise<AdminClaimDetail> {
    const claim = await this.prisma.lotteryClaim.findUnique({
      where: { id },
      include: CLAIM_DETAIL_INCLUDE,
    });
    if (!claim) throw this.notFound();
    const [wallet, paidBefore, rejectedBefore] = await Promise.all([
      this.prisma.wallet.findUnique({
        where: { userId: claim.userId },
        select: { balance: true },
      }),
      this.prisma.lotteryClaim.count({
        where: {
          userId: claim.userId,
          status: LotteryClaimStatus.PAID,
          id: { not: id },
        },
      }),
      this.prisma.lotteryClaim.count({
        where: {
          userId: claim.userId,
          status: LotteryClaimStatus.REJECTED,
          id: { not: id },
        },
      }),
    ]);
    const accountAgeDays = Math.max(
      0,
      Math.floor((now.getTime() - claim.user.createdAt.getTime()) / DAY_MS),
    );
    return {
      ...this.claimRowView(claim, claim.user, claim.decidedBy),
      customer: {
        memberSince: claim.user.createdAt,
        walletBalance: ksText(wallet?.balance),
        earlierClaims: { paid: paidBefore, rejected: rejectedBefore },
        accountAgeDays,
        isNewAccount: accountAgeDays < NEW_ACCOUNT_DAYS,
      },
      tickets: claim.payouts.map((payout) => ({
        ticketNo: payout.ticket.ticketNo,
        number: payout.ticket.number,
        groups: parseStoredPayoutGroups(payout.groups),
        baht: ksText(payout.baht),
        ks: ksText(payout.ks),
        boughtAt: payout.ticket.createdAt,
      })),
      draw: {
        id: claim.draw.id,
        drawNo: claim.draw.drawNo,
        thaiDrawDate: toDateString(claim.draw.thaiDrawDate),
        exchangeRate: decimalOrNull(claim.draw.exchangeRate),
        publishedAt: claim.draw.publishedAt,
        claimDeadlineAt: claim.draw.claimDeadlineAt,
      },
    };
  }

  /**
   * POST /lottery/admin/claims/:id/confirm — pays the claim ONCE. Under
   * the claim's row lock: REQUESTED only (409 LOTTERY_CLAIM_STATE); the
   * payouts still REQUESTED under it must be exactly ticketsCount rows
   * adding up to the claim's Ks (else 409 LOTTERY_CLAIM_TOTAL_MISMATCH and
   * nothing is paid); then, for a claim above 0 Ks, one wallet credit and
   * one COMPLETED LOTTERY_PRIZE transaction; the payouts PAID; the claim
   * PAID with the decision and the transaction; the draw's prizesPaidKs
   * added to; the audit row — all in that one transaction. The balance is
   * pushed to the customer after commit, like every balance change.
   */
  async confirm(
    id: string,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<AdminClaimDetail> {
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<ConfirmOutcome> => {
        const claim = await this.lockClaim(tx, id);
        this.requireStatus(claim, LotteryClaimStatus.REQUESTED);
        const totals = await tx.lotteryPayout.aggregate({
          where: { claimId: id, status: LotteryPayoutStatus.REQUESTED },
          _count: true,
          _sum: { ks: true },
        });
        const payoutsKs = totals._sum.ks ?? new Prisma.Decimal(0);
        if (
          totals._count !== claim.ticketsCount ||
          !payoutsKs.equals(claim.ks)
        ) {
          throw lotteryError(
            HttpStatus.CONFLICT,
            LOTTERY_ERRORS.CLAIM_TOTAL_MISMATCH,
            'The prizes under this claim no longer add up to it — nothing was paid; check the tickets before confirming',
            {
              details: {
                ticketsCount: claim.ticketsCount,
                payouts: totals._count,
                ks: claim.ks.toNumber(),
                payoutsKs: payoutsKs.toNumber(),
              },
            },
          );
        }

        let transactionId: string | null = null;
        let balance: Prisma.Decimal | null = null;
        if (claim.ks.gt(0)) {
          const wallet = await this.walletService.creditWithinTransaction(
            tx,
            claim.userId,
            claim.ks.toNumber(),
          );
          const transaction = await tx.transaction.create({
            data: {
              userId: claim.userId,
              type: TransactionType.LOTTERY_PRIZE,
              amount: claim.ks,
              status: 'COMPLETED',
            },
          });
          transactionId = transaction.id;
          balance = wallet.balance;
        }
        await tx.lotteryPayout.updateMany({
          where: { claimId: id, status: LotteryPayoutStatus.REQUESTED },
          data: { status: LotteryPayoutStatus.PAID },
        });
        const after = await tx.lotteryClaim.update({
          where: { id },
          data: {
            status: LotteryClaimStatus.PAID,
            decidedAt: now,
            decidedByUserId: actor.id,
            transactionId,
          },
        });
        // COALESCE: a draw published before the counters existed holds null.
        await tx.$executeRaw`UPDATE "lottery_draws" SET "prizesPaidKs" = COALESCE("prizesPaidKs", 0) + ${claim.ks.toFixed(2)}::numeric WHERE "id" = ${claim.drawId}`;
        await this.audit.record({
          action: 'lottery_claim.confirm',
          actor,
          target: { type: 'lottery_claim', id, label: claimLabel(claim) },
          before: lotteryClaimSnapshot(claim),
          after: lotteryClaimSnapshot(after),
          metadata: {
            drawNo: claim.draw.drawNo,
            ticketsCount: claim.ticketsCount,
            ks: claim.ks.toNumber(),
            transactionId,
          },
          tx,
        });
        return { userId: claim.userId, balance };
      },
      {
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      },
    );
    if (outcome.balance !== null) {
      this.realtimeGateway.notifyUserBalanceUpdated(
        outcome.userId,
        decimalToNumber(outcome.balance),
      );
    }
    return this.detail(id, now);
  }

  /** POST /lottery/admin/claims/:id/reject — REQUESTED → REJECTED with the reason the customer sees; no money moves. */
  async reject(
    id: string,
    dto: RejectClaimDto,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<AdminClaimDetail> {
    const reason = rejectReasonFromWire(dto.reason);
    const note = dto.note ?? null;
    await this.prisma.$transaction(async (tx) => {
      const claim = await this.lockClaim(tx, id);
      this.requireStatus(claim, LotteryClaimStatus.REQUESTED);
      await tx.lotteryPayout.updateMany({
        where: { claimId: id, status: LotteryPayoutStatus.REQUESTED },
        data: { status: LotteryPayoutStatus.REJECTED },
      });
      const after = await tx.lotteryClaim.update({
        where: { id },
        data: {
          status: LotteryClaimStatus.REJECTED,
          decidedAt: now,
          decidedByUserId: actor.id,
          rejectReason: reason,
          rejectNote: note,
        },
      });
      await this.audit.record({
        action: 'lottery_claim.reject',
        actor,
        target: { type: 'lottery_claim', id, label: claimLabel(claim) },
        before: lotteryClaimSnapshot(claim),
        after: lotteryClaimSnapshot(after),
        metadata: {
          drawNo: claim.draw.drawNo,
          ticketsCount: claim.ticketsCount,
          ks: claim.ks.toNumber(),
          reason: dto.reason,
        },
        tx,
      });
    });
    return this.detail(id, now);
  }

  /** POST /lottery/admin/claims/:id/reopen — "Review again": REJECTED → REQUESTED, the decision and the reason cleared. */
  async reopen(
    id: string,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<AdminClaimDetail> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await this.lockClaim(tx, id);
      this.requireStatus(claim, LotteryClaimStatus.REJECTED);
      await tx.lotteryPayout.updateMany({
        where: { claimId: id, status: LotteryPayoutStatus.REJECTED },
        data: { status: LotteryPayoutStatus.REQUESTED },
      });
      const after = await tx.lotteryClaim.update({
        where: { id },
        data: {
          status: LotteryClaimStatus.REQUESTED,
          decidedAt: null,
          decidedByUserId: null,
          rejectReason: null,
          rejectNote: null,
        },
      });
      await this.audit.record({
        action: 'lottery_claim.reopen',
        actor,
        target: { type: 'lottery_claim', id, label: claimLabel(claim) },
        before: lotteryClaimSnapshot(claim),
        after: lotteryClaimSnapshot(after),
        metadata: {
          drawNo: claim.draw.drawNo,
          ticketsCount: claim.ticketsCount,
          ks: claim.ks.toNumber(),
          previousReason: rejectReasonToWire(claim.rejectReason),
          previousNote: claim.rejectNote,
        },
        tx,
      });
    });
    return this.detail(id, now);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * The rows of one tab, before paging: the claim rows (one tab's status,
   * or every status for "all"), the synthesised UNCLAIMED groups, or both.
   * `q` narrows claims by an EXISTS over their payouts' tickets or their
   * customer, and groups by a HAVING over the same (a group stays whole —
   * its count and sums are never cut to the matching tickets).
   */
  private rowsSql(query: AdminClaimsQueryDto): Prisma.Sql {
    const status = query.status ?? 'requested';
    const like = query.q ? escapeLike(query.q) : null;
    const prefix = like === null ? null : `${like}%`;
    const contains = like === null ? null : `%${like}%`;

    const claimScope: Prisma.Sql[] = [];
    if (status !== 'all' && status !== 'not_requested') {
      claimScope.push(Prisma.sql`c."status" = ${CLAIM_STATUS_SQL[status]}`);
    }
    if (query.drawId) claimScope.push(Prisma.sql`c."drawId" = ${query.drawId}`);
    if (prefix !== null && contains !== null) {
      claimScope.push(Prisma.sql`(EXISTS (
          SELECT 1 FROM "lottery_payouts" cp JOIN "lottery_tickets" ct ON ct."id" = cp."ticketId"
          WHERE cp."claimId" = c."id" AND (ct."ticketNo" ILIKE ${prefix} OR ct."number" LIKE ${prefix}))
        OR EXISTS (
          SELECT 1 FROM "users" cu
          WHERE cu."id" = c."userId" AND (cu."username" ILIKE ${contains} OR cu."displayName" ILIKE ${contains} OR cu."phone" LIKE ${contains})))`);
    }
    const claimRows = Prisma.sql`
      SELECT c."id" AS "id", c."id" AS "key", c."status"::text AS "status",
        c."drawId", c."userId", c."ticketsCount",
        c."baht"::numeric(12,2)::text AS "baht", c."ks"::numeric(12,2)::text AS "ks",
        c."requestedAt", c."decidedAt", c."decidedByUserId", c."rejectReason"::text AS "rejectReason",
        c."rejectNote", c."paidAtPublish", c."transactionId",
        CASE WHEN c."status" = ${CLAIM_STATUS_SQL.requested} THEN 0 ELSE 1 END AS "rank",
        CASE WHEN c."status" = ${CLAIM_STATUS_SQL.requested} THEN c."requestedAt" ELSE COALESCE(c."decidedAt", c."requestedAt") END AS "at",
        c."ks" AS "sortKs"
      FROM "lottery_claims" c
      ${claimScope.length > 0 ? Prisma.sql`WHERE ${Prisma.join(claimScope, ' AND ')}` : Prisma.empty}`;

    const unclaimedScope: Prisma.Sql[] = [
      Prisma.sql`p."status" = ${PAYOUT_UNCLAIMED}`,
    ];
    if (query.drawId) {
      unclaimedScope.push(Prisma.sql`p."drawId" = ${query.drawId}`);
    }
    const having =
      prefix !== null && contains !== null
        ? Prisma.sql`HAVING bool_or(t."ticketNo" ILIKE ${prefix} OR t."number" LIKE ${prefix} OR u."username" ILIKE ${contains} OR u."displayName" ILIKE ${contains} OR u."phone" LIKE ${contains})`
        : Prisma.empty;
    const unclaimedRows = Prisma.sql`
      SELECT NULL::text AS "id", p."drawId" || ':' || p."userId" AS "key", 'UNCLAIMED'::text AS "status",
        p."drawId", p."userId", COUNT(*)::int AS "ticketsCount",
        SUM(p."baht")::numeric(12,2)::text AS "baht", SUM(p."ks")::numeric(12,2)::text AS "ks",
        NULL::timestamp(3) AS "requestedAt", NULL::timestamp(3) AS "decidedAt", NULL::text AS "decidedByUserId", NULL::text AS "rejectReason",
        NULL::text AS "rejectNote", false AS "paidAtPublish", NULL::text AS "transactionId",
        2 AS "rank", d."publishedAt" AS "at", SUM(p."ks") AS "sortKs"
      FROM "lottery_payouts" p
      JOIN "lottery_draws" d ON d."id" = p."drawId"
      JOIN "lottery_tickets" t ON t."id" = p."ticketId"
      JOIN "users" u ON u."id" = p."userId"
      WHERE ${Prisma.join(unclaimedScope, ' AND ')}
      GROUP BY p."drawId", p."userId", d."publishedAt"
      ${having}`;

    if (status === 'not_requested') return unclaimedRows;
    if (status === 'all') {
      return Prisma.sql`${claimRows} UNION ALL ${unclaimedRows}`;
    }
    return claimRows;
  }

  /** The customers and deciders of a page, by id, in one query. */
  private async peopleFor(
    rows: readonly ListRow[],
  ): Promise<Map<string, AdminClaimUser>> {
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.userId);
      if (row.decidedByUserId) ids.add(row.decidedByUserId);
    }
    const people = new Map<string, AdminClaimUser>();
    if (ids.size === 0) return people;
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: ADMIN_USER_SELECT,
    });
    for (const user of users) people.set(user.id, user);
    return people;
  }

  private rowView(
    row: ListRow,
    people: ReadonlyMap<string, AdminClaimUser>,
  ): AdminClaimRow {
    const user = people.get(row.userId) ?? unknownUser(row.userId);
    const decider = row.decidedByUserId
      ? people.get(row.decidedByUserId)
      : undefined;
    return {
      id: row.id,
      key: row.key,
      status:
        row.status === 'UNCLAIMED'
          ? 'not_requested'
          : claimStatusToWire(row.status),
      drawId: row.drawId,
      drawNo: Number(row.drawNo),
      thaiDrawDate:
        typeof row.thaiDrawDate === 'string'
          ? row.thaiDrawDate.slice(0, 10)
          : toDateString(row.thaiDrawDate),
      user,
      ticketsCount: Number(row.ticketsCount),
      baht: ksText(row.baht),
      ks: ksText(row.ks),
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
      decidedBy: decider
        ? {
            id: decider.id,
            username: decider.username,
            displayName: decider.displayName,
          }
        : null,
      rejectReason: rejectReasonToWire(
        (row.rejectReason as LotteryClaimRejectReason | null) ?? null,
      ),
      rejectNote: row.rejectNote,
      paidAtPublish: row.paidAtPublish,
      transactionId: row.transactionId,
    };
  }

  /** A stored claim as a list row (the detail's top half). */
  private claimRowView(
    claim: StoredClaimDetail,
    user: AdminClaimUser,
    decidedBy: AdminStaffRef | null,
  ): AdminClaimRow {
    return {
      id: claim.id,
      key: claim.id,
      status: claimStatusToWire(claim.status),
      drawId: claim.drawId,
      drawNo: claim.draw.drawNo,
      thaiDrawDate: toDateString(claim.draw.thaiDrawDate),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        phone: user.phone,
        email: user.email,
      },
      ticketsCount: claim.ticketsCount,
      baht: ksText(claim.baht),
      ks: ksText(claim.ks),
      requestedAt: claim.requestedAt,
      decidedAt: claim.decidedAt,
      decidedBy,
      rejectReason: rejectReasonToWire(claim.rejectReason),
      rejectNote: claim.rejectNote,
      paidAtPublish: claim.paidAtPublish,
      transactionId: claim.transactionId,
    };
  }

  /**
   * The claim's row lock, then the row as it is now: a second decision on
   * the same claim waits here and then sees the first one's status.
   */
  private async lockClaim(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<StoredClaimToDecide> {
    await tx.$queryRaw`SELECT "id" FROM "lottery_claims" WHERE "id" = ${id} FOR UPDATE`;
    const claim = await tx.lotteryClaim.findUnique({
      where: { id },
      include: CLAIM_DECIDE_INCLUDE,
    });
    if (!claim) throw this.notFound();
    return claim;
  }

  private requireStatus(claim: LotteryClaim, status: LotteryClaimStatus) {
    if (claim.status === status) return;
    throw lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.CLAIM_STATE,
      status === LotteryClaimStatus.REQUESTED
        ? 'Only a waiting claim can be confirmed or rejected'
        : 'Only a rejected claim can be reviewed again',
      { status: claimStatusToWire(claim.status) },
    );
  }

  private notFound() {
    return lotteryError(
      HttpStatus.NOT_FOUND,
      LOTTERY_ERRORS.CLAIM_NOT_FOUND,
      'Claim not found',
    );
  }
}

/** "Draw 24 (2026-11-01) · @mya" — what the audit log shows for a claim. */
export function claimLabel(claim: StoredClaimToDecide): string {
  return `${drawLabel(claim.draw)} · @${claim.user.username}`;
}

/** `%`, `_` and `\` in a search term stand for themselves (LIKE's default escape is the backslash). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function decimalOrNull(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** A customer row the users query did not return (cannot happen: the FK is RESTRICT) — never crash the page over it. */
function unknownUser(id: string): AdminClaimUser {
  return { id, username: '', displayName: null, phone: null, email: null };
}
