import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import {
  FinanceService,
  groupUnitForOffsets,
  processTimeZone,
  revenueGroupUnit,
  type RevenueDayRow,
} from './finance.service';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    transaction: { aggregate: jest.Mock; groupBy: jest.Mock };
    purchase: { groupBy: jest.Mock };
    movie: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let minioService: { imageUrl: jest.Mock; playbackUrl: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      transaction: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: new Prisma.Decimal(0) } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      purchase: { groupBy: jest.fn().mockResolvedValue([]) },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ total: null, month: null, today: null }]),
    };
    minioService = {
      imageUrl: jest.fn((key: string | null) => key),
      playbackUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(FinanceService);
  });

  describe('getDashboard — topUsers', () => {
    it('names each top spender with their display name next to the raw username', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'user-1',
          _sum: { amount: new Prisma.Decimal(50000) },
          _count: { _all: 4 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          username: 'user_95950495369',
          displayName: 'Blake',
          avatar: 'images/user/user-1/1757606400000.png',
        },
      ]);

      const result = await service.getDashboard();

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-1'] } },
        select: { id: true, username: true, displayName: true, avatar: true },
      });
      // The raw row is discarded — only this mapped object reaches the client,
      // so displayName has to be carried through it explicitly. Without it the
      // Top Spenders chart prints a machine username on its axis.
      expect(result.topUsers[0]).toEqual({
        user: {
          id: 'user-1',
          username: 'user_95950495369',
          displayName: 'Blake',
          avatarUrl: 'https://cdn.test/images/user/user-1/1757606400000.png',
        },
        totalSpent: 50000,
        purchaseCount: 4,
      });
    });

    it('carries displayName as null for a top spender who never set one', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'user-2',
          _sum: { amount: new Prisma.Decimal(1000) },
          _count: { _all: 1 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'user-2', username: 'john', displayName: null, avatar: null },
      ]);

      const result = await service.getDashboard();

      expect(result.topUsers[0].user).toEqual({
        id: 'user-2',
        username: 'john',
        displayName: null,
        avatarUrl: null,
      });
    });

    it('leaves the user null when the grouped spender row has no matching account', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        {
          userId: 'ghost',
          _sum: { amount: new Prisma.Decimal(1000) },
          _count: { _all: 1 },
        },
      ]);
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.getDashboard();

      expect(result.topUsers[0].user).toBeNull();
      expect(result.topUsers[0].totalSpent).toBe(1000);
    });
  });

  describe('getDashboard — revenue totals (bam-02: one statement)', () => {
    const NOW = new Date('2026-10-07T10:00:00.000Z');
    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it('reads all three totals in ONE query: all time, since the 1st of the month, since midnight', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          total: new Prisma.Decimal('125000.50'),
          month: new Prisma.Decimal(30000),
          today: new Prisma.Decimal(4500),
        },
      ]);

      const result = await service.getDashboard();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.aggregate).not.toHaveBeenCalled();
      const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const sql = strings.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('sum("amount") AS "total"');
      expect(sql).toContain(
        'sum("amount") FILTER (WHERE "createdAt" >= ?) AS "month"',
      );
      expect(sql).toContain(
        'sum("amount") FILTER (WHERE "createdAt" >= ?) AS "today"',
      );
      // The same local-time boundaries the three aggregates used.
      const monthStart = new Date(NOW);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const todayStart = new Date(NOW);
      todayStart.setHours(0, 0, 0, 0);
      expect(values[0]).toEqual(monthStart);
      expect(values[1]).toEqual(todayStart);
      expect(result).toMatchObject({
        totalRevenue: 125000.5,
        monthlyRevenue: 30000,
        dailyRevenue: 4500,
      });
    });

    it('shows 0 for a total with no matching rows, as the old aggregates did', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { total: null, month: null, today: null },
      ]);

      const result = await service.getDashboard();

      expect(result).toMatchObject({
        totalRevenue: 0,
        monthlyRevenue: 0,
        dailyRevenue: 0,
      });
    });
  });

  /**
   * bam-01 parity: the OLD getRevenueTrend fed every single transaction row
   * into bucketRevenue; the NEW one feeds Postgres' per-day rows. Feeding
   * the service each kind of row reproduces both, so the two outputs can be
   * compared on the same seeded transactions.
   */
  describe('revenueGroupUnit', () => {
    it.each([
      ['UTC', [0, 0, 0, 0], 'day'],
      ['Asia/Yangon (no daylight saving)', [-390, -390, -390, -390], 'day'],
      ['America/New_York', [300, 240, 300, 240], 'hour'],
      ['Europe/London', [0, -60, 0, -60], 'hour'],
      ['Australia/Adelaide (+9:30/+10:30)', [-630, -570, -630, -570], 'minute'],
      ['Australia/Lord_Howe (+11/+10:30)', [-660, -630, -660, -630], 'minute'],
    ])('%s (offsets %j) groups by %s', (_zone, offsets, expected) => {
      expect(groupUnitForOffsets(offsets)).toBe(expected);
    });

    it('uses this process zone', () => {
      const offsets = [2025, 2026].flatMap((y) =>
        [0, 6].map((m) => new Date(y, m, 1).getTimezoneOffset()),
      );
      expect(revenueGroupUnit(new Date(2026, 9, 7))).toBe(
        groupUnitForOffsets(offsets),
      );
    });
  });

  describe('getRevenueTrend — SQL day rows give the same chart as every single row (bam-01)', () => {
    const NOW = new Date('2026-10-07T10:30:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;

    /** Deterministic pseudo-random transactions over ~13 months. */
    function seedTransactions(): RevenueDayRow[] {
      const rows: RevenueDayRow[] = [];
      let seed = 42;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 4000; i++) {
        const ageMs = Math.floor(next() * 400 * DAY);
        rows.push({
          amount: new Prisma.Decimal(Math.round(next() * 20) * 500 + 1500),
          createdAt: new Date(NOW.getTime() - ageMs),
        });
      }
      // Edges: either side of UTC midnight, month and year boundaries.
      for (const iso of [
        '2026-10-06T23:59:59.999Z',
        '2026-10-07T00:00:00.000Z',
        '2026-09-30T23:59:59.999Z',
        '2026-10-01T00:00:00.000Z',
        '2025-12-31T23:59:59.999Z',
        '2026-01-01T00:00:00.000Z',
      ]) {
        rows.push({
          amount: new Prisma.Decimal(4999),
          createdAt: new Date(iso),
        });
      }
      return rows;
    }

    /** What the SQL returns: rows grouped by UTC day/hour/minute + local day, min createdAt, exact sum. */
    function groupLikeSql(
      rows: RevenueDayRow[],
      since: Date,
      unit: 'day' | 'hour' | 'minute',
    ): RevenueDayRow[] {
      const groups = new Map<string, RevenueDayRow>();
      for (const row of rows) {
        if (row.createdAt < since) continue;
        const d = row.createdAt;
        const utc = d
          .toISOString()
          .slice(0, { day: 10, hour: 13, minute: 16 }[unit]);
        const key = `${utc}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const group = groups.get(key);
        if (!group) {
          groups.set(key, { amount: row.amount, createdAt: d });
        } else {
          group.amount = group.amount.plus(row.amount);
          if (d < group.createdAt) group.createdAt = d;
        }
      }
      return [...groups.values()];
    }

    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it('produces identical daily, weekly and monthly series', async () => {
      const seeded = seedTransactions();
      const oneYearAgo = new Date(NOW);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const inRange = seeded.filter((row) => row.createdAt >= oneYearAgo);

      prisma.$queryRaw.mockResolvedValueOnce(inRange);
      const before = await service.getRevenueTrend();

      const unit = revenueGroupUnit();
      const dayRows = groupLikeSql(seeded, oneYearAgo, unit);
      // Day rows: at most one per UTC day per local day — ~366 in UTC, up
      // to twice that where local midnight is not UTC midnight.
      if (unit === 'day') {
        expect(dayRows.length).toBeLessThanOrEqual(2 * 367);
      }
      expect(dayRows.length).toBeLessThan(inRange.length);
      prisma.$queryRaw.mockResolvedValueOnce(dayRows);
      const after = await service.getRevenueTrend();

      expect(after).toEqual(before);
      expect(before.daily).toHaveLength(14);
      expect(before.monthly).toHaveLength(12);
      expect(before.daily.some((bucket) => bucket.revenue > 0)).toBe(true);
    });

    it('asks Postgres for day rows of revenue types since one year ago, in the process timezone', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await service.getRevenueTrend();

      const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const sql = strings.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('sum("amount")::numeric AS "amount"');
      expect(sql).toContain('min("createdAt") AS "createdAt"');
      expect(sql).toContain('"createdAt" >= ?');
      expect(sql).toContain('date_trunc(?, "createdAt")');
      expect(values).toContain(revenueGroupUnit());
      expect((values[0] as Prisma.Sql).values).toEqual([
        'PURCHASE',
        'SUBSCRIPTION',
      ]);
      expect(sql).toContain(
        "date_trunc('day', (\"createdAt\" AT TIME ZONE 'UTC') AT TIME ZONE ?)",
      );
      const oneYearAgo = new Date(NOW);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      expect(values).toContainEqual(oneYearAgo);
      expect(values[values.length - 1]).toBe(processTimeZone());
    });
  });
});
