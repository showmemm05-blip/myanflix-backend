import { Test } from '@nestjs/testing';
import {
  BankMatchStatus,
  Prisma,
  WithdrawalStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WITHDRAWAL_PAYOUT_WINDOW_MS } from '../bank-events/risk-rules';
import {
  withdrawalSearchWhere,
  withdrawalVerificationWhere,
} from './withdrawal-admin-query';
import { WithdrawalsService } from './withdrawals.service';

/**
 * H-24: the admin withdrawals page used to load one 100-row page and search,
 * count and total only inside it. These cover the server side it now leans
 * on: a search over the whole table and totals computed by the database.
 */
/** The `where` of every call to a mocked Prisma method (jest.Mock is untyped). */
function wheresOf(mock: jest.Mock): unknown[] {
  return (mock.mock.calls as [{ where: unknown }][]).map(
    ([args]) => args.where,
  );
}

const NOW = new Date('2026-09-28T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS);

describe('withdrawalSearchWhere', () => {
  it('matches the payout account name/number and the user by name or phone', () => {
    expect(withdrawalSearchWhere(' 0977 ')).toEqual({
      OR: [
        { accountName: { contains: '0977', mode: 'insensitive' } },
        { accountNumber: { contains: '0977' } },
        { user: { username: { contains: '0977', mode: 'insensitive' } } },
        { user: { displayName: { contains: '0977', mode: 'insensitive' } } },
        { user: { phone: { contains: '0977' } } },
      ],
    });
  });

  it('is no filter at all for a blank or missing term', () => {
    expect(withdrawalSearchWhere('')).toBeUndefined();
    expect(withdrawalSearchWhere(undefined)).toBeUndefined();
  });
});

describe('withdrawalVerificationWhere — the same five predicates the list uses', () => {
  const openSet = {
    status: WithdrawalStatus.APPROVED,
    bankCheckedAt: null,
    transferTransactionCode: null,
  };

  it.each([
    ['all', {}],
    ['verified', { matchStatus: BankMatchStatus.MATCHED }],
    [
      'needs_review',
      {
        matchStatus: {
          in: [BankMatchStatus.PENDING_REVIEW, BankMatchStatus.SUSPICIOUS],
        },
      },
    ],
    ['awaiting_bank', { ...openSet, approvedAt: { gte: CUTOFF } }],
    ['no_bank_transaction', { ...openSet, approvedAt: { lt: CUTOFF } }],
  ] as const)('%s', (verification, expected) => {
    expect(withdrawalVerificationWhere(verification, NOW)).toEqual(expected);
  });
});

describe('WithdrawalsService — admin list search and server totals', () => {
  let service: WithdrawalsService;
  let prisma: {
    withdrawal: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    prisma = {
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((arg: Promise<unknown>[]) => Promise.all(arg)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      // Every other collaborator is irrelevant to these read paths.
      .useMocker(() => ({}))
      .compile();
    service = module.get(WithdrawalsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds the search to both the page and its count', async () => {
    await service.findAllAdmin({ search: 'blake' });

    const where = wheresOf(prisma.withdrawal.findMany)[0];
    expect(where).toMatchObject({ AND: [withdrawalSearchWhere('blake')] });
    expect(prisma.withdrawal.count).toHaveBeenCalledWith({ where });
  });

  it('serves a searched open tab through the ordinary query, with the open-set predicate', async () => {
    await service.findAllAdmin({ verification: 'awaiting_bank', search: 'x' });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(wheresOf(prisma.withdrawal.findMany)[0]).toMatchObject({
      AND: [
        withdrawalVerificationWhere('awaiting_bank', NOW),
        withdrawalSearchWhere('x'),
      ],
    });
  });

  it('keeps the unsearched open tab on the partial-index raw path', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: 0 }]);
    await service.findAllAdmin({ verification: 'no_bank_transaction' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  describe('getAdminStats', () => {
    it('sums the amounts per status in the database and counts every tab', async () => {
      prisma.withdrawal.groupBy.mockResolvedValue([
        {
          status: 'PENDING',
          _count: { _all: 120 },
          _sum: { amount: new Prisma.Decimal(360000) },
        },
        {
          status: 'REJECTED',
          _count: { _all: 2 },
          _sum: { amount: new Prisma.Decimal(1000) },
        },
      ]);
      prisma.withdrawal.count.mockResolvedValue(4);

      const stats = await service.getAdminStats({
        status: WithdrawalStatus.APPROVED,
        verification: 'verified',
        userId: '11111111-1111-4111-8111-111111111111',
      });

      const base = [
        { userId: '11111111-1111-4111-8111-111111111111' },
        { createdAt: undefined },
        {},
      ];
      expect(prisma.withdrawal.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          AND: [...base, withdrawalVerificationWhere('verified', NOW)],
        },
        _count: { _all: true },
        _sum: { amount: true },
      });
      expect(wheresOf(prisma.withdrawal.count)).toEqual(
        (
          [
            'all',
            'awaiting_bank',
            'verified',
            'needs_review',
            'no_bank_transaction',
          ] as const
        ).map((tab) => ({
          AND: [
            ...base,
            { status: WithdrawalStatus.APPROVED },
            withdrawalVerificationWhere(tab, NOW),
          ],
        })),
      );
      expect(stats).toEqual({
        byStatus: {
          PENDING: { count: 120, amount: 360000 },
          APPROVED: { count: 0, amount: 0 },
          REJECTED: { count: 2, amount: 1000 },
        },
        total: { count: 122, amount: 361000 },
        verification: {
          all: 4,
          awaiting_bank: 4,
          verified: 4,
          needs_review: 4,
          no_bank_transaction: 4,
        },
      });
    });
  });
});
