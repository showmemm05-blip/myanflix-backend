import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  LotteryClaimStatus,
  LotteryDrawStatus,
  LotteryPayoutStatus,
  LotteryResultSource,
  LotteryResultStatus,
  LotteryTicketStatus,
  Prisma,
  Role,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { WalletService } from '../../wallet/wallet.service';
import {
  DRAW_ID,
  makeDraw,
  makeResult,
  makeSheet,
  RESULT_ID,
} from '../../../test/lottery-fixtures';
import { LotteryDrawsAdminService } from '../lottery-draws-admin.service';
import { LOTTERY_ERRORS } from '../lottery-errors';
import { LotterySettingsService } from '../lottery-settings.service';
import { LotteryResultsService } from './lottery-results.service';
import {
  LotteryPublishService,
  PUBLISH_CHUNK_SIZE,
  PUBLISH_TRANSACTION_MAX_WAIT_MS,
  PUBLISH_TRANSACTION_TIMEOUT_MS,
  tally,
  winnerSearchWhere,
} from './lottery-publish.service';
import { parseStoredPrizeGroups } from './prize-groups';

type RawCall = [TemplateStringsArray, ...unknown[]];

const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

const NOW = new Date('2026-11-01T09:00:00Z');
/** The settings' 90 days after NOW — what every publish in this spec stamps as the claim deadline. */
const DEADLINE = new Date('2027-01-30T09:00:00Z');

const SETTINGS = {
  id: 'settings-1',
  ticketPrice: new Prisma.Decimal(1000),
  maxPerNumber: 20,
  exchangeRate: new Prisma.Decimal('75'),
  salesCloseMinutesBefore: 60,
  frameUrl: null,
  resultsUrl: null,
  resultsSourceKind: 'thai_lotto_json',
  claimDeadlineDays: 90,
  updatedByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  updatedBy: null,
};

/** The counters the finish writes: the prize total awarded, what the PAID rows already sum to (0 for a fresh publish), the deadline. */
const counters = (
  winnersCount: number,
  prizeTotalKs: string | number,
  prizesPaidKs: string | number = 0,
) => ({
  winnersCount,
  prizeTotalKs: new Prisma.Decimal(prizeTotalKs),
  prizesPaidKs: new Prisma.Decimal(prizesPaidKs),
  claimDeadlineAt: DEADLINE,
});

/**
 * The finish's two reads of lottery_payouts, as Postgres answers them: every
 * payout of the draw (count + sum), then the PAID ones alone (sum; NULL over
 * no rows).
 */
const payoutTotals =
  (count: number, ks: string | number, paidKs: string | number = 0) =>
  ({ where }: { where: { status?: LotteryPayoutStatus } }) =>
    Promise.resolve(
      where.status === LotteryPayoutStatus.PAID
        ? { _sum: { ks: paidKs === 0 ? null : new Prisma.Decimal(paidKs) } }
        : {
            _count: count,
            _sum: { ks: count === 0 ? null : new Prisma.Decimal(ks) },
          },
    );

/**
 * The fixture sheet with front3 and back2 moved off 123456, so ticket
 * 123456 wins exactly two groups: first (6,000,000) + back3 (4,000).
 */
const TWO_GROUP_SHEET = makeSheet({
  front3: { numbers: ['999', '987'] },
  back2: { numbers: ['99'] },
});

const closedDraw = (overrides: Parameters<typeof makeDraw>[0] = {}) =>
  makeDraw({
    status: LotteryDrawStatus.CLOSED,
    openedAt: new Date('2026-10-19T08:00:00Z'),
    closedAt: new Date('2026-11-01T06:30:00Z'),
    ...overrides,
  });

const fetchedResult = (
  groups: unknown = TWO_GROUP_SHEET,
  overrides: Parameters<typeof makeResult>[0] = {},
) =>
  makeResult({
    status: LotteryResultStatus.FETCHED,
    source: LotteryResultSource.MANUAL,
    groups: groups as Prisma.JsonValue,
    ...overrides,
  });

/** Three tickets: 123456 (first + back3), 000001 (back3), 777777 (nothing). */
const TICKETS = [
  { id: 't1', ticketNo: 'MFL-24-000001', userId: 'user-1', number: '123456' },
  { id: 't2', ticketNo: 'MFL-24-000002', userId: 'user-2', number: '000001' },
  { id: 't3', ticketNo: 'MFL-24-000003', userId: 'user-1', number: '777777' },
];

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CodedHttpException
        ? { status: error.getStatus(), code: error.code, extra: error.extra }
        : error,
  );

describe('LotteryPublishService', () => {
  let service: LotteryPublishService;
  let prisma: {
    lotteryDraw: Record<
      'findUnique' | 'findUniqueOrThrow' | 'update' | 'updateMany',
      jest.Mock
    >;
    lotteryResult: Record<'upsert' | 'update', jest.Mock>;
    lotteryTicket: Record<
      'count' | 'findMany' | 'update' | 'updateMany',
      jest.Mock
    >;
    lotteryPayout: Record<
      'create' | 'aggregate' | 'findMany' | 'count',
      jest.Mock
    >;
    transaction: { create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let walletService: { creditWithinTransaction: jest.Mock };
  let gateway: { notifyUserBalanceUpdated: jest.Mock };
  let settings: { getOrCreate: jest.Mock };
  let results: {
    getOrCreateRow: jest.Mock;
    sheetOf: jest.Mock;
    rateFor: jest.Mock;
  };
  let adminDraws: { findOne: jest.Mock };
  // The draw row as the updates leave it: the flip's fields stay on it
  // when the finish writes the counters and re-reads the row, like a real
  // row would.
  let drawState: Record<string, unknown>;

  /**
   * The draw's row as the lock re-reads it, the results row, and the
   * tickets: a CLOSED draw is first read whole for the pre-flip overflow
   * check, then the chunk reads the ones still waiting (one chunk, then
   * none); a PUBLISHED draw resumes straight into the chunk.
   */
  const arrange = (
    draw = closedDraw(),
    result = fetchedResult(),
    tickets: Array<{
      id: string;
      ticketNo: string;
      userId: string;
      number: string;
    }> = TICKETS,
  ) => {
    prisma.lotteryDraw.findUnique.mockResolvedValue(draw);
    prisma.lotteryDraw.findUniqueOrThrow.mockImplementation(() =>
      Promise.resolve({ ...draw, ...drawState }),
    );
    prisma.lotteryResult.upsert.mockResolvedValue({
      ...result,
      enteredBy: null,
    });
    if (draw.status === LotteryDrawStatus.CLOSED) {
      prisma.lotteryTicket.findMany.mockResolvedValueOnce(
        tickets.map(({ number }) => ({ number })),
      );
    }
    prisma.lotteryTicket.findMany
      .mockResolvedValueOnce(tickets)
      .mockResolvedValue([]);
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    drawState = {};
    prisma = {
      lotteryDraw: {
        findUnique: jest.fn().mockResolvedValue(closedDraw()),
        findUniqueOrThrow: jest.fn(() =>
          Promise.resolve(closedDraw({ ...drawState })),
        ),
        update: jest.fn((args: { data: Record<string, unknown> }) => {
          Object.assign(drawState, args.data);
          return Promise.resolve(closedDraw({ ...drawState }));
        }),
        updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
          Object.assign(drawState, args.data);
          return Promise.resolve({ count: 1 });
        }),
      },
      lotteryResult: {
        upsert: jest
          .fn()
          .mockResolvedValue({ ...fetchedResult(), enteredBy: null }),
        update: jest.fn().mockResolvedValue(fetchedResult()),
      },
      lotteryTicket: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      lotteryPayout: {
        create: jest.fn().mockResolvedValue({ id: 'payout-1' }),
        aggregate: jest.fn(payoutTotals(0, 0)),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      transaction: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'txn-1' })
          .mockResolvedValueOnce({ id: 'txn-2' })
          .mockResolvedValue({ id: 'txn-n' }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    walletService = {
      creditWithinTransaction: jest.fn(
        (_tx: unknown, userId: string, amount: number) =>
          Promise.resolve({
            userId,
            balance: new Prisma.Decimal(1000).add(amount),
          }),
      ),
    };
    gateway = { notifyUserBalanceUpdated: jest.fn() };
    settings = { getOrCreate: jest.fn().mockResolvedValue(SETTINGS) };
    results = {
      getOrCreateRow: jest.fn((drawId: string, client?: unknown) =>
        ((client as typeof prisma | undefined) ?? prisma).lotteryResult.upsert({
          where: { drawId },
        }),
      ),
      sheetOf: jest.fn((row: { groups: unknown }) =>
        parseStoredPrizeGroups(row.groups),
      ),
      rateFor: jest.fn().mockResolvedValue(75),
    };
    adminDraws = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: DRAW_ID, status: 'published' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryPublishService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: LotterySettingsService, useValue: settings },
        { provide: LotteryResultsService, useValue: results },
        { provide: LotteryDrawsAdminService, useValue: adminDraws },
      ],
    }).compile();
    service = module.get(LotteryPublishService);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('publish — the happy path', () => {
    it('flips the draw under its row lock, awards each winner once without moving money, marks the rest, then writes the counters and one audit row', async () => {
      arrange();
      prisma.lotteryPayout.aggregate.mockImplementation(
        payoutTotals(2, '453604000.00'),
      );

      const view = await service.publish(
        DRAW_ID,
        { exchangeRate: 75.5 },
        admin,
        NOW,
      );

      // One transaction for the flip, one per chunk (the three tickets,
      // then the empty read that says "done"), one for the finish — the
      // flip on the same budget as a chunk, since it queues on the same lock.
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      });
      expect(prisma.$transaction.mock.calls[1][1]).toEqual({
        maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS,
        timeout: PUBLISH_TRANSACTION_TIMEOUT_MS,
      });
      expect(PUBLISH_CHUNK_SIZE).toBe(100);

      // The row lock first, then the re-read under it; every chunk and the finish lock again.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      const lockCall = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(lockCall[0].join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(lockCall[1]).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.findUniqueOrThrow.mock.invocationCallOrder[0],
      );

      // The flip: PUBLISHED, stamped, at the body's rate; the sheet locked too.
      expect(prisma.lotteryDraw.update).toHaveBeenNthCalledWith(1, {
        where: { id: DRAW_ID },
        data: {
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: NOW,
          publishedByUserId: admin.id,
          exchangeRate: new Prisma.Decimal('75.5'),
        },
      });
      expect(prisma.lotteryResult.update).toHaveBeenCalledWith({
        where: { id: RESULT_ID },
        data: { status: LotteryResultStatus.PUBLISHED },
      });

      // Before the flip every ticket number is read once for the overflow check …
      expect(prisma.lotteryTicket.findMany).toHaveBeenNthCalledWith(1, {
        where: { drawId: DRAW_ID },
        select: { number: true },
      });
      expect(
        prisma.lotteryTicket.findMany.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.lotteryDraw.update.mock.invocationCallOrder[0]);
      // … then the chunk reads only tickets still WAITING, oldest seq first, 100 at a time.
      expect(prisma.lotteryTicket.findMany).toHaveBeenNthCalledWith(2, {
        where: { drawId: DRAW_ID, status: LotteryTicketStatus.WAITING },
        orderBy: { seq: 'asc' },
        take: PUBLISH_CHUNK_SIZE,
        select: { id: true, ticketNo: true, userId: true, number: true },
      });

      // 123456 won first + back3: (6,000,000 + 4,000) × 75.5, exact to the satang.
      const [won1, won2] = prisma.lotteryTicket.update.mock.calls as Array<
        [
          {
            where: { id: string };
            data: { status: string; prizeKs: Prisma.Decimal };
          },
        ]
      >;
      expect(won1[0].where).toEqual({ id: 't1' });
      expect(won1[0].data.status).toBe(LotteryTicketStatus.WON);
      expect(won1[0].data.prizeKs.toFixed(2)).toBe('453302000.00');
      expect(won2[0].where).toEqual({ id: 't2' });
      expect(won2[0].data.prizeKs.toFixed(2)).toBe('302000.00');

      // NO money moves at publish: no wallet credit, no transaction row.
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();

      // The payout rows: the groups with their Baht and Ks, UNCLAIMED and
      // linked to nothing yet — the customer's claim will carry the money.
      expect(prisma.lotteryPayout.create).toHaveBeenCalledTimes(2);
      const payout1 = prisma.lotteryPayout.create.mock.calls[0][0] as {
        data: Record<string, unknown> & {
          ks: Prisma.Decimal;
          rate: Prisma.Decimal;
        };
      };
      expect(payout1.data).toMatchObject({
        drawId: DRAW_ID,
        ticketId: 't1',
        userId: 'user-1',
        baht: 6_004_000,
        transactionId: null,
        claimId: null,
        status: LotteryPayoutStatus.UNCLAIMED,
        groups: [
          {
            key: 'first',
            name: 'First prize',
            baht: 6_000_000,
            ks: 453_000_000,
          },
          { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 302_000 },
        ],
      });
      expect(payout1.data.ks.toFixed(2)).toBe('453302000.00');
      expect(payout1.data.rate.toFixed(4)).toBe('75.5000');
      expect(
        prisma.lotteryPayout.create.mock.calls[1][0] as {
          data: Record<string, unknown>;
        },
      ).toEqual({
        data: expect.objectContaining({
          ticketId: 't2',
          transactionId: null,
          claimId: null,
          status: LotteryPayoutStatus.UNCLAIMED,
        }),
      });

      // The one ticket that won nothing, in one statement.
      expect(prisma.lotteryTicket.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryTicket.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['t3'] } },
        data: { status: LotteryTicketStatus.NOT_WON },
      });

      // No balance changed, so nobody's wallet pill is pushed.
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();

      // The finish: under the lock, counters from the payouts table written
      // only while they are still unset — the prize total AWARDED, nothing
      // paid yet, the claim deadline 90 days out — and the one audit row in
      // the same transaction.
      expect(prisma.lotteryPayout.aggregate).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        _count: true,
        _sum: { ks: true },
      });
      // ... and what is PAID already — nothing, for a fresh publish.
      expect(prisma.lotteryPayout.aggregate).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, status: LotteryPayoutStatus.PAID },
        _sum: { ks: true },
      });
      expect(prisma.lotteryDraw.update).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: counters(2, '453604000.00'),
      });
      expect(prisma.$queryRaw.mock.invocationCallOrder[3]).toBeLessThan(
        prisma.lotteryDraw.updateMany.mock.invocationCallOrder[0],
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_draw.publish',
          actor: admin,
          target: {
            type: 'lottery_draw',
            id: DRAW_ID,
            label: 'Draw 24 (2026-11-01)',
          },
          before: expect.objectContaining({ status: 'CLOSED' }),
          after: expect.objectContaining({
            status: 'PUBLISHED',
            winnersCount: 2,
          }),
          metadata: {
            winners: 2,
            prizeTotalKs: 453_604_000,
            prizesPaidKs: 0,
            claimDeadlineAt: DEADLINE.toISOString(),
            rate: 75.5,
            source: 'manual',
            resumed: false,
            tickets: 3,
          },
          tx: prisma,
        }),
      );

      // The answer is the admin draw, re-read.
      expect(adminDraws.findOne).toHaveBeenCalledWith(DRAW_ID);
      expect(view).toEqual({ id: DRAW_ID, status: 'published' });
    });

    it('publishes at the settings rate when the body has none, and names the API as the source', async () => {
      arrange(
        closedDraw(),
        fetchedResult(TWO_GROUP_SHEET, { source: LotteryResultSource.API }),
      );

      await service.publish(DRAW_ID, {}, admin, NOW);

      expect(settings.getOrCreate).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryDraw.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            exchangeRate: new Prisma.Decimal('75'),
          }),
        }),
      );
      const payout = prisma.lotteryPayout.create.mock.calls[0][0] as {
        data: { ks: Prisma.Decimal; rate: Prisma.Decimal };
      };
      expect(payout.data.ks.toFixed(2)).toBe('450300000.00');
      expect(payout.data.rate.toFixed(4)).toBe('75.0000');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ rate: 75, source: 'api' }),
        }),
      );
    });

    it('publishes a draw with no tickets: no money moves, the counters are 0 and the audit row is written', async () => {
      arrange(closedDraw(), fetchedResult(), []);

      await service.publish(DRAW_ID, { exchangeRate: 75 }, admin, NOW);

      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(prisma.lotteryTicket.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.updateMany).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: counters(0, 0),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            winners: 0,
            prizeTotalKs: 0,
            prizesPaidKs: 0,
            tickets: 0,
          }),
        }),
      );
    });

    it('marks a ticket WON for a 0 Baht group with an UNCLAIMED payout like any other prize', async () => {
      arrange(
        closedDraw(),
        fetchedResult(makeSheet({ back2: { baht: 0, numbers: ['77'] } })),
        [TICKETS[2]],
      );

      await service.publish(DRAW_ID, { exchangeRate: 75 }, admin, NOW);

      expect(prisma.lotteryTicket.update).toHaveBeenCalledTimes(1);
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: 't3',
            baht: 0,
            transactionId: null,
            status: LotteryPayoutStatus.UNCLAIMED,
            groups: [{ key: 'back2', name: 'Back 2 digits', baht: 0, ks: 0 }],
          }),
        }),
      );
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('awards the same totals the preview counted', async () => {
      arrange();
      const preview = await service.preview(DRAW_ID, 75.5);
      jest.clearAllMocks();
      prisma.lotteryTicket.findMany.mockReset();
      arrange();

      await service.publish(DRAW_ID, { exchangeRate: 75.5 }, admin, NOW);

      const paid = (
        prisma.lotteryPayout.create.mock.calls as Array<
          [{ data: { ks: Prisma.Decimal; baht: number } }]
        >
      ).reduce(
        (sum, [call]) => ({
          ks: sum.ks.add(call.data.ks),
          baht: sum.baht + call.data.baht,
        }),
        { ks: new Prisma.Decimal(0), baht: 0 },
      );
      expect(preview.winners).toBe(
        prisma.lotteryPayout.create.mock.calls.length,
      );
      expect(paid.ks.toNumber()).toBe(preview.prizesKs);
      expect(paid.baht).toBe(preview.prizesBaht);
    });
  });

  describe('publish — resuming and refusing', () => {
    it('resumes a PUBLISHED draw with tickets still waiting at the rate it was published with, and never re-reads settled tickets', async () => {
      const published = closedDraw({
        status: LotteryDrawStatus.PUBLISHED,
        publishedAt: new Date('2026-11-01T08:00:00Z'),
        publishedByUserId: 'admin-0',
        exchangeRate: new Prisma.Decimal('80'),
      });
      arrange(
        published,
        fetchedResult(TWO_GROUP_SHEET, {
          status: LotteryResultStatus.PUBLISHED,
        }),
        [TICKETS[1]],
      );
      prisma.lotteryTicket.count.mockResolvedValue(1);
      prisma.lotteryPayout.aggregate.mockImplementation(
        payoutTotals(2, '480320000.00'),
      );

      await service.publish(DRAW_ID, { exchangeRate: 75.5 }, admin, NOW);

      // No flip, no pre-flip read: the only draw write is the finish.
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: counters(2, '480320000.00'),
      });
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.count).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, status: LotteryTicketStatus.WAITING },
      });
      // Only WAITING tickets are read, so a ticket paid by the first run is never paid again.
      for (const call of prisma.lotteryTicket.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >) {
        expect(call[0].where).toEqual({
          drawId: DRAW_ID,
          status: LotteryTicketStatus.WAITING,
        });
      }
      const payout = prisma.lotteryPayout.create.mock.calls[0][0] as {
        data: { ks: Prisma.Decimal; rate: Prisma.Decimal };
      };
      expect(payout.data.rate.toFixed(4)).toBe('80.0000');
      expect(payout.data.ks.toFixed(2)).toBe('320000.00');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resumed: true,
            rate: 80,
            winners: 2,
            tickets: 1,
          }),
        }),
      );
    });

    it('resuming a draw that paid its earlier chunks at publish time (before 2026-10-24) records what those PAID rows sum to, not 0', async () => {
      // One ticket was paid by the old publish (480,000,000 Ks, its own
      // LOTTERY_PRIZE row); this run awards the last one UNCLAIMED.
      arrange(
        closedDraw({
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: new Date('2026-10-20T08:00:00Z'),
          publishedByUserId: 'admin-0',
          exchangeRate: new Prisma.Decimal('80'),
        }),
        fetchedResult(TWO_GROUP_SHEET, {
          status: LotteryResultStatus.PUBLISHED,
        }),
        [TICKETS[1]],
      );
      prisma.lotteryTicket.count.mockResolvedValue(1);
      prisma.lotteryPayout.aggregate.mockImplementation(
        payoutTotals(2, '480320000.00', '480000000.00'),
      );

      await service.publish(DRAW_ID, {}, admin, NOW);

      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.aggregate).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, status: LotteryPayoutStatus.PAID },
        _sum: { ks: true },
      });
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: counters(2, '480320000.00', '480000000.00'),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resumed: true,
            winners: 2,
            prizeTotalKs: 480_320_000,
            prizesPaidKs: 480_000_000,
            tickets: 1,
          }),
        }),
      );
    });

    it('finishes a PUBLISHED draw whose every ticket is settled but whose counters were never written: no chunk, the counters and the audit row', async () => {
      arrange(
        closedDraw({
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: new Date('2026-11-01T08:00:00Z'),
          publishedByUserId: 'admin-0',
          exchangeRate: new Prisma.Decimal('80'),
        }),
        fetchedResult(TWO_GROUP_SHEET, {
          status: LotteryResultStatus.PUBLISHED,
        }),
        [],
      );
      prisma.lotteryTicket.count.mockResolvedValue(0);
      prisma.lotteryPayout.aggregate.mockImplementation(
        payoutTotals(2, '480320000.00'),
      );

      await service.publish(DRAW_ID, {}, admin, NOW);

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryPayout.create).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: counters(2, '480320000.00'),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            resumed: true,
            rate: 80,
            winners: 2,
            tickets: 0,
          }),
        }),
      );
    });

    it('writes the counters and the audit row once when two runs finish the same draw', async () => {
      // The other run wrote the counters between this run's empty chunk
      // read and its finish: the guarded write touches no row, so no
      // second audit row either.
      arrange(
        closedDraw({
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: new Date('2026-11-01T08:00:00Z'),
          publishedByUserId: 'admin-0',
          exchangeRate: new Prisma.Decimal('80'),
        }),
        fetchedResult(TWO_GROUP_SHEET, {
          status: LotteryResultStatus.PUBLISHED,
        }),
        [],
      );
      prisma.lotteryTicket.count.mockResolvedValue(0);
      prisma.lotteryDraw.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.publish(DRAW_ID, {}, admin, NOW)).resolves.toEqual({
        id: DRAW_ID,
        status: 'published',
      });

      expect(prisma.lotteryDraw.updateMany).toHaveBeenCalledWith({
        where: { id: DRAW_ID, winnersCount: null },
        data: expect.objectContaining({ winnersCount: 0 }),
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s a PUBLISHED draw whose results row is no longer PUBLISHED without reading a chunk', async () => {
      arrange(
        closedDraw({
          status: LotteryDrawStatus.PUBLISHED,
          publishedAt: new Date('2026-11-01T08:00:00Z'),
          publishedByUserId: 'admin-0',
          exchangeRate: new Prisma.Decimal('80'),
        }),
        fetchedResult(TWO_GROUP_SHEET),
        [TICKETS[1]],
      );
      prisma.lotteryTicket.count.mockResolvedValue(1);

      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
      });
      expect(prisma.lotteryTicket.findMany).not.toHaveBeenCalled();
      expect(prisma.lotteryPayout.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses, before the flip, a prize or a total that a Ks column cannot hold', async () => {
      // A sheet whose first prize is 200,000,000 Baht at 75 Ks: 15 billion Ks.
      arrange(
        closedDraw(),
        fetchedResult(makeSheet({ first: { baht: 200_000_000 } })),
      );
      await expect(
        codeOf(service.publish(DRAW_ID, { exchangeRate: 75 }, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
        extra: {
          details: {
            // 123456: 200,010,000 Baht × 75; 000001: 4,000 × 75 on top.
            maxTicketKs: 15_000_750_000,
            prizesKs: 15_001_050_000,
            ksMax: 9_999_999_999.99,
          },
        },
      });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();

      // The real sheet at a rate with one digit too many (7500 for 75).
      jest.clearAllMocks();
      prisma.lotteryTicket.findMany.mockReset();
      arrange();
      await expect(
        codeOf(service.publish(DRAW_ID, { exchangeRate: 7500 }, admin, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
        extra: { details: { maxTicketKs: 45_030_000_000 } },
      });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();

      // The dry run refuses the same way, so the dialog says so before the click.
      jest.clearAllMocks();
      prisma.lotteryTicket.findMany.mockReset();
      arrange();
      await expect(
        codeOf(service.preview(DRAW_ID, 7500)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409s a PUBLISHED draw whose every ticket is settled and whose counters are in', async () => {
      arrange(
        closedDraw({
          status: LotteryDrawStatus.PUBLISHED,
          exchangeRate: new Prisma.Decimal('80'),
          winnersCount: 2,
          prizesPaidKs: new Prisma.Decimal('480320000.00'),
        }),
      );
      prisma.lotteryTicket.count.mockResolvedValue(0);

      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'published' },
      });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.findMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409s an OPEN draw (the staff member closes it first) without touching anything', async () => {
      arrange(closedDraw({ status: LotteryDrawStatus.OPEN, closedAt: null }));

      await expect(
        codeOf(service.publish(DRAW_ID, { exchangeRate: 75 }, admin, NOW)),
      ).resolves.toEqual({
        status: 409,
        code: LOTTERY_ERRORS.DRAW_STATE,
        extra: { status: 'open' },
      });
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryResult.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.findMany).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
    });

    it('409s PENDING results, a FAILED fetch and a FETCHED sheet that is not complete', async () => {
      arrange(closedDraw(), makeResult());
      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
      });

      arrange(
        closedDraw(),
        makeResult({ status: LotteryResultStatus.FAILED, lastError: 'x' }),
      );
      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toMatchObject({ code: LOTTERY_ERRORS.RESULTS_NOT_READY });

      arrange(
        closedDraw(),
        fetchedResult(makeSheet({ fifth: { numbers: ['500100'] } })),
      );
      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toMatchObject({ code: LOTTERY_ERRORS.RESULTS_NOT_READY });

      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.findMany).not.toHaveBeenCalled();
    });

    it('404s a draw that does not exist before taking any lock', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);

      await expect(
        codeOf(service.publish(DRAW_ID, {}, admin, NOW)),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers LOTTERY_PUBLISH_INCOMPLETE when a chunk fails: the earlier chunk stands, the failed one rolled back, no counters, no audit', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(closedDraw());
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(closedDraw());
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...fetchedResult(),
        enteredBy: null,
      });
      // The pre-flip read, then two chunks: the first awards user-1, the second fails on its payout write.
      prisma.lotteryTicket.findMany
        .mockResolvedValueOnce(TICKETS.map(({ number }) => ({ number })))
        .mockResolvedValueOnce([TICKETS[0]])
        .mockResolvedValueOnce([TICKETS[1], TICKETS[2]])
        .mockResolvedValue([]);
      prisma.lotteryPayout.create
        .mockResolvedValueOnce({ id: 'payout-1' })
        .mockRejectedValueOnce(new Error('connection reset'));
      prisma.lotteryTicket.count.mockResolvedValue(2);

      const error = await codeOf(
        service.publish(DRAW_ID, { exchangeRate: 75 }, admin, NOW),
      );

      expect(error).toEqual({
        status: 500,
        code: LOTTERY_ERRORS.PUBLISH_INCOMPLETE,
        extra: { details: { awarded: 1, settled: 1, remaining: 2 } },
      });
      expect(prisma.lotteryTicket.count).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, status: LotteryTicketStatus.WAITING },
      });
      // Nothing was credited in either chunk, so no balance was pushed.
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
      // The flip happened; the finish did not.
      expect(prisma.lotteryDraw.update).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryPayout.aggregate).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'stopped after 1 tickets (1 awarded): connection reset',
        ),
        expect.any(String),
      );
    });
  });

  describe('preview', () => {
    it('counts every ticket at the settings rate without writing: winners, Baht, Ks and the groups', async () => {
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...fetchedResult(makeSheet()),
        enteredBy: null,
      });
      prisma.lotteryTicket.findMany.mockResolvedValue(
        TICKETS.map(({ number }) => ({ number })),
      );

      const preview = await service.preview(DRAW_ID);

      expect(prisma.lotteryTicket.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        select: { number: true },
      });
      // 123456 wins first + front3 + back3 + back2 (6,010,000); 000001 wins back3 (4,000).
      expect(preview).toEqual({
        rate: 75,
        winners: 2,
        tickets: 3,
        prizesBaht: 6_014_000,
        prizesKs: 451_050_000,
        byGroup: [
          { key: 'first', winners: 1, ks: 450_000_000 },
          { key: 'nearFirst', winners: 0, ks: 0 },
          { key: 'second', winners: 0, ks: 0 },
          { key: 'third', winners: 0, ks: 0 },
          { key: 'fourth', winners: 0, ks: 0 },
          { key: 'fifth', winners: 0, ks: 0 },
          { key: 'front3', winners: 1, ks: 300_000 },
          { key: 'back3', winners: 2, ks: 600_000 },
          { key: 'back2', winners: 1, ks: 150_000 },
        ],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.update).not.toHaveBeenCalled();
      expect(walletService.creditWithinTransaction).not.toHaveBeenCalled();
    });

    it('prices at the asked rate, else the draw’s own once set', async () => {
      prisma.lotteryTicket.findMany.mockResolvedValue([{ number: '123456' }]);

      const asked = await service.preview(DRAW_ID, 75.5);
      expect(asked.rate).toBe(75.5);
      expect(asked.prizesKs).toBe(453_302_000);
      expect(settings.getOrCreate).not.toHaveBeenCalled();

      prisma.lotteryDraw.findUnique.mockResolvedValue(
        closedDraw({ exchangeRate: new Prisma.Decimal('80') }),
      );
      const own = await service.preview(DRAW_ID);
      expect(own.rate).toBe(80);
      expect(own.prizesKs).toBe(480_320_000);
      expect(settings.getOrCreate).not.toHaveBeenCalled();
    });

    it('is 409 LOTTERY_RESULTS_NOT_READY without a full sheet, and 404 for a missing draw', async () => {
      prisma.lotteryResult.upsert.mockResolvedValue({
        ...makeResult(),
        enteredBy: null,
      });
      await expect(codeOf(service.preview(DRAW_ID))).resolves.toMatchObject({
        status: 409,
        code: LOTTERY_ERRORS.RESULTS_NOT_READY,
      });
      expect(prisma.lotteryTicket.findMany).not.toHaveBeenCalled();

      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(codeOf(service.preview(DRAW_ID))).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
    });

    it('tally: a draw with no tickets is all zeros, and the biggest single prize is counted but never sent', async () => {
      expect(tally([], makeSheet(), new Prisma.Decimal(75))).toMatchObject({
        rate: 75,
        winners: 0,
        tickets: 0,
        prizesBaht: 0,
        prizesKs: 0,
        maxTicketKs: 0,
      });
      expect(
        tally(TICKETS, makeSheet(), new Prisma.Decimal(75)).maxTicketKs,
      ).toBe(450_750_000);
      prisma.lotteryTicket.findMany.mockResolvedValue(TICKETS);
      expect(await service.preview(DRAW_ID)).not.toHaveProperty('maxTicketKs');
    });
  });

  describe('listWinners', () => {
    const storedWinner = {
      id: 'payout-1',
      drawId: DRAW_ID,
      ticketId: 't1',
      userId: 'user-1',
      groups: [
        { key: 'first', name: 'First prize', baht: 6_000_000, ks: 450_000_000 },
        { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 300_000 },
      ],
      baht: new Prisma.Decimal('6004000.00'),
      ks: new Prisma.Decimal('450300000.00'),
      rate: new Prisma.Decimal('75.0000'),
      transactionId: 'txn-1',
      status: LotteryPayoutStatus.PAID,
      claimId: null,
      createdAt: new Date('2026-11-01T09:00:05Z'),
      ticket: { ticketNo: 'MFL-24-000001', number: '123456' },
      user: {
        id: 'user-1',
        username: 'user_959',
        displayName: 'Mya',
        phone: '09959',
        email: null,
      },
      claim: null,
    };

    it('pages the winning tickets biggest prize first, searched on the server, with the customer, the groups and the claim', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValue([storedWinner]);
      prisma.lotteryPayout.count.mockResolvedValue(26);

      const page = await service.listWinners(DRAW_ID, {
        q: 'mya',
        page: 2,
        pageSize: 25,
      });

      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, ...winnerSearchWhere('mya') },
        orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
        skip: 25,
        take: 25,
        include: {
          ticket: { select: { ticketNo: true, number: true } },
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
              email: true,
            },
          },
          claim: {
            select: {
              id: true,
              status: true,
              decidedAt: true,
              paidAtPublish: true,
              transactionId: true,
            },
          },
        },
      });
      expect(prisma.lotteryPayout.count).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, ...winnerSearchWhere('mya') },
      });
      // A prize paid at publish (before 2026-10-24) with no claim row: paid at the payout's own time.
      expect(page).toEqual({
        items: [
          {
            ticketNo: 'MFL-24-000001',
            number: '123456',
            user: storedWinner.user,
            groups: [
              { key: 'first', baht: 6_000_000, ks: 450_000_000 },
              { key: 'back3', baht: 4000, ks: 300_000 },
            ],
            baht: 6_004_000,
            ks: 450_300_000,
            claimStatus: 'paid',
            claimId: null,
            paidAt: new Date('2026-11-01T09:00:05Z'),
            transactionId: 'txn-1',
          },
        ],
        total: 26,
        page: 2,
        pageSize: 25,
      });
    });

    it('reads each winner’s claim status from its payout, and the paid time and transaction from its claim', async () => {
      const claim = {
        id: 'claim-1',
        status: LotteryClaimStatus.PAID,
        decidedAt: new Date('2026-11-02T04:10:00Z'),
        paidAtPublish: false,
        transactionId: 'txn-claim',
      };
      prisma.lotteryPayout.findMany.mockResolvedValue([
        // Awarded, nobody asked yet.
        {
          ...storedWinner,
          status: LotteryPayoutStatus.UNCLAIMED,
          transactionId: null,
        },
        // Requested, waiting for the admin.
        {
          ...storedWinner,
          status: LotteryPayoutStatus.REQUESTED,
          transactionId: null,
          claimId: 'claim-1',
          claim: {
            ...claim,
            status: LotteryClaimStatus.REQUESTED,
            decidedAt: null,
            transactionId: null,
          },
        },
        // Paid through a claim: the claim's decision time and its one transaction.
        {
          ...storedWinner,
          status: LotteryPayoutStatus.PAID,
          transactionId: null,
          claimId: 'claim-1',
          claim,
        },
        // Paid at publish, under a backfilled claim: the payout's own time and transaction.
        {
          ...storedWinner,
          claimId: 'claim-0',
          claim: {
            ...claim,
            id: 'claim-0',
            paidAtPublish: true,
            transactionId: null,
          },
        },
        {
          ...storedWinner,
          status: LotteryPayoutStatus.REJECTED,
          transactionId: null,
          claimId: 'claim-1',
          claim: {
            ...claim,
            status: LotteryClaimStatus.REJECTED,
            transactionId: null,
          },
        },
        {
          ...storedWinner,
          status: LotteryPayoutStatus.EXPIRED,
          transactionId: null,
        },
      ]);

      const page = await service.listWinners(DRAW_ID, {});

      expect(
        page.items.map((item) => [
          item.claimStatus,
          item.claimId,
          item.paidAt,
          item.transactionId,
        ]),
      ).toEqual([
        ['not_requested', null, null, null],
        ['requested', 'claim-1', null, null],
        ['paid', 'claim-1', new Date('2026-11-02T04:10:00Z'), 'txn-claim'],
        ['paid', 'claim-0', new Date('2026-11-01T09:00:05Z'), 'txn-1'],
        ['rejected', 'claim-1', null, null],
        ['expired', null, null, null],
      ]);
    });

    it('defaults to page 1 of 20 with no search, and is empty before publish', async () => {
      const page = await service.listWinners(DRAW_ID, {});
      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { drawId: DRAW_ID },
          skip: 0,
          take: 20,
        }),
      );
      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('searches ticket numbers, number prefixes and the customer', () => {
      expect(winnerSearchWhere('12').OR).toEqual([
        { ticket: { ticketNo: { contains: '12', mode: 'insensitive' } } },
        { ticket: { number: { startsWith: '12' } } },
        {
          user: {
            OR: [
              { username: { contains: '12', mode: 'insensitive' } },
              { displayName: { contains: '12', mode: 'insensitive' } },
              { phone: { contains: '12' } },
            ],
          },
        },
      ]);
    });

    it('404s a missing draw', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(
        codeOf(service.listWinners(DRAW_ID, {})),
      ).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.lotteryPayout.findMany).not.toHaveBeenCalled();
    });
  });
});
