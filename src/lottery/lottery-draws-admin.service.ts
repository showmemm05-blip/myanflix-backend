import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryPayoutStatus,
  LotteryResultStatus,
  Prisma,
  type LotteryDraw,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { lotteryDrawSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  type AdminDrawQueryDto,
  type AdminDrawTicketsQueryDto,
  type CreateLotteryDrawDto,
  type OffSaleNumbersDto,
  type TicketStatusWire,
  type UpdateLotteryDrawDto,
} from './dto/lottery-draw.dto';
import {
  drawStatusFromWire,
  FINISHED_STATUSES,
  LotteryDrawsService,
  SELLING_STATUSES,
  ticketStatusToWire,
  type DrawView,
} from './lottery-draws.service';
import { drawNotFound, LOTTERY_ERRORS, lotteryError } from './lottery-errors';
import { LotterySettingsService } from './lottery-settings.service';
import { wonGroupsOf, type TicketWonGroup } from './results/payout-groups';
import {
  dateOnly,
  drawAtFor,
  minutesBefore,
  toDateString,
} from './lottery-time';

/** Advisory-lock key for creating a draw: "next drawNo" and its insert are one step. */
export const DRAW_CREATE_LOCK_NAMESPACE = 'lottery_draw.create';

/** The customer columns the admin ticket list shows (deposits precedent: ADMIN_USER_SELECT). */
const TICKET_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/** Sales figures of one draw, for the admin list and detail. */
export interface DrawStats {
  ticketsSold: number;
  revenueKs: number;
  buyers: number;
}

const NO_SALES: DrawStats = { ticketsSold: 0, revenueKs: 0, buyers: 0 };

/** One row of the stats query: counts as int, the sum as text (Decimal-safe). */
interface DrawStatsRow {
  drawId: string;
  ticketsSold: number;
  revenueKs: string | null;
  buyers: number;
}

/** Tickets and Ks of a draw's prizes in one claim status (2026-10-24). */
export interface DrawClaimsBucket {
  tickets: number;
  ks: number;
}

/**
 * The draw page's claims strip: every awarded prize of the draw by where
 * it is in the claim flow, counted from lottery_payouts. Null until the
 * draw is published.
 */
export interface DrawClaimsSummary {
  winningTickets: number;
  prizeTotalKs: number;
  waiting: DrawClaimsBucket;
  paid: DrawClaimsBucket;
  notRequested: DrawClaimsBucket;
  rejected: DrawClaimsBucket;
  expired: DrawClaimsBucket;
}

/** The admin's draw: the public shape plus the figures and the bookkeeping. */
export interface AdminDrawView extends DrawView, DrawStats {
  exchangeRate: number | null;
  /** The Ks awarded in all at publish (2026-10-24); null until published. */
  prizeTotalKs: number | null;
  /** Until when a prize may still be requested; null until published. */
  claimDeadlineAt: Date | null;
  /** Detail only — the list leaves it out. */
  offSaleNumbers?: string[];
  /** Detail only — the list leaves it out; null until published. */
  claims?: DrawClaimsSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminDrawPage {
  items: AdminDrawView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminTicketView {
  ticketNo: string;
  number: string;
  purchaseRef: string;
  boughtAt: Date;
  status: TicketStatusWire;
  /** Ks paid for the ticket; null until published and for a ticket that did not win (phase 3). */
  prizeKs: number | null;
  /** The groups the ticket won, in sheet order; null until published, [] when it did not win. */
  wonGroups: TicketWonGroup[] | null;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    phone: string | null;
    email: string | null;
  };
}

export interface AdminTicketPage {
  items: AdminTicketView[];
  total: number;
  page: number;
  pageSize: number;
}

type TransitionVerb = 'open' | 'pause' | 'close' | 'reopen';

/** A results row in one of these states means the sheet is in: the draw can no longer reopen. */
export const RESULTS_IN_STATUSES: readonly LotteryResultStatus[] = [
  LotteryResultStatus.FETCHED,
  LotteryResultStatus.PUBLISHED,
];

const REOPEN_REFUSAL_RESULTS = 'Results are already in for this draw';
const REOPEN_REFUSAL_STATE =
  'Only a closed draw whose sales close time is still ahead can reopen';

/**
 * The staff side of draws (lottery backend phase 2): make a draw, change
 * what may still change, open / pause / close / reopen sales, take numbers
 * off sale, and read the tickets sold. Every change records one audit row in
 * the same transaction. Price and per-number limit come from the settings
 * at creation and belong to the draw from then on.
 */
@Injectable()
export class LotteryDrawsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
    private readonly settings: LotterySettingsService,
    private readonly draws: LotteryDrawsService,
  ) {}

  async list(query: AdminDrawQueryDto): Promise<AdminDrawPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryDrawWhereInput = query.status
      ? { status: drawStatusFromWire(query.status) }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.lotteryDraw.findMany({
        where,
        orderBy: { drawNo: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lotteryDraw.count({ where }),
    ]);
    const stats = await this.statsFor(rows.map((row) => row.id));
    return {
      items: rows.map((row) =>
        this.adminView(row, stats.get(row.id) ?? NO_SALES),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * `drawNo` defaults to the next number; `salesCloseAt` to the setting's
   * gap before the Thai draw; the ticket frame to the setting's (copied,
   * like the price — a later setting change never touches this draw).
   * Both the "next number" read and the insert run under one advisory
   * lock, so two creates at once never collide.
   */
  async create(
    dto: CreateLotteryDrawDto,
    actor: AuthenticatedUser,
  ): Promise<AdminDrawView> {
    const settings = await this.settings.getOrCreate();
    const drawAt = drawAtFor(dto.thaiDrawDate);
    const salesCloseAt = dto.salesCloseAt
      ? new Date(dto.salesCloseAt)
      : minutesBefore(drawAt, settings.salesCloseMinutesBefore);
    this.assertSalesCloseBeforeDraw(salesCloseAt, drawAt);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DRAW_CREATE_LOCK_NAMESPACE}))`;
      let drawNo = dto.drawNo;
      if (drawNo === undefined) {
        const { _max } = await tx.lotteryDraw.aggregate({
          _max: { drawNo: true },
        });
        drawNo = (_max.drawNo ?? 0) + 1;
      } else {
        const taken = await tx.lotteryDraw.findUnique({
          where: { drawNo },
          select: { id: true },
        });
        if (taken) {
          throw lotteryError(
            HttpStatus.CONFLICT,
            LOTTERY_ERRORS.DRAW_NO_TAKEN,
            `Draw ${drawNo} already exists`,
            { drawNo },
          );
        }
      }
      const row = await tx.lotteryDraw.create({
        data: {
          drawNo,
          thaiDrawDate: dateOnly(dto.thaiDrawDate),
          drawAt,
          salesCloseAt,
          ticketPrice: settings.ticketPrice,
          maxPerNumber: settings.maxPerNumber,
          pictureUrl: dto.pictureUrl
            ? this.minioService.canonicalImageUrl(dto.pictureUrl)
            : null,
          frameUrl:
            dto.frameUrl === undefined
              ? settings.frameUrl
              : this.minioService.canonicalImageUrl(dto.frameUrl),
          createdByUserId: actor.id,
        },
      });
      await this.audit.record({
        action: 'lottery_draw.create',
        actor,
        target: { type: 'lottery_draw', id: row.id, label: this.label(row) },
        after: lotteryDrawSnapshot(row),
        tx,
      });
      return row;
    });
    return this.adminView(created, NO_SALES, [], null);
  }

  async findOne(id: string): Promise<AdminDrawView> {
    const row = await this.findRow(id);
    const [stats, offSale, claims] = await Promise.all([
      this.statsFor([id]),
      this.prisma.lotteryOffSaleNumber.findMany({
        where: { drawId: id },
        orderBy: { number: 'asc' },
        select: { number: true },
      }),
      this.claimsFor(row),
    ]);
    return this.adminView(
      row,
      stats.get(id) ?? NO_SALES,
      offSale.map((entry) => entry.number),
      claims,
    );
  }

  /**
   * What may still change: the date, the price and the per-number limit
   * only while no ticket is sold and the draw is not published; the
   * picture and the frame only while no ticket is sold (customers hold
   * them on their tickets — a sold ticket keeps the look it was sold
   * with); the sales close time until the draw is closed. Moving the date
   * alone keeps the same gap to sales close.
   *
   * The checks and the write run under the draw's row lock — the one every
   * checkout takes — so a purchase cannot land between "no ticket sold"
   * and the UPDATE and leave a draw with tickets at a changed date or price.
   */
  async update(
    id: string,
    dto: UpdateLotteryDrawDto,
    actor: AuthenticatedUser,
  ): Promise<AdminDrawView> {
    await this.findRow(id);
    await this.prisma.$transaction(async (tx) => {
      await this.lockRow(tx, id);
      const before = await tx.lotteryDraw.findUniqueOrThrow({ where: { id } });
      const ticketsSold = await tx.lotteryTicket.count({
        where: { drawId: id },
      });
      const finished = FINISHED_STATUSES.includes(before.status);

      const wantsSetup =
        dto.thaiDrawDate !== undefined ||
        dto.ticketPrice !== undefined ||
        dto.maxPerNumber !== undefined;
      if (
        wantsSetup &&
        (ticketsSold > 0 || before.status === LotteryDrawStatus.PUBLISHED)
      ) {
        throw this.locked(
          'The date, price and per-number limit cannot change once tickets are sold or results are published',
          ticketsSold,
        );
      }
      if (
        (dto.pictureUrl !== undefined || dto.frameUrl !== undefined) &&
        ticketsSold > 0
      ) {
        throw this.locked(
          'The picture and the frame cannot change once tickets are sold',
          ticketsSold,
        );
      }
      if (dto.salesCloseAt !== undefined && finished) {
        throw this.locked(
          'The sales close time cannot change once the draw is closed',
          ticketsSold,
        );
      }

      const data: Prisma.LotteryDrawUpdateInput = {};
      let drawAt = before.drawAt;
      let salesCloseAt = before.salesCloseAt;
      if (dto.thaiDrawDate !== undefined) {
        drawAt = drawAtFor(dto.thaiDrawDate);
        data.thaiDrawDate = dateOnly(dto.thaiDrawDate);
        data.drawAt = drawAt;
        if (dto.salesCloseAt === undefined) {
          const gap = before.drawAt.getTime() - before.salesCloseAt.getTime();
          salesCloseAt = new Date(drawAt.getTime() - gap);
        }
      }
      if (dto.salesCloseAt !== undefined)
        salesCloseAt = new Date(dto.salesCloseAt);
      this.assertSalesCloseBeforeDraw(salesCloseAt, drawAt);
      if (salesCloseAt.getTime() !== before.salesCloseAt.getTime()) {
        data.salesCloseAt = salesCloseAt;
      }
      if (dto.ticketPrice !== undefined) data.ticketPrice = dto.ticketPrice;
      if (dto.maxPerNumber !== undefined) data.maxPerNumber = dto.maxPerNumber;
      if (dto.pictureUrl !== undefined) {
        data.pictureUrl = dto.pictureUrl
          ? this.minioService.canonicalImageUrl(dto.pictureUrl)
          : null;
      }
      if (dto.frameUrl !== undefined) {
        data.frameUrl = this.minioService.canonicalImageUrl(dto.frameUrl);
      }
      if (Object.keys(data).length === 0) return;

      const after = await tx.lotteryDraw.update({ where: { id }, data });
      await this.audit.record({
        action: 'lottery_draw.update',
        actor,
        target: { type: 'lottery_draw', id, label: this.label(after) },
        before: lotteryDrawSnapshot(before),
        after: lotteryDrawSnapshot(after),
        tx,
      });
    });
    return this.findOne(id);
  }

  /** SCHEDULED or PAUSED → OPEN, only while the sales close time is still ahead. */
  open(id: string, actor: AuthenticatedUser): Promise<AdminDrawView> {
    const now = new Date();
    return this.transition(id, actor, 'open', {
      from: [LotteryDrawStatus.SCHEDULED, LotteryDrawStatus.PAUSED],
      to: LotteryDrawStatus.OPEN,
      guard: { salesCloseAt: { gt: now } },
      stamps: (row) => ({ openedAt: row.openedAt ?? now }),
      refusal:
        'Only a scheduled or paused draw can open, and only before its sales close time',
    });
  }

  /** OPEN → PAUSED: selling stops, the draw can open again later. */
  pause(id: string, actor: AuthenticatedUser): Promise<AdminDrawView> {
    return this.transition(id, actor, 'pause', {
      from: [LotteryDrawStatus.OPEN],
      to: LotteryDrawStatus.PAUSED,
      refusal: 'Only an open draw can be paused',
    });
  }

  /** OPEN or PAUSED → CLOSED: sales are over (the cron does the same at the close time). */
  close(id: string, actor: AuthenticatedUser): Promise<AdminDrawView> {
    const now = new Date();
    return this.transition(id, actor, 'close', {
      from: [...SELLING_STATUSES],
      to: LotteryDrawStatus.CLOSED,
      stamps: () => ({ closedAt: now }),
      refusal: 'Only an open or paused draw can be closed',
    });
  }

  /**
   * CLOSED → OPEN, only while the sales close time is still ahead and no
   * sheet is in (no results row in FETCHED or PUBLISHED — a sheet typed in
   * by hand is FETCHED too; PENDING, FAILED or no row is fine). openedAt
   * stays, closedAt clears. The cron closes the draw again at the close
   * time as usual. Both conditions sit in the guarded UPDATE, and the
   * UPDATE runs only once the draw's row lock is held (transition()), so a
   * sheet landing a moment earlier — a manual entry or a staff "Fetch now"
   * in flight, which write under that same lock — is seen and refuses; the
   * reason is read only when the update matched nothing.
   */
  reopen(id: string, actor: AuthenticatedUser): Promise<AdminDrawView> {
    const now = new Date();
    return this.transition(id, actor, 'reopen', {
      from: [LotteryDrawStatus.CLOSED],
      to: LotteryDrawStatus.OPEN,
      guard: {
        salesCloseAt: { gt: now },
        OR: [
          { result: null },
          { result: { status: { notIn: [...RESULTS_IN_STATUSES] } } },
        ],
      },
      stamps: () => ({ closedAt: null }),
      refusal: async () => {
        const result = await this.prisma.lotteryResult.findUnique({
          where: { drawId: id },
          select: { status: true },
        });
        return result && RESULTS_IN_STATUSES.includes(result.status)
          ? REOPEN_REFUSAL_RESULTS
          : REOPEN_REFUSAL_STATE;
      },
    });
  }

  /** Replaces the draw's off-sale list; tickets already sold for a number stay valid. */
  async setOffSale(
    id: string,
    dto: OffSaleNumbersDto,
    actor: AuthenticatedUser,
  ): Promise<AdminDrawView> {
    const draw = await this.findRow(id);
    const numbers = [...new Set(dto.numbers)];
    await this.prisma.$transaction(async (tx) => {
      // Behind any checkout of this draw that is in flight, and ahead of
      // every later one: a number pulled here is never sold a moment later
      // by a purchase that read the old list. Lock order is draw → off-sale
      // rows; a purchase goes draw → wallet, so the two never cycle.
      await this.lockRow(tx, id);
      const current = await tx.lotteryOffSaleNumber.findMany({
        where: { drawId: id },
        select: { number: true },
      });
      const before = new Set(current.map((entry) => entry.number));
      const after = new Set(numbers);
      await tx.lotteryOffSaleNumber.deleteMany({ where: { drawId: id } });
      if (numbers.length > 0) {
        await tx.lotteryOffSaleNumber.createMany({
          data: numbers.map((number) => ({ drawId: id, number })),
        });
      }
      await this.audit.record({
        action: 'lottery_draw.off_sale',
        actor,
        target: { type: 'lottery_draw', id, label: this.label(draw) },
        metadata: {
          before: before.size,
          after: after.size,
          added: numbers.filter((number) => !before.has(number)).length,
          removed: [...before].filter((number) => !after.has(number)).length,
        },
        tx,
      });
    });
    return this.findOne(id);
  }

  /**
   * The tickets of one draw, newest first. `q` finds a ticket number, the
   * start of a lottery number, a purchase ref, or the customer by
   * username, display name or phone. Once published each row carries its
   * prize and the groups it won (phase 3).
   */
  async listTickets(
    id: string,
    query: AdminDrawTicketsQueryDto,
  ): Promise<AdminTicketPage> {
    await this.findRow(id);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryTicketWhereInput = {
      drawId: id,
      ...(query.q ? ticketSearchWhere(query.q) : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.lotteryTicket.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: TICKET_USER_SELECT },
          purchase: { select: { ref: true } },
          payout: { select: { groups: true } },
        },
      }),
      this.prisma.lotteryTicket.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        ticketNo: row.ticketNo,
        number: row.number,
        purchaseRef: row.purchase.ref,
        boughtAt: row.createdAt,
        status: ticketStatusToWire(row.status),
        prizeKs: row.prizeKs === null ? null : row.prizeKs.toNumber(),
        wonGroups: wonGroupsOf(row.status, row.payout),
        user: row.user,
      })),
      total,
      page,
      pageSize,
    };
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * One guarded UPDATE: the status check and the change are the same
   * statement, so two staff clicks (or a click racing the cron) cannot
   * both succeed. The draw's row lock is taken first — the one a checkout,
   * a results write and publish all take — so the UPDATE runs in a fresh
   * snapshot after any of those in flight has committed. Without it a
   * results write (which locks the draw row but never changes it) could
   * commit while the UPDATE waited on that lock, and the UPDATE would then
   * go through on its stale "no sheet" answer: Postgres re-checks the WHERE
   * only when the locked row itself got a new version. Lock order is the
   * draw row alone, so nothing cycles with the purchase path (draw →
   * wallet). No row matched = the draw was not in a state this verb
   * accepts = 409 LOTTERY_DRAW_STATE, with the rule's refusal text (a
   * function when the reason has to be looked up).
   */
  private async transition(
    id: string,
    actor: AuthenticatedUser,
    verb: TransitionVerb,
    rule: {
      from: LotteryDrawStatus[];
      to: LotteryDrawStatus;
      guard?: Prisma.LotteryDrawWhereInput;
      stamps?: (row: LotteryDraw) => Prisma.LotteryDrawUpdateManyMutationInput;
      refusal: string | (() => Promise<string>);
    },
  ): Promise<AdminDrawView> {
    const before = await this.findRow(id);
    const after = await this.prisma.$transaction(async (tx) => {
      await this.lockRow(tx, id);
      const updated = await tx.lotteryDraw.updateMany({
        where: { id, status: { in: rule.from }, ...rule.guard },
        data: { status: rule.to, ...rule.stamps?.(before) },
      });
      if (updated.count === 0) return null;
      const row = await tx.lotteryDraw.findUniqueOrThrow({ where: { id } });
      await this.audit.record({
        action: `lottery_draw.${verb}`,
        actor,
        target: { type: 'lottery_draw', id, label: this.label(row) },
        before: lotteryDrawSnapshot(before),
        after: lotteryDrawSnapshot(row),
        tx,
      });
      return row;
    });
    if (!after) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.DRAW_STATE,
        typeof rule.refusal === 'string' ? rule.refusal : await rule.refusal(),
        { status: before.status.toLowerCase() },
      );
    }
    return this.findOne(id);
  }

  /** Tickets sold, Ks taken and distinct buyers per draw, in one query. */
  private async statsFor(ids: string[]): Promise<Map<string, DrawStats>> {
    const stats = new Map<string, DrawStats>();
    if (ids.length === 0) return stats;
    const rows = await this.prisma.$queryRaw<DrawStatsRow[]>`
      SELECT d."id" AS "drawId",
        (SELECT COUNT(*)::int FROM "lottery_tickets" t WHERE t."drawId" = d."id") AS "ticketsSold",
        (SELECT SUM(p."total")::text FROM "lottery_purchases" p WHERE p."drawId" = d."id") AS "revenueKs",
        (SELECT COUNT(DISTINCT p."userId")::int FROM "lottery_purchases" p WHERE p."drawId" = d."id") AS "buyers"
      FROM "lottery_draws" d
      WHERE d."id" IN (${Prisma.join(ids)})`;
    for (const row of rows) {
      stats.set(row.drawId, {
        ticketsSold: Number(row.ticketsSold),
        revenueKs: row.revenueKs === null ? 0 : Number(row.revenueKs),
        buyers: Number(row.buyers),
      });
    }
    return stats;
  }

  private async findRow(id: string): Promise<LotteryDraw> {
    const row = await this.prisma.lotteryDraw.findUnique({ where: { id } });
    if (!row) throw drawNotFound();
    return row;
  }

  /** The draw's row lock — the same statement a checkout takes (lottery-purchases.service.ts). */
  private async lockRow(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "lottery_draws" WHERE "id" = ${id} FOR UPDATE`;
  }

  private assertSalesCloseBeforeDraw(salesCloseAt: Date, drawAt: Date) {
    if (salesCloseAt.getTime() > drawAt.getTime()) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.DRAW_TIME_INVALID,
        'Sales must close before the draw',
        { drawAt: drawAt.toISOString() },
      );
    }
  }

  private locked(message: string, ticketsSold: number) {
    return lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.DRAW_LOCKED,
      message,
      { ticketsSold },
    );
  }

  /** "Draw 24 (2026-11-01)" — what the audit log shows for a draw. */
  private label(draw: Pick<LotteryDraw, 'drawNo' | 'thaiDrawDate'>): string {
    return drawLabel(draw);
  }

  /**
   * The detail's claims strip (2026-10-24): the draw's payouts counted and
   * summed per status in one GROUP BY. Null until the draw is published —
   * before that there are no payouts to count.
   */
  private async claimsFor(row: LotteryDraw): Promise<DrawClaimsSummary | null> {
    if (row.status !== LotteryDrawStatus.PUBLISHED) return null;
    const groups = await this.prisma.lotteryPayout.groupBy({
      by: ['status'],
      where: { drawId: row.id },
      _count: { _all: true },
      _sum: { ks: true },
    });
    const bucket = (status: LotteryPayoutStatus): DrawClaimsBucket => {
      const group = groups.find((entry) => entry.status === status);
      return {
        tickets: group?._count._all ?? 0,
        ks: group?._sum.ks?.toNumber() ?? 0,
      };
    };
    const winningTickets = groups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const awardedKs = groups.reduce(
      (sum, group) => sum.add(group._sum.ks ?? 0),
      new Prisma.Decimal(0),
    );
    return {
      winningTickets,
      prizeTotalKs: row.prizeTotalKs?.toNumber() ?? awardedKs.toNumber(),
      waiting: bucket(LotteryPayoutStatus.REQUESTED),
      paid: bucket(LotteryPayoutStatus.PAID),
      notRequested: bucket(LotteryPayoutStatus.UNCLAIMED),
      rejected: bucket(LotteryPayoutStatus.REJECTED),
      expired: bucket(LotteryPayoutStatus.EXPIRED),
    };
  }

  private adminView(
    row: LotteryDraw,
    stats: DrawStats,
    offSaleNumbers?: string[],
    claims?: DrawClaimsSummary | null,
  ): AdminDrawView {
    return {
      ...this.draws.view(row),
      exchangeRate:
        row.exchangeRate === null ? null : row.exchangeRate.toNumber(),
      prizeTotalKs:
        row.prizeTotalKs === null ? null : row.prizeTotalKs.toNumber(),
      claimDeadlineAt: row.claimDeadlineAt,
      ...stats,
      ...(offSaleNumbers ? { offSaleNumbers } : {}),
      ...(claims === undefined ? {} : { claims }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** "Draw 24 (2026-11-01)" — the audit label of a draw (the cron uses it too). */
export function drawLabel(
  draw: Pick<LotteryDraw, 'drawNo' | 'thaiDrawDate'>,
): string {
  return `Draw ${draw.drawNo} (${toDateString(draw.thaiDrawDate)})`;
}

/** The admin ticket search: a ticket number, a number prefix, a purchase ref, or the customer. */
export function ticketSearchWhere(q: string): Prisma.LotteryTicketWhereInput {
  return {
    OR: [
      { ticketNo: { contains: q, mode: 'insensitive' } },
      { number: { startsWith: q } },
      { purchase: { ref: { contains: q, mode: 'insensitive' } } },
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
