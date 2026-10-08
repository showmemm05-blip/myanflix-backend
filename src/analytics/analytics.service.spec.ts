import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { processTimeZone } from '../finance/finance.service';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService.getOverview', () => {
  let service: AnalyticsService;
  let prisma: {
    watchHistory: {
      count: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    user: { count: jest.Mock };
    transaction: { aggregate: jest.Mock };
    movie: { count: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      watchHistory: {
        count: jest.fn().mockResolvedValue(3),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { progress: 0.5, lastPosition: 60 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: { count: jest.fn().mockResolvedValue(2) },
      transaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: new Prisma.Decimal(4500) } }),
      },
      movie: {
        count: jest.fn().mockResolvedValue(7),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: { imageUrl: jest.fn() } },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  it('reports revenue to a caller allowed to see it', async () => {
    const overview = await service.getOverview({ includeRevenue: true });
    expect(overview.revenue).toBe(4500);
    expect(overview.totalMovies).toBe(7);
  });

  it('never reads or returns revenue for a dashboard-only caller (H-26)', async () => {
    const overview = await service.getOverview({ includeRevenue: false });
    expect(overview.revenue).toBeNull();
    expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
    // The non-money stats the dashboard cards need are all still there.
    expect(overview).toMatchObject({
      totalViews: 3,
      totalMovies: 7,
      totalUsers: 2,
      activeUsers: 2,
    });
  });
});

/**
 * be-cat-19 parity: the OLD getUserGrowthTrend loaded every new user's
 * createdAt and bucketed it with getFullYear()/getMonth(); the NEW one gets
 * per-month counts from SQL. oldGrowthTrend below is the old code, kept
 * verbatim as the reference.
 */
describe('AnalyticsService.getUserGrowthTrend — SQL month counts (be-cat-19)', () => {
  const NOW = new Date('2026-10-07T10:30:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const LABELS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

  let service: AnalyticsService;
  let prisma: { user: { count: jest.Mock }; $queryRaw: jest.Mock };

  function oldGrowthTrend(createdAts: Date[], monthsBack = 12) {
    const now = new Date();
    const start = new Date(
      now.getFullYear(),
      now.getMonth() - (monthsBack - 1),
      1,
    );
    const usersInRange = createdAts.filter((d) => d >= start);
    const activeBeforeRange = createdAts.filter((d) => d < start).length;
    const newUsersByMonthKey = new Map<string, number>();
    for (const createdAt of usersInRange) {
      const key = `${createdAt.getFullYear()}-${createdAt.getMonth()}`;
      newUsersByMonthKey.set(key, (newUsersByMonthKey.get(key) ?? 0) + 1);
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
        label: LABELS[date.getMonth()],
        newUsers,
        activeUsers: runningTotal,
      });
    }
    return result;
  }

  /** What the SQL returns: one row per local (year, 0-based month) since `start`. */
  function monthCountsLikeSql(createdAts: Date[], start: Date) {
    const counts = new Map<
      string,
      { year: number; month: number; count: number }
    >();
    for (const d of createdAts) {
      if (d < start) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const row = counts.get(key) ?? {
        year: d.getFullYear(),
        month: d.getMonth(),
        count: 0,
      };
      row.count += 1;
      counts.set(key, row);
    }
    return [...counts.values()];
  }

  function seedUsers(): Date[] {
    const dates: Date[] = [];
    let seed = 7;
    for (let i = 0; i < 3000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      dates.push(
        new Date(NOW.getTime() - Math.floor((seed / 2147483648) * 500 * DAY)),
      );
    }
    // Either side of a month boundary in UTC.
    dates.push(new Date('2026-08-31T23:59:59.999Z'));
    dates.push(new Date('2026-09-01T00:00:00.000Z'));
    return dates;
  }

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW });
    prisma = { user: { count: jest.fn() }, $queryRaw: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: { imageUrl: jest.fn() } },
      ],
    }).compile();
    service = module.get(AnalyticsService);
  });
  afterEach(() => jest.useRealTimers());

  it('gives the same chart as bucketing every user in JavaScript', async () => {
    const createdAts = seedUsers();
    const start = new Date(NOW.getFullYear(), NOW.getMonth() - 11, 1);
    prisma.$queryRaw.mockResolvedValue(monthCountsLikeSql(createdAts, start));
    prisma.user.count.mockResolvedValue(
      createdAts.filter((d) => d < start).length,
    );

    const result = await service.getUserGrowthTrend();

    expect(result).toEqual(oldGrowthTrend(createdAts));
    expect(result).toHaveLength(12);
    expect(result.some((month) => month.newUsers > 0)).toBe(true);
  });

  it('asks for local-month counts since the first day of the range', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await service.getUserGrowthTrend();

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain(
      `("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ? AS "localCreatedAt"`,
    );
    expect(sql).toContain('extract(month FROM "localCreatedAt")::int - 1');
    expect(sql).toContain('WHERE "createdAt" >= ?');
    expect(values).toEqual([
      processTimeZone(),
      new Date(NOW.getFullYear(), NOW.getMonth() - 11, 1),
    ]);
  });
});
