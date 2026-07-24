import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { Prisma } from '../generated/prisma/client';

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
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard() {
    const [
      totalRevenueAgg,
      monthlyRevenueAgg,
      dailyRevenueAgg,
      topMovies,
      topUsers,
    ] = await Promise.all([
      this.prisma.purchase.aggregate({ _sum: { amount: true } }),
      this.prisma.purchase.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: startOfMonth() } },
      }),
      this.prisma.purchase.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: startOfToday() } },
      }),
      this.getTopMovies(),
      this.getTopUsers(),
    ]);

    return {
      totalRevenue: decimalToNumber(totalRevenueAgg._sum.amount),
      monthlyRevenue: decimalToNumber(monthlyRevenueAgg._sum.amount),
      dailyRevenue: decimalToNumber(dailyRevenueAgg._sum.amount),
      topMovies,
      topUsers,
    };
  }

  /** Daily/weekly/monthly revenue series for the admin dashboard's trend chart. */
  async getRevenueTrend() {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const purchases = await this.prisma.purchase.findMany({
      where: { createdAt: { gte: oneYearAgo } },
      select: { amount: true, createdAt: true },
    });

    return {
      daily: this.bucketRevenue(purchases, 14, DAILY_GRANULARITY),
      weekly: this.bucketRevenue(purchases, 12, WEEKLY_GRANULARITY),
      monthly: this.bucketRevenue(purchases, 12, MONTHLY_GRANULARITY),
    };
  }

  private bucketRevenue(
    purchases: { amount: Prisma.Decimal; createdAt: Date }[],
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

    for (const purchase of purchases) {
      const key = granularity.key(purchase.createdAt);
      const bucket = buckets.get(key);
      if (bucket) bucket.revenue += decimalToNumber(purchase.amount);
    }

    return [...buckets.values()]
      .sort((a, b) => a.sortDate.getTime() - b.sortDate.getTime())
      .map(({ label, revenue }) => ({ label, revenue: Math.round(revenue) }));
  }

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
    const movieById = new Map(movies.map((m) => [m.id, m]));

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
      select: { id: true, username: true, email: true, avatar: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    return grouped.map((g) => ({
      user: userById.get(g.userId) ?? null,
      totalSpent: decimalToNumber(g._sum.amount),
      purchaseCount: g._count._all,
    }));
  }
}
