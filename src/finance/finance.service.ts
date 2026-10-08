import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { Prisma, TransactionType } from '../generated/prisma/client';

/** Revenue-bearing transaction types — everything that ever put money in, purchases (historical) and subscriptions (current). */
const REVENUE_TRANSACTION_TYPES = [
  TransactionType.PURCHASE,
  TransactionType.SUBSCRIPTION,
];

/** `"type" IN (...)` for the revenue types, as bound, enum-cast parameters. */
const REVENUE_TYPES_SQL = Prisma.join(
  REVENUE_TRANSACTION_TYPES.map(
    (type) => Prisma.sql`${type}::"TransactionType"`,
  ),
);

/**
 * The IANA timezone this process's local-time getters use (`TZ`; UTC in the
 * backend container). The weekly and monthly chart buckets are keyed in it.
 */
export function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * How finely getRevenueTrend's SQL groups transactions so every chart key
 * stays exact. 'day' when this process's UTC offset is the same all year
 * (UTC — the backend container — or a zone without daylight saving, such as
 * Asia/Yangon). Under daylight saving, weekNumber() counts milliseconds
 * since local 1 January, so its day boundary can fall away from local
 * midnight: grouping by the hour keeps it exact when every offset is a whole
 * number of hours, and by the minute when one is not (e.g. Australia/
 * Adelaide at +9:30/+10:30, or Lord_Howe at +10:30/+11).
 */
export function revenueGroupUnit(now = new Date()): 'day' | 'hour' | 'minute' {
  const year = now.getFullYear();
  return groupUnitForOffsets(
    [year - 1, year].flatMap((y) =>
      [0, 6].map((month) => new Date(y, month, 1).getTimezoneOffset()),
    ),
  );
}

/** revenueGroupUnit's rule, given the zone's UTC offsets in minutes. */
export function groupUnitForOffsets(
  offsets: number[],
): 'day' | 'hour' | 'minute' {
  if (new Set(offsets).size === 1) return 'day';
  return offsets.every((offset) => offset % 60 === 0) ? 'hour' : 'minute';
}

/** One SQL row of getRevenueTrend: a group's revenue and one of its timestamps. */
export interface RevenueDayRow {
  amount: Prisma.Decimal;
  createdAt: Date;
}

const TOP_N = 5;
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(): Date {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** ISO-ish week number (Mon-start) — only needs to be consistent, not calendar-perfect. */
function weekNumber(date: Date): number {
  const first = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor(
    (date.getTime() - first.getTime()) / (24 * 60 * 60 * 1000),
  );
  return Math.ceil((days + first.getDay() + 1) / 7);
}

interface RevenueBucketGranularity {
  key: (date: Date) => string;
  label: (date: Date) => string;
  stepBack: (date: Date, steps: number) => Date;
}

const DAILY_GRANULARITY: RevenueBucketGranularity = {
  key: (date) => date.toISOString().slice(0, 10),
  label: (date) =>
    `${MONTH_LABELS[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}`,
  stepBack: (date, steps) =>
    new Date(date.getTime() - steps * 24 * 60 * 60 * 1000),
};

const WEEKLY_GRANULARITY: RevenueBucketGranularity = {
  key: (date) => `${date.getFullYear()}-W${weekNumber(date)}`,
  label: (date) => `Wk ${weekNumber(date)}`,
  stepBack: (date, steps) =>
    new Date(date.getTime() - steps * 7 * 24 * 60 * 60 * 1000),
};

const MONTHLY_GRANULARITY: RevenueBucketGranularity = {
  key: (date) => `${date.getFullYear()}-${date.getMonth()}`,
  label: (date) => MONTH_LABELS[date.getMonth()],
  stepBack: (date, steps) => {
    const shifted = new Date(date);
    shifted.setMonth(shifted.getMonth() - steps);
    return shifted;
  },
};

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  async getDashboard() {
    const [totals, topMovies, topUsers] = await Promise.all([
      this.getRevenueTotals(),
      this.getTopMovies(),
      this.getTopUsers(),
    ]);

    return {
      totalRevenue: decimalToNumber(totals?.total),
      monthlyRevenue: decimalToNumber(totals?.month),
      dailyRevenue: decimalToNumber(totals?.today),
      topMovies,
      topUsers,
    };
  }

  /**
   * All-time, this-month and today revenue in ONE pass over the revenue
   * rows (bam-02) — it used to be three separate SUMs, the all-time one a
   * full table scan of its own. Same rows, same exact numeric sums: each
   * total is NULL (shown as 0) when no row matches, exactly as before.
   */
  private async getRevenueTotals() {
    const rows = await this.prisma.$queryRaw<
      {
        total: Prisma.Decimal | null;
        month: Prisma.Decimal | null;
        today: Prisma.Decimal | null;
      }[]
    >`
      SELECT
        sum("amount") AS "total",
        sum("amount") FILTER (WHERE "createdAt" >= ${startOfMonth()}) AS "month",
        sum("amount") FILTER (WHERE "createdAt" >= ${startOfToday()}) AS "today"
      FROM "transactions"
      WHERE "type" IN (${REVENUE_TYPES_SQL})`;
    return rows[0];
  }

  /** Daily/weekly/monthly revenue series for the admin dashboard's trend chart. */
  async getRevenueTrend() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    // bam-01: Postgres sums the year into day rows (about 366; hour or
    // minute rows only under daylight saving, see revenueGroupUnit) instead of sending
    // every revenue transaction here. Each row groups the transactions that
    // share BOTH their UTC day (the DAILY key) and their date in this
    // process's timezone (the WEEKLY/MONTHLY keys), and carries the earliest
    // real createdAt of the group, so every bucket key below comes out
    // exactly as it did for each single transaction. In the container
    // (TZ=UTC) the two dates are the same day.
    const transactions = await this.prisma.$queryRaw<RevenueDayRow[]>`
      SELECT sum("amount")::numeric AS "amount", min("createdAt") AS "createdAt"
      FROM "transactions"
      WHERE "type" IN (${REVENUE_TYPES_SQL})
        AND "createdAt" >= ${oneYearAgo}
      GROUP BY
        date_trunc(${revenueGroupUnit()}, "createdAt"),
        date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${processTimeZone()})`;

    return {
      daily: this.bucketRevenue(transactions, 14, DAILY_GRANULARITY),
      weekly: this.bucketRevenue(transactions, 12, WEEKLY_GRANULARITY),
      monthly: this.bucketRevenue(transactions, 12, MONTHLY_GRANULARITY),
    };
  }

  private bucketRevenue(
    transactions: { amount: Prisma.Decimal; createdAt: Date }[],
    bucketCount: number,
    granularity: RevenueBucketGranularity,
  ) {
    const buckets = new Map<
      string,
      { label: string; revenue: number; sortDate: Date }
    >();
    const now = new Date();

    // Seed every bucket (including empty ones) so the chart has a continuous axis.
    for (let i = bucketCount - 1; i >= 0; i--) {
      const date = granularity.stepBack(now, i);
      const key = granularity.key(date);
      if (!buckets.has(key)) {
        buckets.set(key, {
          label: granularity.label(date),
          revenue: 0,
          sortDate: date,
        });
      }
    }

    for (const transaction of transactions) {
      const key = granularity.key(transaction.createdAt);
      const bucket = buckets.get(key);
      if (bucket) bucket.revenue += decimalToNumber(transaction.amount);
    }

    return [...buckets.values()]
      .sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
      .map(({ label, revenue }) => ({ label, revenue: Math.round(revenue) }));
  }

  /**
   * Stays sourced from the (now-historical, frozen) Purchase table —
   * subscription revenue has no per-movie attribution, so "top movies by
   * revenue" can only ever reflect direct-purchase history going forward.
   */
  private async getTopMovies() {
    const grouped = await this.prisma.purchase.groupBy({
      by: ['movieId'],
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: TOP_N,
    });

    const movies = await this.prisma.movie.findMany({
      where: { id: { in: grouped.map((g) => g.movieId) } },
      select: { id: true, title: true, posterUrl: true },
    });
    const movieById = new Map(
      movies.map((m) => [
        m.id,
        // Persisted poster URLs carry whatever host uploaded them; re-hosted
        // per request here, same as everywhere else (MinioService.imageUrl).
        { ...m, posterUrl: this.minioService.imageUrl(m.posterUrl) },
      ]),
    );

    return grouped.map((g) => ({
      movie: movieById.get(g.movieId) ?? null,
      revenue: decimalToNumber(g._sum.amount),
      purchaseCount: g._count._all,
    }));
  }

  private async getTopUsers() {
    const grouped = await this.prisma.purchase.groupBy({
      by: ['userId'],
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: TOP_N,
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.userId) } },
      select: { id: true, username: true, displayName: true, avatar: true },
    });
    const userById = new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatar ? this.minioService.playbackUrl(u.avatar) : null,
        },
      ]),
    );

    return grouped.map((g) => ({
      user: userById.get(g.userId) ?? null,
      totalSpent: decimalToNumber(g._sum.amount),
      purchaseCount: g._count._all,
    }));
  }
}
