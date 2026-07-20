import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';

const TOP_N = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
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
      this.prisma.watchHistory.aggregate({ _avg: { progress: true, lastPosition: true } }),
      this.getPopularMovies(),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.purchase.aggregate({ _sum: { amount: true } }),
      this.prisma.movie.count(),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: 'ACTIVE' } }),
    ]);

    return {
      totalViews,
      averageCompletionRate: Math.round((completionAgg._avg.progress ?? 0) * 100) / 100,
      averageWatchDurationSeconds: Math.round(completionAgg._avg.lastPosition ?? 0),
      popularMovies,
      userRegistrations: {
        last7Days: registrationsLast7Days,
        last30Days: registrationsLast30Days,
      },
      revenue: decimalToNumber(revenueAgg._sum.amount),
      totalMovies,
      totalUsers,
      activeUsers,
    };
  }

  /** New signups per month + a running total (proxy for "active users") for the growth chart. */
  async getUserGrowthTrend(monthsBack = 12) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);

    const [usersInRange, activeBeforeRange] = await Promise.all([
      this.prisma.user.findMany({
        where: { createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      this.prisma.user.count({ where: { createdAt: { lt: start } } }),
    ]);

    const newUsersByMonthKey = new Map<string, number>();
    for (const user of usersInRange) {
      const key = `${user.createdAt.getFullYear()}-${user.createdAt.getMonth()}`;
      newUsersByMonthKey.set(key, (newUsersByMonthKey.get(key) ?? 0) + 1);
    }

    let runningTotal = activeBeforeRange;
    const result: { label: string; newUsers: number; activeUsers: number }[] = [];
    for (let i = 0; i < monthsBack; i++) {
      const date = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const newUsers = newUsersByMonthKey.get(key) ?? 0;
      runningTotal += newUsers;
      result.push({ label: MONTH_LABELS[date.getMonth()], newUsers, activeUsers: runningTotal });
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
    const movieById = new Map(movies.map((m) => [m.id, m]));

    return grouped.map((g) => ({
      movie: movieById.get(g.movieId) ?? null,
      viewCount: g._count._all,
      averageCompletionRate: Math.round((g._avg.progress ?? 0) * 100) / 100,
    }));
  }
}
