import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryClaimRejectReason,
  LotteryClaimStatus,
  LotteryPayoutStatus,
  Prisma,
  Role,
  TransactionType,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { WalletService } from '../../wallet/wallet.service';
import {
  CLAIM_ID,
  DRAW_ID,
  makeClaim,
  makePayout,
} from '../../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from '../lottery-errors';
import {
  PUBLISH_TRANSACTION_MAX_WAIT_MS,
  PUBLISH_TRANSACTION_TIMEOUT_MS,
} from '../results/lottery-publish.service';
import {
  claimLabel,
  escapeLike,
  LotteryClaimsAdminService,
  NEW_ACCOUNT_DAYS,
} from './lottery-claims-admin.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

/** 00:30 MMT on Sunday 25 October 2026 — "today" in Myanmar is already the 25th. */
const NOW = new Date('2026-10-24T18:00:00Z');
const MMT_DAY_START = new Date('2026-10-24T17:30:00Z');
const MMT_DAY_END = new Date('2026-10-25T17:30:00Z');

const CUSTOMER = {
  id: 'user-1',
  username: 'mya',
  displayName: 'Mya',
  phone: '09959123456',
  email: null,
};
const STAFF = {
  id: 'admin-1',
  username: 'admin.blake',
  displayName: 'Blake',
  phone: null,
  email: null,
};

/** A claim as the lock re-reads it (the draw and the customer's username for the audit label). */
const claimToDecide = (overrides: Parameters<typeof makeClaim>[0] = {}) => ({
  ...makeClaim(overrides),
  draw: {
    id: DRAW_ID,
    drawNo: 24,
    thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
  },
  user: { username: 'mya' },
});

/** A claim as the detail reads it. */
const claimDetail = (overrides: Parameters<typeof makeClaim>[0] = {}) => ({
  ...makeClaim(overrides),
  draw: {
    id: DRAW_ID,
    drawNo: 24,
    thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
    exchangeRate: new Prisma.Decimal('75.0000'),
    publishedAt: new Date('2026-11-01T09:00:00Z'),
    claimDeadlineAt: new Date('2027-01-30T09:00:00Z'),
  },
  user: { ...CUSTOMER, createdAt: new Date('2026-10-12T10:00:00Z') },
  decidedBy: null,
  payouts: [
    {
      ...makePayout({
        id: 'payout-1',
        ticketId: 't1',
        status: LotteryPayoutStatus.REQUESTED,
        claimId: CLAIM_ID,
      }),
      ticket: {
        ticketNo: 'MFL-24-000001',
        number: '123456',
        createdAt: new Date('2026-10-20T10:00:00Z'),
      },
    },
  ],
});

/** One row of the list SQL as Postgres answers it. */
const listRow = (overrides: Record<string, unknown> = {}) => ({
  id: CLAIM_ID,
  key: CLAIM_ID,
  status: 'REQUESTED',
  drawId: DRAW_ID,
  userId: 'user-1',
  ticketsCount: 3,
  baht: '6000.00',
  ks: '450000.00',
  requestedAt: new Date('2026-11-01T09:42:00Z'),
  decidedAt: null,
  decidedByUserId: null,
  rejectReason: null,
  rejectNote: null,
  paidAtPublish: false,
  transactionId: null,
  drawNo: 24,
  thaiDrawDate: '2026-11-01',
  ...overrides,
});

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CodedHttpException
        ? { status: error.getStatus(), code: error.code, extra: error.extra }
        : error,
  );

/** The marker every claims query starts with. */
const nameOf = (query: Prisma.Sql): string =>
  /lottery-claims:([a-z-]+)/.exec(query.strings.join('?'))?.[1] ?? '?';

const isSql = (value: unknown): value is Prisma.Sql =>
  typeof value === 'object' &&
  value !== null &&
  'strings' in value &&
  'values' in value;

describe('LotteryClaimsAdminService', () => {
  let service: LotteryClaimsAdminService;
  let answers: Record<string, unknown[]>;
  let queries: Prisma.Sql[];
  let locks: RawCall[];
  let prisma: {
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
    user: Record<'findMany', jest.Mock>;
    wallet: Record<'findUnique', jest.Mock>;
    lotteryClaim: Record<'findUnique' | 'count' | 'update', jest.Mock>;
    lotteryPayout: Record<'aggregate' | 'updateMany', jest.Mock>;
    transaction: Record<'create', jest.Mock>;
  };
  let audit: { record: jest.Mock };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: { notifyUserBalanceUpdated: jest.Mock };

  /** Every marked query sent, with its SQL text and bound values. */
  const sent = (name: string) =>
    queries
      .filter((query) => nameOf(query) === name)
      .map((query) => ({ sql: query.strings.join('?'), values: query.values }));

  beforeEach(async () => {
    answers = {};
    queries = [];
    locks = [];
    prisma = {
      // Marked queries come as Prisma.Sql objects; the row lock as a tagged template.
      $queryRaw: jest.fn((first: unknown, ...rest: unknown[]) => {
        if (isSql(first)) {
          queries.push(first);
          return Promise.resolve(answers[nameOf(first)] ?? []);
        }
        locks.push([first as TemplateStringsArray, ...rest]);
        return Promise.resolve([]);
      }),
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      user: { findMany: jest.fn().mockResolvedValue([CUSTOMER, STAFF]) },
      wallet: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ balance: new Prisma.Decimal('198500.00') }),
      },
      lotteryClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
      },
      lotteryPayout: {
        aggregate: jest.fn().mockResolvedValue({
          _count: 3,
          _sum: { ks: new Prisma.Decimal('450000.00') },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      transaction: {
        create: jest.fn().mockResolvedValue({ id: 'txn-1' }),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    walletService = {
      creditWithinTransaction: jest.fn(
        (_tx: unknown, userId: string, amount: number) =>
          Promise.resolve({
            userId,
            balance: new Prisma.Decimal('198500.00').add(amount),
          }),
      ),
    };
    gateway = { notifyUserBalanceUpdated: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryClaimsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
      ],
    }).compile();
    service = module.get(LotteryClaimsAdminService);
  });

  describe('list', () => {
    it('defaults to the waiting claims, oldest request first, 25 a page, and hydrates the customers in one query', async () => {
      answers.list = [listRow()];
      answers.count = [{ total: 3 }];

      const page = await service.list({});

      const [list] = sent('list');
      expect(list.sql).toContain(
        `c."status" = 'REQUESTED'::"LotteryClaimStatus"`,
      );
      expect(list.sql).not.toContain('UNION ALL');
      expect(list.sql).not.toContain('bool_or');
      expect(list.sql).toContain('ORDER BY r."requestedAt" ASC');
      expect(list.values).toEqual([25, 0]);
      const [count] = sent('count');
      expect(count.sql).toContain('COUNT(*)::int AS "total"');
      expect(count.values).toEqual([]);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-1'] } },
        select: {
          id: true,
          username: true,
          displayName: true,
          phone: true,
          email: true,
        },
      });
      expect(page).toEqual({
        items: [
          {
            id: CLAIM_ID,
            key: CLAIM_ID,
            status: 'requested',
            drawId: DRAW_ID,
            drawNo: 24,
            thaiDrawDate: '2026-11-01',
            user: CUSTOMER,
            ticketsCount: 3,
            baht: '6000.00',
            ks: '450000.00',
            requestedAt: new Date('2026-11-01T09:42:00Z'),
            decidedAt: null,
            decidedBy: null,
            rejectReason: null,
            rejectNote: null,
            paidAtPublish: false,
            transactionId: null,
          },
        ],
        total: 3,
        page: 1,
        pageSize: 25,
      });
    });

    it('lists paid claims newest decision first with the decider and the transaction, and rejected ones with the reason', async () => {
      answers.list = [
        listRow({
          status: 'PAID',
          decidedAt: new Date('2026-11-02T04:10:00Z'),
          decidedByUserId: 'admin-1',
          transactionId: 'txn-1',
          paidAtPublish: true,
        }),
        listRow({
          id: 'claim-2',
          key: 'claim-2',
          status: 'REJECTED',
          decidedAt: new Date('2026-11-02T03:00:00Z'),
          decidedByUserId: 'admin-1',
          rejectReason: 'SUSPICIOUS_ACCOUNT',
          rejectNote: 'Three accounts, one phone',
        }),
      ];
      answers.count = [{ total: 2 }];

      const page = await service.list({
        status: 'paid',
        page: 2,
        pageSize: 10,
      });

      const [list] = sent('list');
      expect(list.sql).toContain(`c."status" = 'PAID'::"LotteryClaimStatus"`);
      expect(list.sql).toContain('ORDER BY r."decidedAt" DESC NULLS LAST');
      expect(list.values).toEqual([10, 10]);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['user-1', 'admin-1'] } },
        }),
      );
      expect(page.items[0]).toMatchObject({
        status: 'paid',
        decidedAt: new Date('2026-11-02T04:10:00Z'),
        decidedBy: {
          id: 'admin-1',
          username: 'admin.blake',
          displayName: 'Blake',
        },
        transactionId: 'txn-1',
        paidAtPublish: true,
      });
      expect(page.items[1]).toMatchObject({
        id: 'claim-2',
        status: 'rejected',
        rejectReason: 'suspicious_account',
        rejectNote: 'Three accounts, one phone',
      });
    });

    it('synthesises the "not requested" rows from the UNCLAIMED payouts grouped by draw and customer — never from lottery_claims', async () => {
      answers.list = [
        listRow({
          id: null,
          key: `${DRAW_ID}:user-1`,
          status: 'UNCLAIMED',
          ticketsCount: 2,
          baht: '8000.00',
          ks: '600000.00',
          requestedAt: null,
          thaiDrawDate: new Date('2026-11-01T00:00:00Z'),
        }),
      ];
      answers.count = [{ total: 1 }];

      const page = await service.list({ status: 'not_requested' });

      const [list] = sent('list');
      expect(list.sql).toContain(
        `p."status" = 'UNCLAIMED'::"LotteryPayoutStatus"`,
      );
      expect(list.sql).toContain(
        'GROUP BY p."drawId", p."userId", d."publishedAt"',
      );
      expect(list.sql).not.toContain('FROM "lottery_claims"');
      expect(list.sql).toContain(
        'ORDER BY r."at" DESC NULLS LAST, r."sortKs" DESC',
      );
      expect(page.items[0]).toEqual(
        expect.objectContaining({
          id: null,
          key: `${DRAW_ID}:user-1`,
          status: 'not_requested',
          ticketsCount: 2,
          baht: '8000.00',
          ks: '600000.00',
          thaiDrawDate: '2026-11-01',
          requestedAt: null,
          decidedAt: null,
          decidedBy: null,
          paidAtPublish: false,
        }),
      );
    });

    it('"all" unions the claims with the unclaimed groups, waiting first, and narrows both by draw and search', async () => {
      answers.list = [];
      answers.count = [{ total: 0 }];

      const page = await service.list({
        status: 'all',
        drawId: DRAW_ID,
        q: 'MFL-24',
      });

      const [list] = sent('list');
      expect(list.sql).toContain('UNION ALL');
      expect(list.sql).toContain('ORDER BY r."rank" ASC');
      // The claims half: no status filter, the draw, and the EXISTS search
      // over the claim's tickets and its customer.
      expect(list.sql).not.toContain(
        `c."status" = 'REQUESTED'::"LotteryClaimStatus"\n`,
      );
      expect(list.sql).toContain('c."drawId" = ?');
      expect(list.sql).toContain('cp."claimId" = c."id"');
      expect(list.sql).toContain('ct."ticketNo" ILIKE ?');
      // The unclaimed half: the draw and a HAVING over the group's tickets and customer.
      expect(list.sql).toContain('p."drawId" = ?');
      expect(list.sql).toContain('HAVING bool_or(t."ticketNo" ILIKE ?');
      // The prefix for ticket / lottery numbers, "contains" for the customer, each half once.
      expect(list.values).toEqual([
        DRAW_ID,
        'MFL-24%',
        'MFL-24%',
        '%MFL-24%',
        '%MFL-24%',
        '%MFL-24%',
        DRAW_ID,
        'MFL-24%',
        'MFL-24%',
        '%MFL-24%',
        '%MFL-24%',
        '%MFL-24%',
        25,
        0,
      ]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    });

    it('escapes LIKE’s wildcards in a search term', () => {
      expect(escapeLike('50%_x\\')).toBe('50\\%\\_x\\\\');
      expect(escapeLike('mya')).toBe('mya');
    });
  });

  describe('summary', () => {
    it('answers the tiles from one query, "today" being the Myanmar calendar day', async () => {
      answers.summary = [
        {
          waitingClaims: 3,
          waitingKs: '650000.00',
          paidTodayClaims: 2,
          paidTodayKs: '300000.00',
          notRequestedCustomers: 4,
          notRequestedTickets: 5,
          notRequestedKs: '200000.00',
          rejectedClaims: 1,
          rejectedKs: '50000.00',
          expiredTickets: 0,
          expiredKs: '0.00',
        },
      ];

      const summary = await service.summary(undefined, NOW);

      const [query] = sent('summary');
      expect(query.values).toEqual([
        MMT_DAY_START,
        MMT_DAY_END,
        MMT_DAY_START,
        MMT_DAY_END,
      ]);
      expect(query.sql).toContain(
        `c."status" = 'PAID'::"LotteryClaimStatus" AND c."decidedAt" >= ? AND c."decidedAt" < ?`,
      );
      expect(query.sql).toContain('COUNT(DISTINCT p."userId")');
      expect(query.sql).not.toContain('"drawId" = ?');
      expect(summary).toEqual({
        waiting: { claims: 3, ks: '650000.00' },
        paidToday: { claims: 2, ks: '300000.00' },
        notRequested: { customers: 4, tickets: 5, ks: '200000.00' },
        rejected: { claims: 1, ks: '50000.00' },
        expired: { tickets: 0, ks: '0.00' },
      });
    });

    it('narrows every tile to one draw, and answers zeros / "0.00" for an empty table', async () => {
      const summary = await service.summary(DRAW_ID, NOW);
      const [query] = sent('summary');
      expect(query.values.filter((v) => v === DRAW_ID)).toHaveLength(11);
      expect(summary).toEqual({
        waiting: { claims: 0, ks: '0.00' },
        paidToday: { claims: 0, ks: '0.00' },
        notRequested: { customers: 0, tickets: 0, ks: '0.00' },
        rejected: { claims: 0, ks: '0.00' },
        expired: { tickets: 0, ks: '0.00' },
      });
    });
  });

  describe('detail', () => {
    it('reads the claim with its draw, customer, decider and ticket lines, and adds the customer panel', async () => {
      prisma.lotteryClaim.findUnique.mockResolvedValue(claimDetail());
      prisma.lotteryClaim.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const detail = await service.detail(CLAIM_ID, NOW);

      expect(prisma.lotteryClaim.findUnique).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
        include: {
          draw: {
            select: {
              id: true,
              drawNo: true,
              thaiDrawDate: true,
              exchangeRate: true,
              publishedAt: true,
              claimDeadlineAt: true,
            },
          },
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
              email: true,
              createdAt: true,
            },
          },
          decidedBy: {
            select: { id: true, username: true, displayName: true },
          },
          payouts: {
            orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
            include: {
              ticket: {
                select: { ticketNo: true, number: true, createdAt: true },
              },
            },
          },
        },
      });
      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { balance: true },
      });
      expect(prisma.lotteryClaim.count).toHaveBeenNthCalledWith(1, {
        where: {
          userId: 'user-1',
          status: LotteryClaimStatus.PAID,
          id: { not: CLAIM_ID },
        },
      });
      expect(prisma.lotteryClaim.count).toHaveBeenNthCalledWith(2, {
        where: {
          userId: 'user-1',
          status: LotteryClaimStatus.REJECTED,
          id: { not: CLAIM_ID },
        },
      });
      expect(detail).toEqual({
        id: CLAIM_ID,
        key: CLAIM_ID,
        status: 'requested',
        drawId: DRAW_ID,
        drawNo: 24,
        thaiDrawDate: '2026-11-01',
        user: CUSTOMER,
        ticketsCount: 3,
        baht: '6000.00',
        ks: '450000.00',
        requestedAt: new Date('2026-11-01T09:42:00Z'),
        decidedAt: null,
        decidedBy: null,
        rejectReason: null,
        rejectNote: null,
        paidAtPublish: false,
        transactionId: null,
        customer: {
          memberSince: new Date('2026-10-12T10:00:00Z'),
          walletBalance: '198500.00',
          earlierClaims: { paid: 1, rejected: 0 },
          // 12 days and 8 hours old → 12 full days, under the 30-day badge.
          accountAgeDays: 12,
          isNewAccount: true,
        },
        tickets: [
          {
            ticketNo: 'MFL-24-000001',
            number: '123456',
            groups: [
              { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 300_000 },
            ],
            baht: '4000.00',
            ks: '300000.00',
            boughtAt: new Date('2026-10-20T10:00:00Z'),
          },
        ],
        draw: {
          id: DRAW_ID,
          drawNo: 24,
          thaiDrawDate: '2026-11-01',
          exchangeRate: 75,
          publishedAt: new Date('2026-11-01T09:00:00Z'),
          claimDeadlineAt: new Date('2027-01-30T09:00:00Z'),
        },
      });
      expect(NEW_ACCOUNT_DAYS).toBe(30);
    });

    it('is not a new account at 30 days, shows "0.00" without a wallet, and 404s an unknown claim', async () => {
      prisma.lotteryClaim.findUnique.mockResolvedValue({
        ...claimDetail(),
        user: { ...CUSTOMER, createdAt: new Date('2026-09-24T18:00:00Z') },
      });
      prisma.wallet.findUnique.mockResolvedValue(null);
      const detail = await service.detail(CLAIM_ID, NOW);
      expect(detail.customer).toMatchObject({
        accountAgeDays: 30,
        isNewAccount: false,
        walletBalance: '0.00',
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(null);
      await expect(
        codeOf(service.detail(CLAIM_ID, NOW)),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.CLAIM_NOT_FOUND,
      });
    });
  });

  describe('confirm', () => {
    it('pays the claim ONCE inside one transaction under the claim’s row lock: one credit, one LOTTERY_PRIZE row, payouts and claim PAID, the draw’s total added to, one audit row, then the balance push', async () => {
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(claimToDecide())
        .mockResolvedValueOnce(
          claimDetail({
            status: LotteryClaimStatus.PAID,
            decidedAt: NOW,
            decidedByUserId: admin.id,
            transactionId: 'txn-1',
          }),
        );
      prisma.lotteryClaim.update.mockResolvedValue(
        makeClaim({
          status: LotteryClaimStatus.PAID,
          decidedAt: NOW,
          decidedByUserId: admin.id,
          transactionId: 'txn-1',
        }),
      );

      const detail = await service.confirm(CLAIM_ID, admin, NOW);

      // One interactive transaction on the publish service's budget.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      });
      // The claim's row lock first, then the re-read under it.
      expect(locks).toHaveLength(1);
      expect(locks[0][0].join('?')).toContain(
        'SELECT "id" FROM "lottery_claims" WHERE "id" = ? FOR UPDATE',
      );
      expect(locks[0][1]).toBe(CLAIM_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryClaim.findUnique.mock.invocationCallOrder[0],
      );
      // The total re-summed from the payouts still REQUESTED under the claim.
      expect(prisma.lotteryPayout.aggregate).toHaveBeenCalledWith({
        where: { claimId: CLAIM_ID, status: LotteryPayoutStatus.REQUESTED },
        _count: true,
        _sum: { ks: true },
      });
      // ONE credit for the whole claim and ONE COMPLETED LOTTERY_PRIZE row.
      expect(walletService.creditWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.creditWithinTransaction).toHaveBeenCalledWith(
        prisma,
        'user-1',
        450_000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      const txn = prisma.transaction.create.mock.calls[0][0] as {
        data: {
          userId: string;
          type: string;
          amount: Prisma.Decimal;
          status: string;
        };
      };
      expect(txn.data.userId).toBe('user-1');
      expect(txn.data.type).toBe(TransactionType.LOTTERY_PRIZE);
      expect(txn.data.amount.toFixed(2)).toBe('450000.00');
      expect(txn.data.status).toBe('COMPLETED');
      // The payouts PAID (the claim carries the transaction — payouts.transactionId is unique per row).
      expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledWith({
        where: { claimId: CLAIM_ID, status: LotteryPayoutStatus.REQUESTED },
        data: { status: LotteryPayoutStatus.PAID },
      });
      expect(prisma.lotteryClaim.update).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
        data: {
          status: LotteryClaimStatus.PAID,
          decidedAt: NOW,
          decidedByUserId: admin.id,
          transactionId: 'txn-1',
        },
      });
      // The draw's prizesPaidKs grows by the claim, null-safe.
      const [drawSql, ks, drawId] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(drawSql.join('?')).toContain(
        'SET "prizesPaidKs" = COALESCE("prizesPaidKs", 0) + ?::numeric WHERE "id" = ?',
      );
      expect(ks).toBe('450000.00');
      expect(drawId).toBe(DRAW_ID);
      // One audit row in the same transaction.
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'lottery_claim.confirm',
        actor: admin,
        target: {
          type: 'lottery_claim',
          id: CLAIM_ID,
          label: 'Draw 24 (2026-11-01) · @mya',
        },
        before: expect.objectContaining({ status: 'REQUESTED', ks: 450_000 }),
        after: expect.objectContaining({
          status: 'PAID',
          transactionId: 'txn-1',
          decidedByUserId: admin.id,
        }),
        metadata: {
          drawNo: 24,
          ticketsCount: 3,
          ks: 450_000,
          transactionId: 'txn-1',
        },
        tx: prisma,
      });
      // The balance push comes AFTER the writes (after commit), with the new balance.
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        'user-1',
        648_500,
      );
      expect(
        gateway.notifyUserBalanceUpdated.mock.invocationCallOrder[0],
      ).toBeGreaterThan(audit.record.mock.invocationCallOrder[0]);
      // The answer is the detail, re-read.
      expect(detail).toMatchObject({
        id: CLAIM_ID,
        status: 'paid',
        transactionId: 'txn-1',
      });
    });

    it('confirms a 0 Ks claim without a credit, a transaction or a balance push', async () => {
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(
          claimToDecide({
            ks: new Prisma.Decimal(0),
            baht: new Prisma.Decimal(0),
          }),
        )
        .mockResolvedValueOnce(
          claimDetail({ status: LotteryClaimStatus.PAID }),
        );
      prisma.lotteryPayout.aggregate.mockResolvedValue({
        _count: 3,
        _sum: { ks: new Prisma.Decimal(0) },
      });
      prisma.lotteryClaim.update.mockResolvedValue(
        makeClaim({ status: LotteryClaimStatus.PAID }),
      );

      await service.confirm(CLAIM_ID, admin, NOW);

      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryClaim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: LotteryClaimStatus.PAID,
            transactionId: null,
          }),
        }),
      );
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('refuses a claim that is not waiting (409 CLAIM_STATE) and pays nothing', async () => {
      prisma.lotteryClaim.findUnique.mockResolvedValue(
        claimToDecide({ status: LotteryClaimStatus.PAID }),
      );
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_STATE,
        extra: { status: 'paid' },
      });

      prisma.lotteryClaim.findUnique.mockResolvedValue(
        claimToDecide({ status: LotteryClaimStatus.REJECTED }),
      );
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toMatchObject({
        code: LOTTERY_ERRORS.CLAIM_STATE,
        extra: { status: 'rejected' },
      });

      expect(prisma.lotteryPayout.aggregate).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
      expect(prisma.lotteryClaim.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('never pays a drifted claim: a payout count or a Ks sum that differs is 409 CLAIM_TOTAL_MISMATCH with the figures', async () => {
      prisma.lotteryClaim.findUnique.mockResolvedValue(claimToDecide());
      prisma.lotteryPayout.aggregate.mockResolvedValue({
        _count: 2,
        _sum: { ks: new Prisma.Decimal('450000.00') },
      });
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_TOTAL_MISMATCH,
        extra: {
          details: {
            ticketsCount: 3,
            payouts: 2,
            ks: 450_000,
            payoutsKs: 450_000,
          },
        },
      });

      prisma.lotteryPayout.aggregate.mockResolvedValue({
        _count: 3,
        _sum: { ks: new Prisma.Decimal('450000.01') },
      });
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toMatchObject({
        code: LOTTERY_ERRORS.CLAIM_TOTAL_MISMATCH,
        extra: { details: { payoutsKs: 450_000.01 } },
      });

      // No payouts at all under the claim reads as 0 Ks, not as a match.
      prisma.lotteryPayout.aggregate.mockResolvedValue({
        _count: 0,
        _sum: { ks: null },
      });
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toMatchObject({ code: LOTTERY_ERRORS.CLAIM_TOTAL_MISMATCH });

      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
      expect(prisma.lotteryClaim.update).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('404s an unknown claim after taking its lock, and pays nothing', async () => {
      await expect(
        codeOf(service.confirm(CLAIM_ID, admin, NOW)),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.CLAIM_NOT_FOUND,
      });
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('turns a waiting claim and its payouts REJECTED with the reason and note, audited, and moves no money', async () => {
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(claimToDecide())
        .mockResolvedValueOnce(
          claimDetail({
            status: LotteryClaimStatus.REJECTED,
            rejectReason: LotteryClaimRejectReason.OTHER,
            rejectNote: 'Ticket photo does not match',
          }),
        );
      prisma.lotteryClaim.update.mockResolvedValue(
        makeClaim({
          status: LotteryClaimStatus.REJECTED,
          decidedAt: NOW,
          decidedByUserId: admin.id,
          rejectReason: LotteryClaimRejectReason.OTHER,
          rejectNote: 'Ticket photo does not match',
        }),
      );

      const detail = await service.reject(
        CLAIM_ID,
        { reason: 'other', note: 'Ticket photo does not match' },
        admin,
        NOW,
      );

      expect(locks[0][0].join('?')).toContain(
        'SELECT "id" FROM "lottery_claims" WHERE "id" = ? FOR UPDATE',
      );
      expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledWith({
        where: { claimId: CLAIM_ID, status: LotteryPayoutStatus.REQUESTED },
        data: { status: LotteryPayoutStatus.REJECTED },
      });
      expect(prisma.lotteryClaim.update).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
        data: {
          status: LotteryClaimStatus.REJECTED,
          decidedAt: NOW,
          decidedByUserId: admin.id,
          rejectReason: LotteryClaimRejectReason.OTHER,
          rejectNote: 'Ticket photo does not match',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_claim.reject',
          actor: admin,
          target: expect.objectContaining({
            type: 'lottery_claim',
            id: CLAIM_ID,
          }),
          before: expect.objectContaining({ status: 'REQUESTED' }),
          after: expect.objectContaining({
            status: 'REJECTED',
            rejectReason: 'OTHER',
            rejectNote: 'Ticket photo does not match',
          }),
          metadata: {
            drawNo: 24,
            ticketsCount: 3,
            ks: 450_000,
            reason: 'other',
          },
          tx: prisma,
        }),
      );
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      expect(detail).toMatchObject({
        status: 'rejected',
        rejectReason: 'other',
        rejectNote: 'Ticket photo does not match',
      });
    });

    it('stores a preset reason with no note as null, and refuses a claim that is not waiting', async () => {
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(claimToDecide())
        .mockResolvedValueOnce(
          claimDetail({ status: LotteryClaimStatus.REJECTED }),
        );
      prisma.lotteryClaim.update.mockResolvedValue(
        makeClaim({ status: LotteryClaimStatus.REJECTED }),
      );
      await service.reject(
        CLAIM_ID,
        { reason: 'duplicate_request' },
        admin,
        NOW,
      );
      expect(prisma.lotteryClaim.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rejectReason: LotteryClaimRejectReason.DUPLICATE_REQUEST,
            rejectNote: null,
          }),
        }),
      );

      jest.clearAllMocks();
      prisma.lotteryClaim.findUnique.mockResolvedValue(
        claimToDecide({ status: LotteryClaimStatus.PAID }),
      );
      await expect(
        codeOf(
          service.reject(CLAIM_ID, { reason: 'other', note: 'x' }, admin, NOW),
        ),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.CLAIM_STATE,
        extra: { status: 'paid' },
      });
      expect(prisma.lotteryClaim.update).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('reopen', () => {
    it('puts a rejected claim and its payouts back to REQUESTED, clears the decision and the reason, and audits the previous reason', async () => {
      const rejected = claimToDecide({
        status: LotteryClaimStatus.REJECTED,
        decidedAt: new Date('2026-11-02T03:00:00Z'),
        decidedByUserId: 'admin-0',
        rejectReason: LotteryClaimRejectReason.SUSPICIOUS_ACCOUNT,
        rejectNote: 'Three accounts, one phone',
      });
      prisma.lotteryClaim.findUnique
        .mockResolvedValueOnce(rejected)
        .mockResolvedValueOnce(claimDetail());
      prisma.lotteryClaim.update.mockResolvedValue(makeClaim());

      const detail = await service.reopen(CLAIM_ID, admin, NOW);

      expect(prisma.lotteryPayout.updateMany).toHaveBeenCalledWith({
        where: { claimId: CLAIM_ID, status: LotteryPayoutStatus.REJECTED },
        data: { status: LotteryPayoutStatus.REQUESTED },
      });
      expect(prisma.lotteryClaim.update).toHaveBeenCalledWith({
        where: { id: CLAIM_ID },
        data: {
          status: LotteryClaimStatus.REQUESTED,
          decidedAt: null,
          decidedByUserId: null,
          rejectReason: null,
          rejectNote: null,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_claim.reopen',
          before: expect.objectContaining({
            status: 'REJECTED',
            rejectReason: 'SUSPICIOUS_ACCOUNT',
          }),
          after: expect.objectContaining({
            status: 'REQUESTED',
            rejectReason: null,
          }),
          metadata: {
            drawNo: 24,
            ticketsCount: 3,
            ks: 450_000,
            previousReason: 'suspicious_account',
            previousNote: 'Three accounts, one phone',
          },
          tx: prisma,
        }),
      );
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(detail.status).toBe('requested');
    });

    it('refuses to reopen a claim that is waiting or paid', async () => {
      for (const status of [
        LotteryClaimStatus.REQUESTED,
        LotteryClaimStatus.PAID,
      ]) {
        prisma.lotteryClaim.findUnique.mockResolvedValue(
          claimToDecide({ status }),
        );
        await expect(
          codeOf(service.reopen(CLAIM_ID, admin, NOW)),
        ).resolves.toMatchObject({
          status: 409,
          code: LOTTERY_ERRORS.CLAIM_STATE,
        });
      }
      expect(prisma.lotteryClaim.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  it('labels a claim for the audit log by its draw and its customer', () => {
    expect(claimLabel(claimToDecide())).toBe('Draw 24 (2026-11-01) · @mya');
  });
});
