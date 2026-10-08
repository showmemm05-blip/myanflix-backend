import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { TransactionType } from '../generated/prisma/client';
import { processTimeZone } from '../finance/finance.service';

/** Revenue-bearing transaction types — purchases (historical) and subscriptions (current). */
const REVENUE_TRANSACTION_TYPES = [
  TransactionType.PURCHASE,
  TransactionType.SUBSCRIPTION,
];

const TOP_N = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
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

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * `includeRevenue` is the caller's FINANCE.VIEW: without it the revenue
   * aggregate is not even run and `revenue` comes back null, so a
   * dashboard-only role gets every other stat and no money figure.
   */
  async getOverview({ includeRevenue }: { includeRevenue: boolean }) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    const [
      totalViews,
      completionAgg,
      popularMovies,
      registrationsLast7Days,
      registrationsLast30Days,
      revenueAgg,
      totalMovies,
      totalUsers,
      activeUsers,
    ] = await Promise.all([
      this.prisma.watchHistory.count(),
      this.prisma.watchHistory.aggregate({
        _avg: { progress: true, lastPosition: true },
      }),
      this.getPopularMovies(),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      includeRevenue
        ? this.prisma.transaction.aggregate({
            _sum: { amount: true },
            where: { type: { in: REVENUE_TRANSACTION_TYPES } },
          })
        : null,
      this.prisma.movie.count(),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
    ]);

    return {
      totalViews,
      averageCompletionRate:
        Math.round((completionAgg._avg.progress ?? 0) * 100) / 100,
      averageWatchDurationSeconds: Math.round(
        completionAgg._avg.lastPosition ?? 0,
      ),
      popularMovies,
      userRegistrations: {
        last7Days: registrationsLast7Days,
        last30Days: registrationsLast30Days,
      },
      revenue: revenueAgg ? decimalToNumber(revenueAgg._sum.amount) : null,
      totalMovies,
      totalUsers,
      activeUsers,
    };
  }

  /** New signups per month + a running total (proxy for "active users") for the growth chart. */
  async getUserGrowthTrend(monthsBack = 12) {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth() - (monthsBack - 1),
      1,
    );

    // be-cat-19: Postgres counts sign-ups per month (at most monthsBack
    // rows) instead of sending every new user's createdAt here. The month
    // is taken in this process's timezone — the same local month the
    // JavaScript getFullYear()/getMonth() bucketing used (UTC in the
    // backend container). month is 0-based to match getMonth().
    const [monthCounts, activeBeforeRange] = await Promise.all([
      this.prisma.$queryRaw<{ year: number; month: number; count: number }[]>`
        SELECT
          extract(year FROM "localCreatedAt")::int AS "year",
          extract(month FROM "localCreatedAt")::int - 1 AS "month",
          count(*)::int AS "count"
        FROM (
          SELECT ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${processTimeZone()} AS "localCreatedAt"
          FROM "users"
          WHERE "createdAt" >= ${start}
        ) AS "inRange"
        GROUP BY 1, 2`,
      this.prisma.user.count({ where: { createdAt: { lt: start } } }),
    ]);

    const newUsersByMonthKey = new Map<string, number>();
    for (const row of monthCounts) {
      const key = `${row.year}-${row.month}`;
      newUsersByMonthKey.set(
        key,
        (newUsersByMonthKey.get(key) ?? 0) + row.count,
      );
    }

    let runningTotal = activeBeforeRange;
    const result: { label: string; newUsers: number; activeUsers: number }[] =
      [];
    for (let i = 0; i < monthsBack; i++) {
      const date = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const newUsers = newUsersByMonthKey.get(key) ?? 0;
      runningTotal += newUsers;
      result.push({
        label: MONTH_LABELS[date.getMonth()],
        newUsers,
        activeUsers: runningTotal,
      });
    }

    return result;
  }

  private async getPopularMovies() {
    const grouped = await this.prisma.watchHistory.groupBy({
      by: ['movieId'],
      _count: { _all: true },
      _avg: { progress: true },
      orderBy: { _count: { movieId: 'desc' } },
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
      viewCount: g._count._all,
      averageCompletionRate: Math.round((g._avg.progress ?? 0) * 100) / 100,
    }));
  }
}
