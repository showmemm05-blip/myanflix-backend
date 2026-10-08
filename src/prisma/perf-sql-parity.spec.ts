/**
 * Old-vs-new parity on a REAL Postgres for the 2026-10-07 performance
 * changes that moved work from JavaScript into SQL (be-money-auth package):
 * the finance totals and revenue chart, the user-growth chart, the tracking
 * report totals, the wallet totals, the refresh-token sweep and the peak
 * counter. Every "old" query below is the code that ran before, copied
 * verbatim; the "new" side is the service as it is now.
 *
 * Skipped unless PARITY_DATABASE_URL is set. It WRITES rows, so it refuses
 * any database whose name does not end in "_parity": run it only against a
 * throwaway database that has every migration applied, e.g.
 *
 *   NODE_OPTIONS=--experimental-vm-modules \
 *   PARITY_DATABASE_URL=postgresql://u@127.0.0.1:55530/myanflix_parity \
 *     TZ=UTC npx jest src/prisma/perf-sql-parity
 *
 * Run it under a few TZ values: the chart buckets follow the process
 * timezone, and the new SQL must follow it too.
 */
import type { ConfigService } from '@nestjs/config';
import type { MinioService } from '../common/storage/minio.service';
import type { StorageService } from '../common/storage/storage.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RefreshTokenSweeperService } from '../auth/refresh-token-sweeper.service';
import type { SessionRevocationService } from '../auth/session-revocation.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { FinanceService } from '../finance/finance.service';
import {
  ClientPlatform,
  Prisma,
  Role,
  TransactionType,
} from '../generated/prisma/client';
import { PeakUsersService } from '../peak-users/peak-users.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthorityService } from '../roles/authority.service';
import type { PermissionResolverService } from '../roles/permission-resolver.service';
import { TrackingReadService } from '../tracking/tracking-read.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from './prisma.service';

const URL = process.env.PARITY_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const RUN = `parity-${process.pid}-${Date.now()}`;
const REVENUE = [TransactionType.PURCHASE, TransactionType.SUBSCRIPTION];

/** Deterministic pseudo-random numbers, so a failure can be replayed. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

describeDb('SQL parity on a real database (perf 2026-10-07)', () => {
  let prisma: PrismaService;
  const userIds: string[] = [];

  beforeAll(async () => {
    const name = new globalThis.URL(URL!).pathname.replace(/^\//, '');
    if (!name.endsWith('_parity')) {
      throw new Error(
        `PARITY_DATABASE_URL must name a throwaway *_parity database (got "${name}")`,
      );
    }
    prisma = new PrismaService({
      get: (key: string) => (key === 'DATABASE_URL' ? URL : undefined),
    } as unknown as ConfigService);
    await prisma.$connect();

    const next = rng(20261007);
    const now = Date.now();
    // 400 users over ~15 months, some right at month and day edges.
    const users = Array.from({ length: 400 }, (_, i) => ({
      id: `${RUN}-u${i}`,
      username: `${RUN}-u${i}`,
      password: 'x',
      phone: `+9599${String(i).padStart(7, '0')}`,
      createdAt: new Date(now - Math.floor(next() * 450 * DAY)),
    }));
    users.push(
      ...[
        '2026-08-31T23:59:59.999Z',
        '2026-09-01T00:00:00.000Z',
        '2026-08-31T17:29:59.999Z', // Yangon midnight is 17:30 UTC
        '2026-08-31T17:30:00.000Z',
      ].map((iso, i) => ({
        id: `${RUN}-edge${i}`,
        username: `${RUN}-edge${i}`,
        password: 'x',
        phone: `+9598${String(i).padStart(7, '0')}`,
        createdAt: new Date(iso),
      })),
    );
    await prisma.user.createMany({ data: users });
    userIds.push(...users.map((u) => u.id));

    // 6,000 transactions of every type over ~13 months. Amounts are whole
    // kyats or quarter steps (exact in binary), like the real data.
    const types = Object.values(TransactionType);
    const transactions = Array.from({ length: 6000 }, () => ({
      userId: users[Math.floor(next() * users.length)].id,
      type: types[Math.floor(next() * types.length)],
      amount: new Prisma.Decimal(
        Math.floor(next() * 40) * 500 +
          [0, 0.25, 0.5, 0.75][Math.floor(next() * 4)],
      ),
      status: next() < 0.9 ? ('COMPLETED' as const) : ('PENDING' as const),
      createdAt: new Date(now - Math.floor(next() * 400 * DAY)),
    }));
    await prisma.transaction.createMany({ data: transactions });

    const terms = [
      'avengers',
      'the avengers',
      'batman',
      'love',
      'အချစ်',
      '50%_off',
      // Only a LIKE wildcard matches these against the searches 'a_b' and
      // '100%' (Prisma's `contains` does not escape `_` / `%`), so they
      // prove the count uses the very same LIKE as the page list.
      'axb',
      'a_b',
      '100% love',
      '100 love',
    ];
    const platforms = Object.values(ClientPlatform);
    await prisma.searchQuery.createMany({
      data: Array.from({ length: 1500 }, () => {
        const term = terms[Math.floor(next() * terms.length)];
        return {
          term: term.toUpperCase(),
          normalizedTerm: `${term} ${Math.floor(next() * 40)}`,
          resultCount: Math.floor(next() * 5),
          platform: platforms[Math.floor(next() * platforms.length)],
          createdAt: new Date(now - Math.floor(next() * 60 * DAY)),
        };
      }),
    });
    await prisma.userSession.createMany({
      data: Array.from({ length: 1500 }, () => ({
        userId: users[Math.floor(next() * users.length)].id,
        platform: platforms[Math.floor(next() * platforms.length)],
        ipAddress: `203.0.113.${Math.floor(next() * 30)}`,
        lastSeenAt: new Date(now - Math.floor(next() * 60 * DAY)),
      })),
    });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.searchQuery.deleteMany({});
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const minio = {} as MinioService;

  it('finance totals: one FILTER statement equals the three old aggregates', async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const sum = async (createdAt?: { gte: Date }) =>
      decimalToNumber(
        (
          await prisma.transaction.aggregate({
            _sum: { amount: true },
            where: { type: { in: REVENUE }, ...(createdAt && { createdAt }) },
          })
        )._sum.amount,
      );
    const old = {
      totalRevenue: await sum(),
      monthlyRevenue: await sum({ gte: startOfMonth }),
      dailyRevenue: await sum({ gte: startOfToday }),
    };

    const now = await new FinanceService(prisma, minio).getDashboard();

    expect(now).toMatchObject(old);
    expect(old.totalRevenue).toBeGreaterThan(0);
  });

  it('revenue chart: SQL day rows give the same daily/weekly/monthly series as every row', async () => {
    const service = new FinanceService(prisma, minio);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const everyRow = await prisma.transaction.findMany({
      where: { type: { in: REVENUE }, createdAt: { gte: oneYearAgo } },
      select: { amount: true, createdAt: true },
    });
    const raw = jest.spyOn(prisma, '$queryRaw').mockResolvedValueOnce(everyRow);
    const old = await service.getRevenueTrend();
    raw.mockRestore();

    const sqlRows = jest.spyOn(prisma, '$queryRaw');
    const now = await service.getRevenueTrend();
    const dayRows = (await sqlRows.mock.results[0].value) as unknown[];
    sqlRows.mockRestore();

    expect(now).toEqual(old);
    expect(dayRows.length).toBeLessThan(everyRow.length);
  });

  it('user growth: SQL month counts give the same chart as bucketing every user', async () => {
    const monthsBack = 12;
    const at = new Date();
    const start = new Date(
      at.getFullYear(),
      at.getMonth() - (monthsBack - 1),
      1,
    );
    const usersInRange = await prisma.user.findMany({
      where: { createdAt: { gte: start } },
      select: { createdAt: true },
    });
    const activeBeforeRange = await prisma.user.count({
      where: { createdAt: { lt: start } },
    });
    const byKey = new Map<string, number>();
    for (const user of usersInRange) {
      const key = `${user.createdAt.getFullYear()}-${user.createdAt.getMonth()}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    let running = activeBeforeRange;
    const LABELS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
    const old = Array.from({ length: monthsBack }, (_, i) => {
      const date = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const newUsers =
        byKey.get(`${date.getFullYear()}-${date.getMonth()}`) ?? 0;
      running += newUsers;
      return { label: LABELS[date.getMonth()], newUsers, activeUsers: running };
    });

    const now = await new AnalyticsService(prisma, minio).getUserGrowthTrend(
      monthsBack,
    );

    expect(now).toEqual(old);
  });

  describe('tracking totals', () => {
    const superAdmin: AuthenticatedUser = {
      id: 'parity-admin',
      username: 'parity-admin',
      role: Role.SUPER_ADMIN,
      appRoleId: null,
    };
    const make = (canViewPii: boolean) =>
      new TrackingReadService(
        prisma,
        {
          can: () => Promise.resolve(canViewPii),
        } as unknown as PermissionResolverService,
        {} as RealtimeGateway,
        {} as AuditService,
      );
    const fromIso = new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10);
    const toIso = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);

    it.each([
      [{}],
      [{ platform: ClientPlatform.WEB }],
      [{ from: fromIso, to: toIso }],
      [{ search: ' The  AVENGERS ' }],
      [{ search: '50%_' }],
      [{ search: 'a_b' }],
      [{ search: '100%' }],
      [{ search: 'a\\b' }],
      [{ search: 'အချစ်', platform: ClientPlatform.MOBILE, from: fromIso }],
      [{ search: 'no such term at all' }],
    ])(
      'top searches %j: count(DISTINCT) equals the old groupBy length',
      async (query) => {
        const service = make(true);
        const where = (
          service as unknown as {
            searchWhere: (q: object) => Prisma.SearchQueryWhereInput;
          }
        ).searchWhere(query);
        const old = (
          await prisma.searchQuery.groupBy({ by: ['normalizedTerm'], where })
        ).length;

        const { total } = await service.topSearches(query);

        expect(total).toBe(old);
        if (Object.keys(query).length === 0) expect(old).toBeGreaterThan(0);
      },
    );

    it('top searches: a `_` in the search acts as a wildcard in the total, as in the list', async () => {
      const service = make(true);
      const { total } = await service.topSearches({ search: 'a_b' });
      // A literal substring match would only see the 'a_b …' terms; the
      // page list (LIKE) also sees 'axb …', and so must the total.
      const literal = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(DISTINCT "normalizedTerm")::int AS "count"
        FROM "search_queries" WHERE strpos("normalizedTerm", 'a_b') > 0`;
      expect(literal[0].count).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(literal[0].count);
    });

    it.each([
      [true, {}],
      [true, { platform: ClientPlatform.MOBILE, from: fromIso, to: toIso }],
      [true, { ip: '203.0.113.1' }],
      [true, { phone: '+95990000' }],
      [true, { search: `${RUN}-u1` }],
      [false, { search: `${RUN}-u2` }],
    ])(
      'sessions (PII %p) %j: users with a matching session equal the old distinct userIds',
      async (canViewPii, query) => {
        const service = make(canViewPii);
        const groupBy = jest.spyOn(prisma.userSession, 'groupBy');
        const { total } = await service.sessions(superAdmin, query);
        const pageWhere = (groupBy.mock.calls[0][0] as { where: object }).where;
        groupBy.mockRestore();

        const old = (
          await prisma.userSession.groupBy({ by: ['userId'], where: pageWhere })
        ).length;

        expect(total).toBe(old);
        if (Object.keys(query).length === 0) expect(old).toBeGreaterThan(0);
      },
    );

    it('top searches: a `_` in the search acts as a wildcard in the total, as in the list', async () => {
      const service = make(true);
      const { total } = await service.topSearches({ search: 'a_b' });
      // A literal substring match would only see the 'a_b …' terms; the
      // page list (LIKE) also sees 'axb …', and so must the total.
      const literal = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(DISTINCT "normalizedTerm")::int AS "count"
        FROM "search_queries" WHERE strpos("normalizedTerm", 'a_b') > 0`;
      expect(literal[0].count).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(literal[0].count);
    });
  });

  it('wallet totals: one grouped query equals the old spent/deposited queries', async () => {
    const users = new UsersService(
      prisma,
      minio,
      {} as StorageService,
      {} as AuthorityService,
      {} as AuditService,
      {} as SessionRevocationService,
    );
    const ids = userIds.slice(0, 60);
    const spentOld = await prisma.transaction.groupBy({
      by: ['userId'],
      where: {
        userId: { in: ids },
        type: { in: REVENUE },
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
    const depositedOld = await prisma.transaction.groupBy({
      by: ['userId'],
      where: {
        userId: { in: ids },
        type: TransactionType.DEPOSIT,
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });

    const summaries = await users.getWalletSummaries(ids);

    for (const id of ids) {
      const spent = spentOld.find((row) => row.userId === id);
      const deposited = depositedOld.find((row) => row.userId === id);
      expect(summaries.get(id)).toMatchObject({
        totalSpent: decimalToNumber(spent?._sum.amount),
        totalDeposited: decimalToNumber(deposited?._sum.amount),
      });
      const one = await users.getWalletSummary(id);
      expect(one.totalSpent).toBe(summaries.get(id)!.totalSpent);
      expect(one.totalDeposited).toBe(summaries.get(id)!.totalDeposited);
    }
  });

  it('refresh-token sweep deletes only rows expired over a day ago', async () => {
    const userId = userIds[0];
    const now = Date.now();
    const rows = [
      { id: `${RUN}-old1`, expiresAt: new Date(now - 3 * DAY), revoked: true },
      {
        id: `${RUN}-old2`,
        expiresAt: new Date(now - 25 * 60 * 60 * 1000),
        revoked: false,
      },
      {
        id: `${RUN}-grace`,
        expiresAt: new Date(now - 12 * 60 * 60 * 1000),
        revoked: false,
      },
      { id: `${RUN}-live`, expiresAt: new Date(now + 6 * DAY), revoked: false },
      {
        id: `${RUN}-revoked-live`,
        expiresAt: new Date(now + 6 * DAY),
        revoked: true,
      },
    ];
    await prisma.refreshToken.createMany({
      data: rows.map((row) => ({ ...row, userId, tokenHash: row.id })),
    });

    const deleted = await new RefreshTokenSweeperService(prisma).sweepExpired();

    const left = await prisma.refreshToken.findMany({
      where: { userId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(left.map((row) => row.id)).toEqual(
      [`${RUN}-grace`, `${RUN}-live`, `${RUN}-revoked-live`].sort(),
    );
  });

  it('peak counter: the conditional write only ever raises actualPeak', async () => {
    const before = await prisma.peakUserStats.findFirst();
    const service = new PeakUsersService(prisma, {} as AuditService);
    const base = before?.actualPeak ?? 0;

    await service.recordConcurrent(base + 5);
    await service.recordConcurrent(base + 2);
    await new PeakUsersService(prisma, {} as AuditService).recordConcurrent(
      base + 3,
    );

    const after = await prisma.peakUserStats.findFirst();
    expect(after?.actualPeak).toBe(base + 5);

    // A data wipe while the backend runs: the next new peak lands on a
    // fresh row instead of being silently dropped.
    await prisma.peakUserStats.deleteMany({});
    await service.recordConcurrent(base + 6);
    const rows = await prisma.peakUserStats.findMany();
    expect(rows.map((row) => row.actualPeak)).toEqual([base + 6]);

    await prisma.peakUserStats.deleteMany({});
    if (before) await prisma.peakUserStats.create({ data: before });
  });
});
