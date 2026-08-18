import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { DepositStatus, WithdrawalStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  UserRelationshipsService,
  normalizeRelationshipPhone,
} from './user-relationships.service';

interface UserRow {
  id: string;
  username: string;
  phone: string | null;
  createdAt: Date;
}
interface WithdrawalRow {
  id: string;
  userId: string;
  accountNumber: string;
  amount: Prisma.Decimal;
  status: WithdrawalStatus;
  createdAt: Date;
}
interface DepositRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  status: DepositStatus;
  createdAt: Date;
}

const T0 = new Date('2026-01-01T00:00:00Z');
/** Distinct, ordered timestamps so first/last-used and recency assertions are stable. */
function at(offsetDays: number): Date {
  return new Date(T0.getTime() + offsetDays * 86_400_000);
}

function user(
  id: string,
  phone: string | null = null,
  createdAt = T0,
): UserRow {
  return { id, username: `user-${id}`, phone, createdAt };
}

function withdrawal(
  id: string,
  userId: string,
  accountNumber: string,
  overrides: Partial<WithdrawalRow> = {},
): WithdrawalRow {
  return {
    id,
    userId,
    accountNumber,
    amount: new Prisma.Decimal(1000),
    status: WithdrawalStatus.APPROVED,
    createdAt: T0,
    ...overrides,
  };
}

type InFilter = { in: string[] } | undefined;

/**
 * Stands in for Prisma with an in-memory dataset, because the whole point of
 * this service is the traversal: a per-call `mockResolvedValueOnce` script
 * would encode the very query order under test and pass even if the BFS
 * walked the graph wrong.
 */
function makeDb(
  users: UserRow[],
  withdrawals: WithdrawalRow[],
  deposits: DepositRow[] = [],
) {
  return {
    user: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { phone?: InFilter; id?: InFilter };
        }): UserRow[] => {
          if (where.phone) {
            const wanted = new Set(where.phone.in);
            return users.filter((u) => u.phone !== null && wanted.has(u.phone));
          }
          if (where.id) {
            const wanted = new Set(where.id.in);
            return users.filter((u) => wanted.has(u.id));
          }
          return [];
        },
      ),
    },
    withdrawal: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { accountNumber?: InFilter; userId?: InFilter };
        }): WithdrawalRow[] => {
          if (where.accountNumber) {
            const wanted = new Set(where.accountNumber.in);
            return withdrawals.filter((w) => wanted.has(w.accountNumber));
          }
          if (where.userId) {
            const wanted = new Set(where.userId.in);
            return withdrawals
              .filter((w) => wanted.has(w.userId))
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          return [];
        },
      ),
    },
    deposit: {
      groupBy: jest.fn(
        (args: {
          where: { userId: { in: string[] }; status?: DepositStatus };
          _count?: unknown;
          _sum?: unknown;
        }) => {
          const wanted = new Set(args.where.userId.in);
          const rows = deposits.filter(
            (d) =>
              wanted.has(d.userId) &&
              (args.where.status === undefined ||
                d.status === args.where.status),
          );
          const byUser = new Map<string, DepositRow[]>();
          for (const row of rows) {
            byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
          }
          return [...byUser.entries()].map(([userId, userRows]) =>
            args._count
              ? { userId, _count: { _all: userRows.length } }
              : {
                  userId,
                  _sum: {
                    amount: userRows.reduce(
                      (sum, row) => sum.plus(row.amount),
                      new Prisma.Decimal(0),
                    ),
                  },
                },
          );
        },
      ),
      findMany: jest.fn(
        ({
          where,
          take,
        }: {
          where: { userId: { in: string[] } };
          take: number;
        }) => {
          const wanted = new Set(where.userId.in);
          return deposits
            .filter((d) => wanted.has(d.userId))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take);
        },
      ),
    },
  };
}

async function buildService(db: ReturnType<typeof makeDb>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      UserRelationshipsService,
      { provide: PrismaService, useValue: db },
    ],
  }).compile();
  return module.get(UserRelationshipsService);
}

describe('normalizeRelationshipPhone', () => {
  it('collapses spacing and punctuation onto one key', () => {
    expect(normalizeRelationshipPhone('09 777 888 999')).toBe('09777888999');
    expect(normalizeRelationshipPhone('09-777-888-999')).toBe('09777888999');
    expect(normalizeRelationshipPhone(' 09777888999 ')).toBe('09777888999');
  });

  it('folds the Myanmar country code back to the local form so a stored +959 profile phone matches a typed 09 payout number', () => {
    expect(normalizeRelationshipPhone('+959777888999')).toBe('09777888999');
    expect(normalizeRelationshipPhone('00959777888999')).toBe('09777888999');
    expect(normalizeRelationshipPhone('959777888999')).toBe('09777888999');
  });

  it('leaves a long bank account number that happens to start with 959 alone', () => {
    expect(normalizeRelationshipPhone('95912345678901234')).toBe(
      '95912345678901234',
    );
  });

  it('rejects anything too short to be a phone', () => {
    expect(normalizeRelationshipPhone('12345')).toBeNull();
    expect(normalizeRelationshipPhone('KBZ')).toBeNull();
    expect(normalizeRelationshipPhone('')).toBeNull();
    expect(normalizeRelationshipPhone(null)).toBeNull();
  });
});

describe('UserRelationshipsService.getNetwork', () => {
  it('walks the full closure across three hops, alternating phone/user depths', async () => {
    // seed 09111111111 -> A -> 09222222222 -> B -> (B's profile) -> C
    const users = [
      user('a'),
      user('b'),
      user('c', '+959333333333'),
      user('unrelated', '+959999999999'),
    ];
    users[1].phone = '+959333333333';
    const withdrawals = [
      withdrawal('w1', 'a', '09111111111'),
      withdrawal('w2', 'a', '09222222222'),
      withdrawal('w3', 'b', '09222222222'),
      withdrawal('w4', 'unrelated', '09888888888'),
    ];
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09111111111');

    expect(result.users.map((u) => u.id).sort()).toEqual(['a', 'b', 'c']);
    const depthById = new Map(result.users.map((u) => [u.id, u.depth]));
    expect(depthById.get('a')).toBe(1);
    expect(depthById.get('b')).toBe(3);
    expect(depthById.get('c')).toBe(5);
    const phoneDepths = new Map(
      result.phones.map((p) => [p.normalized, p.depth]),
    );
    expect(phoneDepths.get('09111111111')).toBe(0);
    expect(phoneDepths.get('09222222222')).toBe(2);
    expect(phoneDepths.get('09333333333')).toBe(4);
    expect(result.stats).toMatchObject({
      totalUsers: 3,
      totalPhones: 3,
      totalWithdrawals: 3,
      maxDepth: 5,
      truncated: false,
    });
    expect(result.seedPhone).toEqual({
      raw: '09111111111',
      normalized: '09111111111',
    });
  });

  it('terminates on a cycle and lists every user and phone exactly once', async () => {
    // A and B both withdraw to BOTH phones — the two nodes point at each
    // other, so a visited-set-free walk would never stop.
    const users = [user('a'), user('b')];
    const withdrawals = [
      withdrawal('w1', 'a', '09111111111'),
      withdrawal('w2', 'a', '09222222222'),
      withdrawal('w3', 'b', '09222222222'),
      withdrawal('w4', 'b', '09111111111'),
    ];
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09111111111');

    expect(result.users.map((u) => u.id)).toEqual(['a', 'b']);
    expect(result.phones.map((p) => p.normalized).sort()).toEqual([
      '09111111111',
      '09222222222',
    ]);
    expect(result.stats.truncated).toBe(false);
    // 2 users x 2 phones, one edge each — no duplicates from the second visit.
    expect(result.edges).toHaveLength(4);
  });

  it('folds repeat withdrawals on the same number into one phone node and one edge', async () => {
    const users = [user('a')];
    const withdrawals = [
      withdrawal('w1', 'a', '09111111111', {
        amount: new Prisma.Decimal(1000),
        createdAt: at(1),
      }),
      withdrawal('w2', 'a', '09 111 111 111', {
        amount: new Prisma.Decimal(2500),
        createdAt: at(5),
      }),
      withdrawal('w3', 'a', '09111111111', {
        amount: new Prisma.Decimal(9999),
        status: WithdrawalStatus.REJECTED,
        createdAt: at(3),
      }),
    ];
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09111111111');

    expect(result.phones).toHaveLength(1);
    const phone = result.phones[0];
    expect(phone.withdrawalCount).toBe(3);
    expect(phone.userCount).toBe(1);
    expect(phone.users).toEqual([
      // Rejected rows count as records but never as money.
      {
        userId: 'a',
        withdrawalCount: 3,
        totalAmount: 3500,
        depositCount: 0,
        totalDepositedAmount: 0,
      },
    ]);
    expect(phone.depositCount).toBe(0);
    expect(phone.firstUsedAt).toEqual(at(1));
    expect(phone.lastUsedAt).toEqual(at(5));
    const withdrawalEdges = result.edges.filter((e) => e.kind === 'WITHDRAWAL');
    expect(withdrawalEdges).toEqual([
      {
        userId: 'a',
        phone: '09111111111',
        kind: 'WITHDRAWAL',
        withdrawalCount: 3,
        totalAmount: 3500,
      },
    ]);
    expect(result.users[0]).toMatchObject({
      withdrawalCount: 3,
      totalWithdrawnAmount: 3500,
    });
  });

  it('matches a spaced seed phone against the unspaced stored number', async () => {
    const users = [user('a')];
    const withdrawals = [withdrawal('w1', 'a', '09777888999')];
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09 777 888 999');

    expect(result.users.map((u) => u.id)).toEqual(['a']);
    expect(result.seedPhone).toEqual({
      raw: '09 777 888 999',
      normalized: '09777888999',
    });
    expect(result.phones[0].normalized).toBe('09777888999');
  });

  it('links a user by profile phone alone and marks that edge PROFILE', async () => {
    // No withdrawals at all — the only link is User.phone, stored in the
    // +959 form the auth layer normalizes to.
    const users = [user('a', '+959777888999')];
    const service = await buildService(makeDb(users, []));

    const result = await service.getNetwork('09777888999');

    expect(result.users.map((u) => u.id)).toEqual(['a']);
    expect(result.edges).toEqual([
      {
        userId: 'a',
        phone: '09777888999',
        kind: 'PROFILE',
        withdrawalCount: 0,
        totalAmount: 0,
      },
    ]);
    const phone = result.phones[0];
    expect(phone.userCount).toBe(1);
    expect(phone.withdrawalCount).toBe(0);
    expect(phone.firstUsedAt).toBeNull();
    expect(phone.users).toEqual([
      {
        userId: 'a',
        withdrawalCount: 0,
        totalAmount: 0,
        depositCount: 0,
        totalDepositedAmount: 0,
      },
    ]);
  });

  it('stops at MAX_NODES and reports truncated', async () => {
    const users = Array.from({ length: 500 }, (_, i) =>
      user(`u${String(i).padStart(4, '0')}`),
    );
    const withdrawals = users.map((u, i) =>
      withdrawal(`w${i}`, u.id, '09111111111'),
    );
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09111111111');

    expect(result.stats.truncated).toBe(true);
    expect(result.stats.totalUsers + result.stats.totalPhones).toBe(400);
  });

  it('stops at MAX_DEPTH and reports truncated', async () => {
    // Chain: phone0 - u0 - phone1 - u1 - ... Each user withdraws to their own
    // phone and the next one, so depth grows by 2 per link.
    const users = Array.from({ length: 10 }, (_, i) => user(`u${i}`));
    const withdrawals = users.flatMap((u, i) => [
      withdrawal(`w${i}a`, u.id, `0911111000${i}`),
      withdrawal(`w${i}b`, u.id, `0911111000${i + 1}`),
    ]);
    const service = await buildService(makeDb(users, withdrawals));

    const result = await service.getNetwork('09111110000');

    expect(result.stats.truncated).toBe(true);
    expect(result.stats.maxDepth).toBe(12);
    expect(result.users.every((u) => u.depth < 12)).toBe(true);
  });

  it('reports deposit statistics per user and the most recent activity across the network', async () => {
    const users = [user('a'), user('b')];
    const withdrawals = [
      withdrawal('w1', 'a', '09111111111', { createdAt: at(2) }),
      withdrawal('w2', 'b', '09111111111', {
        createdAt: at(4),
        amount: new Prisma.Decimal(700),
      }),
    ];
    const deposits: DepositRow[] = [
      {
        id: 'd1',
        userId: 'a',
        amount: new Prisma.Decimal(5000),
        status: DepositStatus.APPROVED,
        createdAt: at(1),
      },
      {
        id: 'd2',
        userId: 'a',
        amount: new Prisma.Decimal(3000),
        status: DepositStatus.REJECTED,
        createdAt: at(3),
      },
      {
        id: 'd3',
        userId: 'b',
        amount: new Prisma.Decimal(1500),
        status: DepositStatus.APPROVED,
        createdAt: at(9),
      },
    ];
    const service = await buildService(makeDb(users, withdrawals, deposits));

    const result = await service.getNetwork('09111111111');

    const byId = new Map(result.users.map((u) => [u.id, u]));
    // Counts cover every row; amounts only APPROVED money.
    expect(byId.get('a')).toMatchObject({
      depositCount: 2,
      totalDepositedAmount: 5000,
      name: 'user-a',
      username: 'user-a',
    });
    expect(byId.get('b')).toMatchObject({
      depositCount: 1,
      totalDepositedAmount: 1500,
    });
    expect(result.stats.totalDeposits).toBe(3);
    // The same figures ride along on the phone node's user rows, and the node
    // total is the sum over the users attached to it.
    const phone = result.phones.find((p) => p.normalized === '09111111111')!;
    expect(phone.users).toEqual([
      {
        userId: 'a',
        withdrawalCount: 1,
        totalAmount: 1000,
        depositCount: 2,
        totalDepositedAmount: 5000,
      },
      {
        userId: 'b',
        withdrawalCount: 1,
        totalAmount: 700,
        depositCount: 1,
        totalDepositedAmount: 1500,
      },
    ]);
    expect(phone.depositCount).toBe(3);
    expect(result.recentActivity).toHaveLength(5);
    expect(result.recentActivity[0]).toMatchObject({
      id: 'd3',
      type: 'DEPOSIT',
      userId: 'b',
      userName: 'user-b',
      amount: 1500,
    });
    expect(result.recentActivity.map((a) => a.id)).toEqual([
      'd3',
      'w2',
      'd2',
      'w1',
      'd1',
    ]);
  });

  it('counts a two-phone user’s deposits once per phone-user row, and never twice inside one phone total', async () => {
    // a is on BOTH numbers: 09111111111 via a withdrawal, 09222222222 as their
    // profile phone. b is only on 09222222222.
    const users = [user('a', '+959222222222'), user('b')];
    const withdrawals = [
      withdrawal('w1', 'a', '09111111111'),
      withdrawal('w2', 'a', '09 111 111 111'),
      withdrawal('w3', 'b', '09222222222'),
    ];
    const deposits: DepositRow[] = [
      {
        id: 'd1',
        userId: 'a',
        amount: new Prisma.Decimal(5000),
        status: DepositStatus.APPROVED,
        createdAt: at(1),
      },
      {
        id: 'd2',
        userId: 'a',
        amount: new Prisma.Decimal(3000),
        status: DepositStatus.REJECTED,
        createdAt: at(2),
      },
      {
        id: 'd3',
        userId: 'a',
        amount: new Prisma.Decimal(2000),
        status: DepositStatus.APPROVED,
        createdAt: at(3),
      },
      {
        id: 'd4',
        userId: 'b',
        amount: new Prisma.Decimal(1500),
        status: DepositStatus.APPROVED,
        createdAt: at(4),
      },
    ];
    const service = await buildService(makeDb(users, withdrawals, deposits));

    const result = await service.getNetwork('09111111111');

    const byNormalized = new Map(result.phones.map((p) => [p.normalized, p]));
    const seeded = byNormalized.get('09111111111')!;
    const profile = byNormalized.get('09222222222')!;

    // a's three deposits (two of them APPROVED) show unchanged on each number
    // a is attached to — they are a's own totals, not usage of the number.
    expect(seeded.users).toEqual([
      {
        userId: 'a',
        withdrawalCount: 2,
        totalAmount: 2000,
        depositCount: 3,
        totalDepositedAmount: 7000,
      },
    ]);
    expect(profile.users.find((u) => u.userId === 'a')).toMatchObject({
      depositCount: 3,
      totalDepositedAmount: 7000,
    });

    // Two withdrawals on the seeded number must not make a count twice there.
    expect(seeded.depositCount).toBe(3);
    // The shared number sums its two distinct users: a (3) + b (1).
    expect(profile.userCount).toBe(2);
    expect(profile.depositCount).toBe(4);

    // Network-wide the figure stays user-derived, so a is counted once even
    // though a appears under two phones.
    expect(result.stats.totalDeposits).toBe(4);
  });

  it('returns an empty network (not an error) when the phone matches nothing', async () => {
    const service = await buildService(makeDb([user('a')], []));

    const result = await service.getNetwork('09000000000');

    expect(result).toEqual({
      seedPhone: { raw: '09000000000', normalized: '09000000000' },
      users: [],
      phones: [],
      edges: [],
      stats: {
        totalUsers: 0,
        totalPhones: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        maxDepth: 0,
        truncated: false,
        activityTruncated: false,
      },
      recentActivity: [],
    });
  });

  it('short-circuits a seed that is not plausibly a phone, without querying', async () => {
    const db = makeDb([user('a')], []);
    const service = await buildService(db);

    const result = await service.getNetwork('12345');

    expect(result.users).toEqual([]);
    expect(result.seedPhone).toEqual({ raw: '12345', normalized: '' });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.withdrawal.findMany).not.toHaveBeenCalled();
  });

  it('queries one batch per BFS wave instead of one per node', async () => {
    const users = Array.from({ length: 25 }, (_, i) => user(`u${i}`));
    const withdrawals = users.map((u, i) =>
      withdrawal(`w${i}`, u.id, '09111111111'),
    );
    const db = makeDb(users, withdrawals);
    const service = await buildService(db);

    await service.getNetwork('09111111111');

    // Wave 1 discovers all 25 users; wave 2 finds nothing new and stops.
    // 25 nodes must never mean 25 round trips.
    expect(db.withdrawal.findMany.mock.calls.length).toBeLessThanOrEqual(4);
    expect(db.user.findMany.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
