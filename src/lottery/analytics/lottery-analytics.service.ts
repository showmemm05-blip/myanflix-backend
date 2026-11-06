import { Injectable } from '@nestjs/common';
import { YANGON_UTC_OFFSET_MINUTES } from '../../bank-events/risk-rules';
import { Prisma, type LotteryDraw } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT,
  ANALYTICS_PAGE_SIZE_DEFAULT,
  type AcrossSort,
  type AnalyticsActivityQueryDto,
  type AnalyticsBeforeCloseQueryDto,
  type AnalyticsDrawsQueryDto,
  type AnalyticsNumbersAcrossQueryDto,
  type AnalyticsNumbersQueryDto,
  type AnalyticsPeriodQueryDto,
  type AnalyticsView,
  type NumbersSort,
  type SortOrder,
} from '../dto/lottery-analytics.dto';
import type { DrawStatusWire } from '../dto/lottery-draw.dto';
import { drawStatusToWire, FINISHED_STATUSES } from '../lottery-draws.service';
import { drawNotFound } from '../lottery-errors';
import { toDateString } from '../lottery-time';
import { LotteryActivityService } from './lottery-activity.service';
import {
  BEFORE_CLOSE_BINS,
  beforeCloseEdges,
  bucketKeys,
  changePct,
  hasEarlierData,
  HOUR_KEYS,
  ksText,
  resolvePeriod,
  share,
  WEEKDAY_KEYS,
  type AnalyticsPeriod,
  type AnalyticsWindow,
  type BeforeCloseBinKey,
} from './lottery-analytics-period';

// ---------------------------------------------------------------------------
// Response shapes (what the admin's lottery-analytics types mirror)
// ---------------------------------------------------------------------------

export interface AnalyticsRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export interface PeakHour {
  /** Hour of day in MMT, 0..23. */
  hour: number;
  ticketsSold: number;
  purchasingUsers: number;
  /** Null when no lottery_activity row falls inside the window (not tracked yet). */
  activeUsers: number | null;
}

export interface PeriodFigures {
  ticketsSold: number;
  purchases: number;
  buyers: number;
  /** "468000.00" — a decimal string, like every Ks figure on the wire. */
  revenueKs: string;
  popularNumber: { number: string; tickets: number } | null;
  peakHour: PeakHour | null;
  avgTicketsPerPurchase: number | null;
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  current: PeriodFigures;
  previous: PeriodFigures;
  /** The first PAID purchase ever (within the draw filter); null before any sale. */
  firstPurchaseAt: Date | null;
  activity: {
    /** The earliest activity hour on record; null before the first ping. */
    trackedSince: Date | null;
    /** True when at least one activity row falls inside the current period. */
    trackedInRange: boolean;
  };
}

export interface ActivityBucket {
  key: string;
  ticketsSold: number;
  purchases: number;
  purchasingUsers: number;
  /** Null in every bucket when `activeUsersTracked` is false. */
  activeUsers: number | null;
}

export interface AnalyticsActivity {
  view: AnalyticsView;
  buckets: ActivityBucket[];
  activeUsersTracked: boolean;
}

export interface NumberTrend {
  /** Tickets of the same number in the comparison period; null when there is no earlier data (or no period). */
  previousTickets: number | null;
  /** (cur − prev) / prev; null when prev is 0 or unknown. */
  changePct: number | null;
  /** True when the number sold nothing in a fully covered comparison period. */
  isNew: boolean;
}

export interface PopularNumber {
  /** Position in the tickets-desc order, whatever sort the page asked for. */
  rank: number;
  number: string;
  tickets: number;
  buyers: number;
  /** tickets / all tickets in the selection, 0..1. */
  share: number;
  /** Buyers who bought this number more than once in the selection. */
  repeatBuyers: number;
  trend: NumberTrend;
}

export interface PopularNumbersPage {
  items: PopularNumber[];
  /** Distinct numbers in the selection. */
  total: number;
  /** All tickets in the selection (the share's denominator). */
  totalTickets: number;
  page: number;
  pageSize: number;
}

export interface AcrossNumber {
  rank: number;
  number: string;
  tickets: number;
  buyers: number;
  share: number;
  drawsPlayed: number;
  /** The best position this number reached in one draw of the selection (ties → the most recent draw). */
  bestRank: { rank: number; drawNo: number } | null;
}

export interface AcrossNumbersPage {
  items: AcrossNumber[];
  total: number;
  totalTickets: number;
  page: number;
  pageSize: number;
}

export const FREQUENCY_BIN_KEYS = ['1', '2-3', '4-9', '10+'] as const;
export type FrequencyBinKey = (typeof FREQUENCY_BIN_KEYS)[number];

export interface FrequencyBin {
  key: FrequencyBinKey;
  users: number;
  /** users / totalBuyers, 0..1. */
  share: number;
}

/**
 * How "first-time" and "returning" were told apart:
 * - 'earliest-purchase' (a window and/or a draw): first-time = the buyer's
 *   earliest PAID purchase ever falls inside the selection;
 * - 'draws-played' (no window AND no draw — the reports' default "All time
 *   · All draws"): returning = bought in two or more draws, first-time = in
 *   one draw only. Under the earliest-purchase rule every buyer would be
 *   first-time there, which says nothing.
 */
export type RepeatDefinition = 'earliest-purchase' | 'draws-played';

export interface AnalyticsFrequency {
  bins: FrequencyBin[];
  totalBuyers: number;
  /** See RepeatDefinition. */
  firstTime: number;
  returning: number;
  definition: RepeatDefinition;
}

export interface HeatmapCell {
  /** 0 = Monday .. 6 = Sunday (MMT). */
  weekday: number;
  /** 0..23 (MMT). */
  hour: number;
  ticketsSold: number;
  purchasingUsers: number;
}

export interface AnalyticsHeatmap {
  /** 168 cells, weekday-major, zero-filled. */
  cells: HeatmapCell[];
}

export interface BeforeCloseBin {
  key: BeforeCloseBinKey;
  tickets: number;
  /** How many hours the bin covers (for "tickets per hour"). */
  hours: number;
}

export interface AnalyticsBeforeClose {
  draw: {
    id: string;
    drawNo: number;
    thaiDrawDate: string;
    status: DrawStatusWire;
    salesCloseAt: Date;
  };
  /** False for a scheduled / open / paused draw: the bins are what has sold so far. */
  closed: boolean;
  bins: BeforeCloseBin[];
  /** Tickets bought before the 72-hour window. */
  earlier: number;
  total: number;
}

export interface DrawComparisonRow {
  id: string;
  drawNo: number;
  thaiDrawDate: string;
  status: DrawStatusWire;
  openedAt: Date | null;
  salesCloseAt: Date;
  tickets: number;
  buyers: number;
  revenueKs: string;
  /** The MMT hour of day with the most tickets; null for a draw that sold nothing. */
  peakHour: number | null;
  winnersCount: number | null;
  prizesPaidKs: string | null;
}

export interface DrawComparisonPage {
  items: DrawComparisonRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Row shapes of the raw queries (every count is cast ::int in SQL)
// ---------------------------------------------------------------------------

interface CountsRow {
  ticketsSold: number;
  purchases: number;
  buyers: number;
  revenueKs: string | null;
}

interface NumberTicketsRow {
  number: string;
  tickets: number;
}

interface PeakHourRow {
  hour: number;
  ticketsSold: number;
  purchasingUsers: number;
}

interface ActiveUsersRow {
  activeUsers: number;
}

interface FirstPurchaseRow {
  firstAt: Date | null;
}

interface ActivityTicketsRow {
  key: string;
  ticketsSold: number;
}

interface ActivityPurchasesRow {
  key: string;
  purchases: number;
  purchasingUsers: number;
}

interface ActivityActiveRow {
  key: string;
  activeUsers: number;
}

interface NumbersPageRow {
  rank: number;
  number: string;
  tickets: number;
  buyers: number;
  repeatBuyers: number;
}

interface TotalsRow {
  total: number;
  totalTickets: number;
}

interface AcrossPageRow {
  rank: number;
  number: string;
  tickets: number;
  buyers: number;
  drawsPlayed: number;
  bestRank: number | null;
  bestDrawNo: number | null;
}

interface FrequencyBinsRow {
  totalBuyers: number;
  one: number;
  twoToThree: number;
  fourToNine: number;
  tenPlus: number;
}

interface FirstTimeRow {
  buyers: number;
  firstTime: number;
}

interface DrawsPlayedRow {
  buyers: number;
  returning: number;
}

interface HeatmapRow {
  weekday: number;
  hour: number;
  ticketsSold: number;
  purchasingUsers: number;
}

/** total, earlier and b0..b5 (one per BEFORE_CLOSE_BINS entry). */
type BeforeCloseRow = Record<string, number>;

interface DrawStatsRow {
  drawId: string;
  tickets: number;
  buyers: number;
  revenueKs: string | null;
  peakHour: number | null;
}

// ---------------------------------------------------------------------------
// SQL building blocks — constant fragments and parameters only. User input
// never reaches the SQL text: dates / ids / sizes are bound parameters and
// a sort key only ever SELECTS one of the constant fragments below.
// ---------------------------------------------------------------------------

/**
 * Every query starts with one of these markers. They are constant text
 * (not parameters), so a spec can tell the queries apart by their SQL and a
 * slow-query log says which report it was.
 */
type QueryName =
  | 'counts'
  | 'popular-number'
  | 'peak-hour'
  | 'active-users-hour'
  | 'first-purchase'
  | 'activity-tickets'
  | 'activity-purchases'
  | 'activity-active'
  | 'numbers-page'
  | 'numbers-totals'
  | 'numbers-previous'
  | 'across-page'
  | 'across-totals'
  | 'frequency-bins'
  | 'frequency-first-time'
  | 'frequency-draws-played'
  | 'heatmap'
  | 'before-close'
  | 'draw-stats';

const tag = (name: QueryName): Prisma.Sql =>
  Prisma.raw(`/* lottery-analytics:${name} */`);

const PAID = Prisma.sql`'PAID'::"LotteryPurchaseStatus"`;
/** Tickets joined to their purchase (`t`, `p`) — "tickets sold" is always PAID-filtered through `p`. */
const TICKETS = Prisma.sql`"lottery_tickets" t JOIN "lottery_purchases" p ON p."id" = t."purchaseId"`;
const PURCHASES = Prisma.sql`"lottery_purchases" p`;
const ACTIVITY = Prisma.sql`"lottery_activity" a`;
const T_CREATED = Prisma.sql`t."createdAt"`;
const P_CREATED = Prisma.sql`p."createdAt"`;
const A_HOUR = Prisma.sql`a."hourStart"`;

/** A stored UTC timestamp read as a Myanmar wall clock (+390 minutes), for date_trunc / extract. */
const mmt = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`(${column} + make_interval(mins => ${YANGON_UTC_OFFSET_MINUTES}::int))`;

/** The weekday keys as a SQL array, indexed by extract(isodow) (1 = Monday). */
const WEEKDAY_ARRAY = Prisma.sql`ARRAY['mon','tue','wed','thu','fri','sat','sun']`;

/** The text bucket key of a timestamp column for a view — the same keys bucketKeys() zero-fills. */
function bucketKeySql(view: AnalyticsView, column: Prisma.Sql): Prisma.Sql {
  const ts = mmt(column);
  switch (view) {
    case 'hourly':
      return Prisma.sql`lpad(extract(hour FROM ${ts})::int::text, 2, '0')`;
    case 'daily':
      return Prisma.sql`to_char(${ts}, 'YYYY-MM-DD')`;
    case 'weekly':
      return Prisma.sql`to_char(date_trunc('week', ${ts}), 'YYYY-MM-DD')`;
    case 'weekday':
      return Prisma.sql`(${WEEKDAY_ARRAY})[extract(isodow FROM ${ts})::int]`;
  }
}

function inWindow(
  column: Prisma.Sql,
  window: AnalyticsWindow | null,
): Prisma.Sql[] {
  if (!window) return [];
  return [
    Prisma.sql`${column} >= ${window.start}`,
    Prisma.sql`${column} < ${window.end}`,
  ];
}

/** WHERE for the tickets join: PAID, inside the window by ticket.createdAt, one draw when asked. */
function ticketScope(
  window: AnalyticsWindow | null,
  drawId?: string,
): Prisma.Sql {
  const parts = [
    Prisma.sql`p."status" = ${PAID}`,
    ...inWindow(T_CREATED, window),
  ];
  if (drawId) parts.push(Prisma.sql`t."drawId" = ${drawId}`);
  return Prisma.join(parts, ' AND ');
}

/** WHERE for purchases: PAID, inside the window by purchase.createdAt, one draw when asked. */
function purchaseScope(
  window: AnalyticsWindow | null,
  drawId?: string,
): Prisma.Sql {
  const parts = [
    Prisma.sql`p."status" = ${PAID}`,
    ...inWindow(P_CREATED, window),
  ];
  if (drawId) parts.push(Prisma.sql`p."drawId" = ${drawId}`);
  return Prisma.join(parts, ' AND ');
}

/** WHERE for activity: hour buckets inside the window (never draw-scoped — a ping has no draw). */
function activityScope(window: AnalyticsWindow): Prisma.Sql {
  return Prisma.join(inWindow(A_HOUR, window), ' AND ');
}

const NUMBERS_ORDER: Record<NumbersSort, Prisma.Sql> = {
  tickets: Prisma.sql`"tickets"`,
  buyers: Prisma.sql`"buyers"`,
  repeat: Prisma.sql`"repeatBuyers"`,
};

const ACROSS_ORDER: Record<AcrossSort, Prisma.Sql> = {
  tickets: Prisma.sql`"tickets"`,
  buyers: Prisma.sql`"buyers"`,
  draws: Prisma.sql`"drawsPlayed"`,
};

const DIRECTION: Record<SortOrder, Prisma.Sql> = {
  asc: Prisma.sql`ASC`,
  desc: Prisma.sql`DESC`,
};

const NO_TREND: NumberTrend = {
  previousTickets: null,
  changePct: null,
  isNew: false,
};

const ZERO_COUNTS: CountsRow = {
  ticketsSold: 0,
  purchases: 0,
  buyers: 0,
  revenueKs: null,
};

/**
 * Lottery > Analytics (2026-10-23): every figure of the dashboard and the
 * reports, aggregated in Postgres (GROUP BY over lottery_tickets /
 * lottery_purchases / lottery_activity) and bucketed in Myanmar time. The
 * service never loads tickets into memory: each method runs a handful of
 * small queries and zero-fills the buckets the SQL did not return. Period
 * rules, bucket keys and bin edges live in lottery-analytics-period.ts.
 */
@Injectable()
export class LotteryAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: LotteryActivityService,
  ) {}

  // ----- 1. overview ------------------------------------------------------

  /** Default period: the last 7 full MMT days. */
  async overview(query: AnalyticsPeriodQueryDto): Promise<AnalyticsOverview> {
    const period = resolvePeriod(query, 'last7');
    const drawId = query.drawId;
    const [current, previous, firstPurchaseAt, trackedSince] =
      await Promise.all([
        this.figures(period, drawId),
        this.figures(period.previous, drawId),
        this.firstPurchaseAt(drawId),
        this.presence.firstActivityAt(),
      ]);
    return {
      range: rangeOf(period),
      current: current.figures,
      previous: previous.figures,
      firstPurchaseAt,
      activity: { trackedSince, trackedInRange: current.tracked },
    };
  }

  private async figures(
    window: AnalyticsWindow,
    drawId?: string,
  ): Promise<{ figures: PeriodFigures; tracked: boolean }> {
    const [countsRows, popularRows, peakRows, tracked] = await Promise.all([
      this.run<CountsRow>(this.countsQuery(window, drawId)),
      this.run<NumberTicketsRow>(this.popularNumberQuery(window, drawId)),
      this.run<PeakHourRow>(this.peakHourQuery(window, drawId)),
      this.trackedIn(window),
    ]);
    const counts = countsRows[0] ?? ZERO_COUNTS;
    const popular = popularRows[0] ?? null;
    const peak = peakRows[0] ?? null;

    let activeUsers: number | null = null;
    if (peak && tracked) {
      const rows = await this.run<ActiveUsersRow>(
        this.activeUsersAtHourQuery(window, peak.hour),
      );
      activeUsers = rows[0]?.activeUsers ?? 0;
    }

    return {
      tracked,
      figures: {
        ticketsSold: counts.ticketsSold,
        purchases: counts.purchases,
        buyers: counts.buyers,
        revenueKs: ksText(counts.revenueKs),
        popularNumber: popular
          ? { number: popular.number, tickets: popular.tickets }
          : null,
        peakHour: peak
          ? {
              hour: peak.hour,
              ticketsSold: peak.ticketsSold,
              purchasingUsers: peak.purchasingUsers,
              activeUsers,
            }
          : null,
        avgTicketsPerPurchase:
          counts.purchases > 0
            ? Math.round((counts.ticketsSold / counts.purchases) * 100) / 100
            : null,
      },
    };
  }

  private countsQuery(window: AnalyticsWindow, drawId?: string): Prisma.Sql {
    return Prisma.sql`${tag('counts')}
      SELECT
        (SELECT COUNT(*)::int FROM ${TICKETS} WHERE ${ticketScope(window, drawId)}) AS "ticketsSold",
        COUNT(*)::int AS "purchases",
        COUNT(DISTINCT p."userId")::int AS "buyers",
        COALESCE(SUM(p."total"), 0)::numeric(12,2)::text AS "revenueKs"
      FROM ${PURCHASES}
      WHERE ${purchaseScope(window, drawId)}`;
  }

  /** The number with the most tickets (tie → the smaller number string). */
  private popularNumberQuery(
    window: AnalyticsWindow,
    drawId?: string,
  ): Prisma.Sql {
    return Prisma.sql`${tag('popular-number')}
      SELECT t."number" AS "number", COUNT(*)::int AS "tickets"
      FROM ${TICKETS}
      WHERE ${ticketScope(window, drawId)}
      GROUP BY t."number"
      ORDER BY "tickets" DESC, t."number" ASC
      LIMIT 1`;
  }

  /** The MMT hour of day with the most tickets over the whole window (tie → the earlier hour). */
  private peakHourQuery(window: AnalyticsWindow, drawId?: string): Prisma.Sql {
    return Prisma.sql`${tag('peak-hour')}
      SELECT extract(hour FROM ${mmt(T_CREATED)})::int AS "hour",
        COUNT(*)::int AS "ticketsSold",
        COUNT(DISTINCT t."userId")::int AS "purchasingUsers"
      FROM ${TICKETS}
      WHERE ${ticketScope(window, drawId)}
      GROUP BY 1
      ORDER BY "ticketsSold" DESC, "hour" ASC
      LIMIT 1`;
  }

  private activeUsersAtHourQuery(
    window: AnalyticsWindow,
    hour: number,
  ): Prisma.Sql {
    return Prisma.sql`${tag('active-users-hour')}
      SELECT COUNT(DISTINCT a."userId")::int AS "activeUsers"
      FROM ${ACTIVITY}
      WHERE ${activityScope(window)}
        AND extract(hour FROM ${mmt(A_HOUR)})::int = ${hour}::int`;
  }

  /** The first PAID purchase ever — of one draw when the selection is draw-scoped. */
  private async firstPurchaseAt(drawId?: string): Promise<Date | null> {
    const rows = await this.run<FirstPurchaseRow>(
      Prisma.sql`${tag('first-purchase')}
        SELECT MIN(p."createdAt") AS "firstAt"
        FROM ${PURCHASES}
        WHERE ${purchaseScope(null, drawId)}`,
    );
    return rows[0]?.firstAt ?? null;
  }

  /** Whether any lottery_activity row falls inside the window. */
  private async trackedIn(window: AnalyticsWindow): Promise<boolean> {
    const row = await this.prisma.lotteryActivity.findFirst({
      where: { hourStart: { gte: window.start, lt: window.end } },
      select: { id: true },
    });
    return row !== null;
  }

  // ----- 2. activity ------------------------------------------------------

  /** Default period: the last 7 full MMT days; default view: hourly. */
  async activity(query: AnalyticsActivityQueryDto): Promise<AnalyticsActivity> {
    const period = resolvePeriod(query, 'last7');
    const view = query.view ?? 'hourly';
    const drawId = query.drawId;
    const tracked = await this.trackedIn(period);
    const [ticketRows, purchaseRows, activeRows] = await Promise.all([
      this.run<ActivityTicketsRow>(
        Prisma.sql`${tag('activity-tickets')}
          SELECT ${bucketKeySql(view, T_CREATED)} AS "key", COUNT(*)::int AS "ticketsSold"
          FROM ${TICKETS}
          WHERE ${ticketScope(period, drawId)}
          GROUP BY 1`,
      ),
      this.run<ActivityPurchasesRow>(
        Prisma.sql`${tag('activity-purchases')}
          SELECT ${bucketKeySql(view, P_CREATED)} AS "key",
            COUNT(*)::int AS "purchases",
            COUNT(DISTINCT p."userId")::int AS "purchasingUsers"
          FROM ${PURCHASES}
          WHERE ${purchaseScope(period, drawId)}
          GROUP BY 1`,
      ),
      tracked
        ? this.run<ActivityActiveRow>(
            Prisma.sql`${tag('activity-active')}
              SELECT ${bucketKeySql(view, A_HOUR)} AS "key",
                COUNT(DISTINCT a."userId")::int AS "activeUsers"
              FROM ${ACTIVITY}
              WHERE ${activityScope(period)}
              GROUP BY 1`,
          )
        : Promise.resolve([] as ActivityActiveRow[]),
    ]);

    const tickets = new Map(ticketRows.map((row) => [row.key, row]));
    const purchases = new Map(purchaseRows.map((row) => [row.key, row]));
    const active = new Map(activeRows.map((row) => [row.key, row]));
    const buckets = bucketKeys(view, period).map((key) => ({
      key,
      ticketsSold: tickets.get(key)?.ticketsSold ?? 0,
      purchases: purchases.get(key)?.purchases ?? 0,
      purchasingUsers: purchases.get(key)?.purchasingUsers ?? 0,
      activeUsers: tracked ? (active.get(key)?.activeUsers ?? 0) : null,
    }));
    return { view, buckets, activeUsersTracked: tracked };
  }

  // ----- 3. numbers (one draw / the period) --------------------------------

  /** Default period: all time (the reports); the dashboard always sends from/to. */
  async numbers(query: AnalyticsNumbersQueryDto): Promise<PopularNumbersPage> {
    const period = resolvePeriod(query, 'all');
    const drawId = query.drawId;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ANALYTICS_PAGE_SIZE_DEFAULT;
    const orderBy = NUMBERS_ORDER[query.sort ?? 'tickets'];
    const direction = DIRECTION[query.order ?? 'desc'];

    const [rows, totalsRows] = await Promise.all([
      this.run<NumbersPageRow>(
        Prisma.sql`${tag('numbers-page')}
          WITH "scoped" AS (
            SELECT t."number", t."userId" FROM ${TICKETS} WHERE ${ticketScope(period, drawId)}
          ), "per_user" AS (
            SELECT "number", "userId", COUNT(*)::int AS "n" FROM "scoped" GROUP BY "number", "userId"
          ), "per_number" AS (
            SELECT "number",
              SUM("n")::int AS "tickets",
              COUNT(*)::int AS "buyers",
              (COUNT(*) FILTER (WHERE "n" >= 2))::int AS "repeatBuyers"
            FROM "per_user" GROUP BY "number"
          ), "ranked" AS (
            SELECT "number", "tickets", "buyers", "repeatBuyers",
              (ROW_NUMBER() OVER (ORDER BY "tickets" DESC, "number" ASC))::int AS "rank"
            FROM "per_number"
          )
          SELECT "rank", "number", "tickets", "buyers", "repeatBuyers"
          FROM "ranked"
          ORDER BY ${orderBy} ${direction}, "number" ASC
          LIMIT ${pageSize}::int OFFSET ${(page - 1) * pageSize}::int`,
      ),
      this.run<TotalsRow>(this.totalsQuery('numbers-totals', period, drawId)),
    ]);
    const totals = totalsRows[0] ?? { total: 0, totalTickets: 0 };
    const trends = await this.trendsFor(period, drawId, rows);
    return {
      items: rows.map((row) => ({
        rank: row.rank,
        number: row.number,
        tickets: row.tickets,
        buyers: row.buyers,
        share: share(row.tickets, totals.totalTickets),
        repeatBuyers: row.repeatBuyers,
        trend: trends.get(row.number) ?? NO_TREND,
      })),
      total: totals.total,
      totalTickets: totals.totalTickets,
      page,
      pageSize,
    };
  }

  /** Distinct numbers and all tickets in a selection — the page total and the share's denominator. */
  private totalsQuery(
    name: 'numbers-totals' | 'across-totals',
    window: AnalyticsWindow | null,
    drawId?: string,
  ): Prisma.Sql {
    return Prisma.sql`${tag(name)}
      SELECT COUNT(DISTINCT t."number")::int AS "total", COUNT(*)::int AS "totalTickets"
      FROM ${TICKETS}
      WHERE ${ticketScope(window, drawId)}`;
  }

  /**
   * The comparison-period tickets of the page's numbers, as trends. All
   * time has no comparison period, so every trend is "—"; otherwise a
   * number that sold nothing before is "New" only when history fully
   * covers the comparison period, else "No earlier data" (null).
   */
  private async trendsFor(
    period: AnalyticsPeriod | null,
    drawId: string | undefined,
    current: NumberTicketsRow[],
  ): Promise<Map<string, NumberTrend>> {
    const trends = new Map<string, NumberTrend>();
    if (!period || current.length === 0) return trends;
    const numbers = current.map((row) => row.number);
    const [firstPurchaseAt, previousRows] = await Promise.all([
      this.firstPurchaseAt(drawId),
      this.run<NumberTicketsRow>(
        Prisma.sql`${tag('numbers-previous')}
          SELECT t."number" AS "number", COUNT(*)::int AS "tickets"
          FROM ${TICKETS}
          WHERE ${ticketScope(period.previous, drawId)}
            AND t."number" IN (${Prisma.join(numbers)})
          GROUP BY t."number"`,
      ),
    ]);
    const previous = new Map(
      previousRows.map((row) => [row.number, row.tickets]),
    );
    const covered = hasEarlierData(firstPurchaseAt, period.previous.from);
    for (const { number, tickets } of current) {
      const prev = previous.get(number) ?? 0;
      if (prev > 0) {
        trends.set(number, {
          previousTickets: prev,
          changePct: changePct(tickets, prev),
          isNew: false,
        });
      } else if (covered) {
        trends.set(number, {
          previousTickets: 0,
          changePct: null,
          isNew: true,
        });
      } else {
        trends.set(number, NO_TREND);
      }
    }
    return trends;
  }

  // ----- 4. numbers across all draws ---------------------------------------

  /** Never draw-scoped; default period: all time. */
  async numbersAcross(
    query: AnalyticsNumbersAcrossQueryDto,
  ): Promise<AcrossNumbersPage> {
    const period = resolvePeriod(query, 'all');
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ANALYTICS_PAGE_SIZE_DEFAULT;
    const orderBy = ACROSS_ORDER[query.sort ?? 'tickets'];
    const direction = DIRECTION[query.order ?? 'desc'];

    const [rows, totalsRows] = await Promise.all([
      this.run<AcrossPageRow>(
        Prisma.sql`${tag('across-page')}
          WITH "scoped" AS (
            SELECT t."number", t."userId", t."drawId" FROM ${TICKETS} WHERE ${ticketScope(period)}
          ), "per_draw" AS (
            SELECT "number", "drawId", COUNT(*)::int AS "tickets" FROM "scoped" GROUP BY "number", "drawId"
          ), "draw_ranked" AS (
            SELECT "number", "drawId",
              (ROW_NUMBER() OVER (PARTITION BY "drawId" ORDER BY "tickets" DESC, "number" ASC))::int AS "drawRank"
            FROM "per_draw"
          ), "best" AS (
            SELECT DISTINCT ON (r."number") r."number", r."drawRank" AS "bestRank", d."drawNo" AS "bestDrawNo"
            FROM "draw_ranked" r JOIN "lottery_draws" d ON d."id" = r."drawId"
            ORDER BY r."number", r."drawRank" ASC, d."drawNo" DESC
          ), "per_number" AS (
            SELECT "number",
              COUNT(*)::int AS "tickets",
              COUNT(DISTINCT "userId")::int AS "buyers",
              COUNT(DISTINCT "drawId")::int AS "drawsPlayed"
            FROM "scoped" GROUP BY "number"
          ), "ranked" AS (
            SELECT n."number", n."tickets", n."buyers", n."drawsPlayed", b."bestRank", b."bestDrawNo",
              (ROW_NUMBER() OVER (ORDER BY n."tickets" DESC, n."number" ASC))::int AS "rank"
            FROM "per_number" n LEFT JOIN "best" b ON b."number" = n."number"
          )
          SELECT "rank", "number", "tickets", "buyers", "drawsPlayed", "bestRank", "bestDrawNo"
          FROM "ranked"
          ORDER BY ${orderBy} ${direction}, "number" ASC
          LIMIT ${pageSize}::int OFFSET ${(page - 1) * pageSize}::int`,
      ),
      this.run<TotalsRow>(this.totalsQuery('across-totals', period)),
    ]);
    const totals = totalsRows[0] ?? { total: 0, totalTickets: 0 };
    return {
      items: rows.map((row) => ({
        rank: row.rank,
        number: row.number,
        tickets: row.tickets,
        buyers: row.buyers,
        share: share(row.tickets, totals.totalTickets),
        drawsPlayed: row.drawsPlayed,
        bestRank:
          row.bestRank !== null && row.bestDrawNo !== null
            ? { rank: row.bestRank, drawNo: row.bestDrawNo }
            : null,
      })),
      total: totals.total,
      totalTickets: totals.totalTickets,
      page,
      pageSize,
    };
  }

  // ----- 5. purchase frequency / repeat vs first-time ----------------------

  /**
   * Default period: all time. With a window and/or a draw, first-time =
   * the earliest PAID purchase ever is inside the selection (the contract's
   * rule). With neither — the reports' default — that rule makes everyone
   * first-time, so returning is counted as "bought in two or more draws"
   * instead and the response says which definition it used.
   */
  async frequency(query: AnalyticsPeriodQueryDto): Promise<AnalyticsFrequency> {
    const period = resolvePeriod(query, 'all');
    const drawId = query.drawId;
    const definition: RepeatDefinition =
      period === null && !drawId ? 'draws-played' : 'earliest-purchase';
    const [binRows, returning] = await Promise.all([
      this.run<FrequencyBinsRow>(
        Prisma.sql`${tag('frequency-bins')}
          WITH "per_user" AS (
            SELECT p."userId", COUNT(*)::int AS "n" FROM ${PURCHASES}
            WHERE ${purchaseScope(period, drawId)} GROUP BY p."userId"
          )
          SELECT COUNT(*)::int AS "totalBuyers",
            (COUNT(*) FILTER (WHERE "n" = 1))::int AS "one",
            (COUNT(*) FILTER (WHERE "n" BETWEEN 2 AND 3))::int AS "twoToThree",
            (COUNT(*) FILTER (WHERE "n" BETWEEN 4 AND 9))::int AS "fourToNine",
            (COUNT(*) FILTER (WHERE "n" >= 10))::int AS "tenPlus"
          FROM "per_user"`,
      ),
      definition === 'draws-played'
        ? this.returningByDrawsPlayed()
        : this.returningByEarliestPurchase(period, drawId),
    ]);
    const bins = binRows[0] ?? {
      totalBuyers: 0,
      one: 0,
      twoToThree: 0,
      fourToNine: 0,
      tenPlus: 0,
    };
    const counts: Record<FrequencyBinKey, number> = {
      '1': bins.one,
      '2-3': bins.twoToThree,
      '4-9': bins.fourToNine,
      '10+': bins.tenPlus,
    };
    const returningCount = Math.min(bins.totalBuyers, returning);
    return {
      bins: FREQUENCY_BIN_KEYS.map((key) => ({
        key,
        users: counts[key],
        share: share(counts[key], bins.totalBuyers),
      })),
      totalBuyers: bins.totalBuyers,
      firstTime: bins.totalBuyers - returningCount,
      returning: returningCount,
      definition,
    };
  }

  /** Selection buyers whose earliest PAID purchase ever is NOT inside the selection. */
  private async returningByEarliestPurchase(
    period: AnalyticsPeriod | null,
    drawId: string | undefined,
  ): Promise<number> {
    const rows = await this.run<FirstTimeRow>(
      Prisma.sql`${tag('frequency-first-time')}
        WITH "buyers" AS (
          SELECT DISTINCT p."userId" FROM ${PURCHASES} WHERE ${purchaseScope(period, drawId)}
        ), "firsts" AS (
          SELECT DISTINCT ON (p."userId") p."userId", p."createdAt", p."drawId"
          FROM ${PURCHASES} JOIN "buyers" b ON b."userId" = p."userId"
          WHERE p."status" = ${PAID}
          ORDER BY p."userId", p."createdAt" ASC, p."id" ASC
        )
        SELECT COUNT(*)::int AS "buyers",
          (COUNT(*) FILTER (WHERE ${this.firstInSelection(period, drawId)}))::int AS "firstTime"
        FROM "firsts"`,
    );
    const row = rows[0];
    return row ? Math.max(0, row.buyers - row.firstTime) : 0;
  }

  /** All time, all draws: buyers with PAID purchases in two or more distinct draws. */
  private async returningByDrawsPlayed(): Promise<number> {
    const rows = await this.run<DrawsPlayedRow>(
      Prisma.sql`${tag('frequency-draws-played')}
        WITH "per_user" AS (
          SELECT p."userId", COUNT(DISTINCT p."drawId")::int AS "draws"
          FROM ${PURCHASES} WHERE ${purchaseScope(null)} GROUP BY p."userId"
        )
        SELECT COUNT(*)::int AS "buyers",
          (COUNT(*) FILTER (WHERE "draws" >= 2))::int AS "returning"
        FROM "per_user"`,
    );
    return rows[0]?.returning ?? 0;
  }

  /** "The earliest purchase ever is inside the selection": the window (when any) and the draw (when any). */
  private firstInSelection(
    window: AnalyticsWindow | null,
    drawId?: string,
  ): Prisma.Sql {
    const parts = inWindow(Prisma.sql`"createdAt"`, window);
    if (drawId) parts.push(Prisma.sql`"drawId" = ${drawId}`);
    return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
  }

  // ----- 6. heatmap -------------------------------------------------------

  /** Default period: all time. Both measures per cell; 168 cells zero-filled. */
  async heatmap(query: AnalyticsPeriodQueryDto): Promise<AnalyticsHeatmap> {
    const period = resolvePeriod(query, 'all');
    const rows = await this.run<HeatmapRow>(
      Prisma.sql`${tag('heatmap')}
        SELECT (extract(isodow FROM ${mmt(T_CREATED)})::int - 1) AS "weekday",
          extract(hour FROM ${mmt(T_CREATED)})::int AS "hour",
          COUNT(*)::int AS "ticketsSold",
          COUNT(DISTINCT t."userId")::int AS "purchasingUsers"
        FROM ${TICKETS}
        WHERE ${ticketScope(period, query.drawId)}
        GROUP BY 1, 2`,
    );
    const byCell = new Map(
      rows.map((row) => [`${row.weekday}:${row.hour}`, row]),
    );
    const cells: HeatmapCell[] = [];
    for (let weekday = 0; weekday < WEEKDAY_KEYS.length; weekday++) {
      for (let hour = 0; hour < HOUR_KEYS.length; hour++) {
        const row = byCell.get(`${weekday}:${hour}`);
        cells.push({
          weekday,
          hour,
          ticketsSold: row?.ticketsSold ?? 0,
          purchasingUsers: row?.purchasingUsers ?? 0,
        });
      }
    }
    return { cells };
  }

  // ----- 7. purchases before close ----------------------------------------

  /** One draw: the given one, else the most recent closed or published draw; 404 when there is none. */
  async beforeClose(
    query: AnalyticsBeforeCloseQueryDto,
  ): Promise<AnalyticsBeforeClose> {
    const draw = query.drawId
      ? await this.prisma.lotteryDraw.findUnique({
          where: { id: query.drawId },
        })
      : await this.prisma.lotteryDraw.findFirst({
          where: { status: { in: [...FINISHED_STATUSES] } },
          orderBy: [{ drawAt: 'desc' }, { drawNo: 'desc' }],
        });
    if (!draw) throw drawNotFound();

    const edges = beforeCloseEdges(draw.salesCloseAt);
    const binColumns = BEFORE_CLOSE_BINS.map((_, index) => {
      const lower = Prisma.sql`t."createdAt" >= ${edges[index]}`;
      const isLast = index === BEFORE_CLOSE_BINS.length - 1;
      const predicate = isLast
        ? lower
        : Prisma.sql`${lower} AND t."createdAt" < ${edges[index + 1]}`;
      return Prisma.sql`(COUNT(*) FILTER (WHERE ${predicate}))::int AS ${Prisma.raw(`"b${index}"`)}`;
    });
    const rows = await this.run<BeforeCloseRow>(
      Prisma.sql`${tag('before-close')}
        SELECT COUNT(*)::int AS "total",
          (COUNT(*) FILTER (WHERE t."createdAt" < ${edges[0]}))::int AS "earlier",
          ${Prisma.join(binColumns, ', ')}
        FROM ${TICKETS}
        WHERE ${ticketScope(null, draw.id)}`,
    );
    const row = rows[0] ?? {};
    return {
      draw: {
        id: draw.id,
        drawNo: draw.drawNo,
        thaiDrawDate: toDateString(draw.thaiDrawDate),
        status: drawStatusToWire(draw.status),
        salesCloseAt: draw.salesCloseAt,
      },
      closed: FINISHED_STATUSES.includes(draw.status),
      bins: BEFORE_CLOSE_BINS.map((bin, index) => ({
        key: bin.key,
        tickets: row[`b${index}`] ?? 0,
        hours: bin.hours,
      })),
      earlier: row.earlier ?? 0,
      total: row.total ?? 0,
    };
  }

  // ----- 8. draw comparison -----------------------------------------------

  /** Every draw newest first with its sales figures and peak hour (one stats query per page). */
  async draws(query: AnalyticsDrawsQueryDto): Promise<DrawComparisonPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? ANALYTICS_DRAWS_PAGE_SIZE_DEFAULT;
    const [rows, total] = await Promise.all([
      this.prisma.lotteryDraw.findMany({
        orderBy: [{ drawAt: 'desc' }, { drawNo: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lotteryDraw.count(),
    ]);
    const stats = await this.drawStats(rows.map((row) => row.id));
    return {
      items: rows.map((draw) => this.comparisonRow(draw, stats.get(draw.id))),
      total,
      page,
      pageSize,
    };
  }

  private async drawStats(ids: string[]): Promise<Map<string, DrawStatsRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.run<DrawStatsRow>(
      Prisma.sql`${tag('draw-stats')}
        SELECT d."id" AS "drawId",
          (SELECT COUNT(*)::int FROM ${TICKETS} WHERE t."drawId" = d."id" AND p."status" = ${PAID}) AS "tickets",
          (SELECT COUNT(DISTINCT p."userId")::int FROM ${PURCHASES} WHERE p."drawId" = d."id" AND p."status" = ${PAID}) AS "buyers",
          (SELECT COALESCE(SUM(p."total"), 0)::numeric(12,2)::text FROM ${PURCHASES} WHERE p."drawId" = d."id" AND p."status" = ${PAID}) AS "revenueKs",
          (SELECT extract(hour FROM ${mmt(T_CREATED)})::int FROM ${TICKETS}
            WHERE t."drawId" = d."id" AND p."status" = ${PAID}
            GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 1) AS "peakHour"
        FROM "lottery_draws" d
        WHERE d."id" IN (${Prisma.join(ids)})`,
    );
    return new Map(rows.map((row) => [row.drawId, row]));
  }

  private comparisonRow(
    draw: LotteryDraw,
    stats: DrawStatsRow | undefined,
  ): DrawComparisonRow {
    return {
      id: draw.id,
      drawNo: draw.drawNo,
      thaiDrawDate: toDateString(draw.thaiDrawDate),
      status: drawStatusToWire(draw.status),
      openedAt: draw.openedAt,
      salesCloseAt: draw.salesCloseAt,
      tickets: stats?.tickets ?? 0,
      buyers: stats?.buyers ?? 0,
      revenueKs: ksText(stats?.revenueKs ?? null),
      peakHour: stats?.peakHour ?? null,
      winnersCount: draw.winnersCount,
      prizesPaidKs:
        draw.prizesPaidKs === null ? null : ksText(draw.prizesPaidKs),
    };
  }

  // ----- plumbing ---------------------------------------------------------

  /** Every aggregate goes through here: one Sql object in, typed rows out. */
  private run<T>(query: Prisma.Sql): Promise<T[]> {
    return this.prisma.$queryRaw<T[]>(query);
  }
}

function rangeOf(period: AnalyticsPeriod): AnalyticsRange {
  return {
    from: period.from,
    to: period.to,
    previousFrom: period.previous.from,
    previousTo: period.previous.to,
  };
}
