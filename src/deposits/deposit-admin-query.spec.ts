import { Test } from '@nestjs/testing';
import {
  BankMatchStatus,
  DepositStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NO_BANK_TRANSACTION_AFTER_MS } from '../bank-events/risk-rules';
import {
  depositSearchWhere,
  depositVerificationWhere,
} from './deposit-admin-query';
import { DepositsService } from './deposits.service';

/**
 * H-24: the admin deposits page used to load one 100-row page and search,
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
const CUTOFF = new Date(NOW.getTime() - NO_BANK_TRANSACTION_AFTER_MS);

describe('depositSearchWhere', () => {
  it('matches the reference, the typed payer name and the user by name or phone', () => {
    expect(depositSearchWhere('  095 ')).toEqual({
      OR: [
        { reference: { contains: '095' } },
        { accountName: { contains: '095', mode: 'insensitive' } },
        { user: { username: { contains: '095', mode: 'insensitive' } } },
        { user: { displayName: { contains: '095', mode: 'insensitive' } } },
        { user: { phone: { contains: '095' } } },
      ],
    });
  });

  it('is no filter at all for a blank or missing term', () => {
    expect(depositSearchWhere('   ')).toBeUndefined();
    expect(depositSearchWhere(undefined)).toBeUndefined();
  });
});

describe('depositVerificationWhere — the same five predicates the list uses', () => {
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
    [
      'awaiting_bank',
      {
        status: DepositStatus.PENDING,
        bankCheckedAt: null,
        createdAt: { gte: CUTOFF },
      },
    ],
    [
      'no_bank_transaction',
      {
        status: DepositStatus.PENDING,
        bankCheckedAt: null,
        createdAt: { lt: CUTOFF },
      },
    ],
  ] as const)('%s', (verification, expected) => {
    expect(depositVerificationWhere(verification, NOW)).toEqual(expected);
  });
});

describe('DepositsService — admin list search and server totals', () => {
  let service: DepositsService;
  let prisma: {
    deposit: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    prisma = {
      deposit: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((arg: Promise<unknown>[]) => Promise.all(arg)),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const module = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      // Every other collaborator is irrelevant to these read paths.
      .useMocker(() => ({}))
      .compile();
    service = module.get(DepositsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds the search to both the page and its count', async () => {
    await service.findAllAdmin({ search: 'blake' });

    const where = wheresOf(prisma.deposit.findMany)[0];
    expect(where).toMatchObject({
      AND: [depositSearchWhere('blake')],
    });
    expect(prisma.deposit.count).toHaveBeenCalledWith({ where });
  });

  it('serves a searched open tab through the ordinary query, with the open-set predicate', async () => {
    await service.findAllAdmin({
      verification: 'no_bank_transaction',
      search: 'blake',
    });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(wheresOf(prisma.deposit.findMany)[0]).toMatchObject({
      AND: [
        depositVerificationWhere('no_bank_transaction', NOW),
        depositSearchWhere('blake'),
      ],
    });
  });

  it('keeps the unsearched open tab on the partial-index raw path', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ n: 0 }]);
    await service.findAllAdmin({ verification: 'awaiting_bank' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  describe('getAdminStats', () => {
    const range = {
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-28T23:59:59.999Z',
    };
    const rangeWhere = {
      createdAt: {
        gte: new Date(range.dateFrom),
        lte: new Date(range.dateTo),
      },
    };

    it('sums the amounts per status in the database, over the whole range, not one page', async () => {
      prisma.deposit.groupBy.mockResolvedValue([
        {
          status: 'PENDING',
          _count: { _all: 150 },
          _sum: { amount: new Prisma.Decimal(750000) },
        },
        {
          status: 'APPROVED',
          _count: { _all: 40 },
          _sum: { amount: new Prisma.Decimal(200000) },
        },
      ]);
      prisma.deposit.count.mockResolvedValue(5);

      const stats = await service.getAdminStats({ ...range, limit: 20 });

      expect(prisma.deposit.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        where: {
          AND: [{ userId: undefined }, rangeWhere, {}, {}],
        },
        _count: { _all: true },
        _sum: { amount: true },
      });
      expect(stats.byStatus.PENDING).toEqual({ count: 150, amount: 750000 });
      expect(stats.byStatus.APPROVED).toEqual({ count: 40, amount: 200000 });
      expect(stats.byStatus.REJECTED).toEqual({ count: 0, amount: 0 });
      expect(stats.total).toEqual({ count: 190, amount: 950000 });
      expect(stats.verification.all).toBe(5);
    });

    it('status totals follow the verification tab; tab counts follow the status filter and never their own', async () => {
      await service.getAdminStats({
        ...range,
        status: DepositStatus.PENDING,
        verification: 'needs_review',
        search: 'blake',
      });

      const search = depositSearchWhere('blake');
      expect(wheresOf(prisma.deposit.groupBy)[0]).toEqual({
        AND: [
          { userId: undefined },
          rangeWhere,
          search,
          depositVerificationWhere('needs_review', NOW),
        ],
      });
      // One count per tab, each ignoring the selected tab but keeping the
      // status filter, in VERIFICATION_FILTERS order.
      const countWheres = wheresOf(prisma.deposit.count);
      expect(countWheres).toEqual(
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
            { userId: undefined },
            rangeWhere,
            search,
            { status: DepositStatus.PENDING },
            depositVerificationWhere(tab, NOW),
          ],
        })),
      );
    });
  });
});
