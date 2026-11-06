import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryPurchaseStatus,
  Prisma,
  Role,
  TransactionType,
} from '../generated/prisma/client';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { WalletService } from '../wallet/wallet.service';
import { DRAW_ID, makeDraw } from '../../test/lottery-fixtures';
import { LotteryDrawsService } from './lottery-draws.service';
import { LOTTERY_ERRORS } from './lottery-errors';
import {
  LotteryPurchasesService,
  normaliseLines,
  PURCHASE_TRANSACTION_MAX_WAIT_MS,
  PURCHASE_TRANSACTION_TIMEOUT_MS,
  purchaseStatusToWire,
} from './lottery-purchases.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const user = {
  id: 'user-1',
  username: 'user_959',
  role: Role.USER,
  appRoleId: null,
};

const KEY = '7f3b4d4e-1111-4c2a-9a9a-0123456789ab';
/** 2026-10-20 10:00 UTC = 16:30 in Myanmar, so the ref is dated 261020. */
const NOW = new Date('2026-10-20T10:00:00Z');

/** Two numbers, sent out of order: the receipt sorts them (000777 then 123456). */
const BASKET = {
  drawNo: 24,
  idempotencyKey: KEY,
  lines: [
    { number: '123456', quantity: 2 },
    { number: '000777', quantity: 3 },
  ],
};
const SORTED_LINES = [
  { number: '000777', quantity: 3 },
  { number: '123456', quantity: 2 },
];

function openDraw(overrides: Parameters<typeof makeDraw>[0] = {}) {
  return makeDraw({
    status: LotteryDrawStatus.OPEN,
    openedAt: new Date('2026-10-19T08:00:00Z'),
    nextTicketSeq: 468,
    ...overrides,
  });
}

function makeStoredPurchase(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'purchase-1',
    ref: 'LP-261020-0042',
    userId: user.id,
    drawId: DRAW_ID,
    idempotencyKey: KEY,
    total: new Prisma.Decimal(5000),
    unitPrice: new Prisma.Decimal(1000),
    status: LotteryPurchaseStatus.PAID,
    transactionId: 'txn-1',
    createdAt: new Date('2026-10-20T10:00:00Z'),
    draw: { drawNo: 24 },
    lines: SORTED_LINES,
    tickets: [
      { ticketNo: 'MFL-24-000468', number: '000777' },
      { ticketNo: 'MFL-24-000469', number: '000777' },
      { ticketNo: 'MFL-24-000470', number: '000777' },
      { ticketNo: 'MFL-24-000471', number: '123456' },
      { ticketNo: 'MFL-24-000472', number: '123456' },
    ],
    ...overrides,
  };
}

function makeP2002() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`userId`,`idempotencyKey`)',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['userId', 'idempotencyKey'] },
    },
  );
}

/** Catches the coded error a promise rejects with. */
async function codedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('LotteryPurchasesService', () => {
  let service: LotteryPurchasesService;
  let prisma: {
    lotteryDraw: Record<
      'findUnique' | 'findUniqueOrThrow' | 'update',
      jest.Mock
    >;
    lotteryPurchase: Record<
      'findUnique' | 'findFirst' | 'findMany' | 'count' | 'create',
      jest.Mock
    >;
    lotteryOffSaleNumber: { findMany: jest.Mock };
    lotteryTicket: Record<'groupBy' | 'createMany', jest.Mock>;
    transaction: { create: jest.Mock };
    wallet: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let walletService: { debitWithinTransaction: jest.Mock };
  let gateway: { notifyUserBalanceUpdated: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lotteryDraw: {
        findUnique: jest.fn().mockResolvedValue(openDraw()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(openDraw()),
        update: jest.fn().mockResolvedValue({ nextTicketSeq: 473 }),
      },
      lotteryPurchase: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'purchase-1',
          status: LotteryPurchaseStatus.PAID,
          createdAt: NOW,
        }),
      },
      lotteryOffSaleNumber: { findMany: jest.fn().mockResolvedValue([]) },
      lotteryTicket: {
        groupBy: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      transaction: { create: jest.fn().mockResolvedValue({ id: 'txn-1' }) },
      wallet: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ balance: new Prisma.Decimal(1500) }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      // The row lock answers nothing useful; nextval answers the sequence.
      $queryRaw: jest.fn((...call: RawCall) =>
        Promise.resolve(
          call[0].join('').includes('nextval') ? [{ seq: 42 }] : [],
        ),
      ),
    };
    walletService = {
      debitWithinTransaction: jest
        .fn()
        .mockResolvedValue({ balance: new Prisma.Decimal(7000) }),
    };
    gateway = { notifyUserBalanceUpdated: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryPurchasesService,
        LotteryDrawsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: RealtimeGateway, useValue: gateway },
        {
          provide: MinioService,
          useValue: { imageUrl: jest.fn((url: string | null) => url) },
        },
      ],
    }).compile();
    service = module.get(LotteryPurchasesService);
  });

  describe('create — the happy path', () => {
    it('locks the draw, debits once, writes one transaction, the purchase with its lines, and one ticket per ticket in seq order', async () => {
      const receipt = await service.create(user, BASKET, NOW);

      // One transaction, with room to queue behind other checkouts of the
      // draw and still answer before the phone's 15 s gives up.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: PURCHASE_TRANSACTION_MAX_WAIT_MS,
        timeout: PURCHASE_TRANSACTION_TIMEOUT_MS,
      });
      expect(PURCHASE_TRANSACTION_MAX_WAIT_MS).toBe(5000);
      expect(PURCHASE_TRANSACTION_TIMEOUT_MS).toBe(12000);

      // The row lock comes first, then the re-read under it.
      const lockCall = prisma.$queryRaw.mock.calls[0] as RawCall;
      expect(lockCall[0].join('?')).toContain(
        'SELECT "id" FROM "lottery_draws" WHERE "id" = ? FOR UPDATE',
      );
      expect(lockCall[1]).toBe(DRAW_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryDraw.findUniqueOrThrow.mock.invocationCallOrder[0],
      );

      // The checks ran against the locked row with the sorted numbers.
      expect(prisma.lotteryOffSaleNumber.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, number: { in: ['000777', '123456'] } },
        select: { number: true },
      });
      expect(prisma.lotteryTicket.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: user.id,
            drawId: DRAW_ID,
            number: { in: ['000777', '123456'] },
          },
        }),
      );

      // One debit of the total (5 × 1000), one COMPLETED transaction row.
      expect(walletService.debitWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        user.id,
        5000,
      );
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          userId: user.id,
          type: TransactionType.LOTTERY_PURCHASE,
          amount: new Prisma.Decimal(5000),
          status: 'COMPLETED',
        },
      });

      // The purchase: ref from the sequence and the Myanmar date, the
      // draw's price copied, the lines sorted by number.
      expect(prisma.lotteryPurchase.create).toHaveBeenCalledWith({
        data: {
          ref: 'LP-261020-0042',
          userId: user.id,
          drawId: DRAW_ID,
          idempotencyKey: KEY,
          total: new Prisma.Decimal(5000),
          unitPrice: new Prisma.Decimal(1000),
          transactionId: 'txn-1',
          lines: { create: SORTED_LINES },
        },
        select: { id: true, status: true, createdAt: true },
      });

      // Five seqs taken in one bump; the tickets run 468..472 in line order.
      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: { nextTicketSeq: { increment: 5 } },
        select: { nextTicketSeq: true },
      });
      expect(prisma.lotteryTicket.createMany).toHaveBeenCalledTimes(1);
      const rows = prisma.lotteryTicket.createMany.mock.calls[0][0].data;
      expect(rows).toEqual(
        [
          { ticketNo: 'MFL-24-000468', number: '000777', seq: 468 },
          { ticketNo: 'MFL-24-000469', number: '000777', seq: 469 },
          { ticketNo: 'MFL-24-000470', number: '000777', seq: 470 },
          { ticketNo: 'MFL-24-000471', number: '123456', seq: 471 },
          { ticketNo: 'MFL-24-000472', number: '123456', seq: 472 },
        ].map((row) => ({
          ...row,
          drawId: DRAW_ID,
          purchaseId: 'purchase-1',
          userId: user.id,
        })),
      );

      // The balance goes out after commit, once, as a number.
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.notifyUserBalanceUpdated).toHaveBeenCalledWith(
        user.id,
        7000,
      );

      expect(receipt).toEqual({
        ref: 'LP-261020-0042',
        drawNo: 24,
        lines: SORTED_LINES,
        tickets: [
          { ticketNo: 'MFL-24-000468', number: '000777' },
          { ticketNo: 'MFL-24-000469', number: '000777' },
          { ticketNo: 'MFL-24-000470', number: '000777' },
          { ticketNo: 'MFL-24-000471', number: '123456' },
          { ticketNo: 'MFL-24-000472', number: '123456' },
        ],
        total: 5000,
        unitPrice: 1000,
        status: 'paid',
        createdAt: NOW,
        balanceAfter: 7000,
      });
    });

    it('prices with the draw’s own copy of the ticket price, not a setting', async () => {
      const dearer = openDraw({ ticketPrice: new Prisma.Decimal(1500) });
      prisma.lotteryDraw.findUnique.mockResolvedValue(dearer);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(dearer);

      const receipt = await service.create(
        user,
        { ...BASKET, lines: [{ number: '123456', quantity: 1 }] },
        NOW,
      );

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        user.id,
        1500,
      );
      expect(receipt.total).toBe(1500);
      expect(receipt.unitPrice).toBe(1500);
    });

    it('lets a customer fill a number exactly up to the limit, counting what they already hold', async () => {
      prisma.lotteryTicket.groupBy.mockResolvedValue([
        { number: '123456', _count: { _all: 18 } },
      ]);

      await expect(
        service.create(
          user,
          { ...BASKET, lines: [{ number: '123456', quantity: 2 }] },
          NOW,
        ),
      ).resolves.toMatchObject({ total: 2000 });
      expect(walletService.debitWithinTransaction).toHaveBeenCalledTimes(1);
    });

    it('the largest basket (50 numbers × 20) takes one unbroken run of 1000 seqs and debits 1,000,000 once', async () => {
      const lines = Array.from({ length: 50 }, (_, i) => ({
        number: String(100000 + i * 7),
        quantity: 20,
      }));
      prisma.lotteryDraw.update.mockResolvedValue({ nextTicketSeq: 1001 });
      prisma.lotteryTicket.createMany.mockResolvedValue({ count: 1000 });

      const receipt = await service.create(user, { ...BASKET, lines }, NOW);

      expect(prisma.lotteryDraw.update).toHaveBeenCalledWith({
        where: { id: DRAW_ID },
        data: { nextTicketSeq: { increment: 1000 } },
        select: { nextTicketSeq: true },
      });
      expect(prisma.lotteryTicket.createMany).toHaveBeenCalledTimes(1);
      const rows = prisma.lotteryTicket.createMany.mock.calls[0][0]
        .data as Array<{ seq: number; ticketNo: string; number: string }>;
      expect(rows).toHaveLength(1000);
      const seqs = rows.map((row) => row.seq);
      expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
      expect(new Set(seqs).size).toBe(1000);
      expect(rows[0].ticketNo).toBe('MFL-24-000001');
      expect(rows[999].ticketNo).toBe('MFL-24-001000');
      expect(new Set(rows.map((row) => row.ticketNo)).size).toBe(1000);
      // Twenty tickets per number, in sorted number order.
      expect(rows.filter((row) => row.number === '100000')).toHaveLength(20);

      expect(walletService.debitWithinTransaction).toHaveBeenCalledTimes(1);
      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        user.id,
        1_000_000,
      );
      expect(receipt.total).toBe(1_000_000);
      expect(receipt.tickets).toHaveLength(1000);
    });

    it('multiplies a fractional price exactly (Decimal, not float): 1234.56 × 7 = 8641.92', async () => {
      const odd = openDraw({ ticketPrice: new Prisma.Decimal('1234.56') });
      prisma.lotteryDraw.findUnique.mockResolvedValue(odd);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(odd);

      const receipt = await service.create(
        user,
        {
          ...BASKET,
          lines: [
            { number: '123456', quantity: 4 },
            { number: '000777', quantity: 3 },
          ],
        },
        NOW,
      );

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        user.id,
        8641.92,
      );
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: new Prisma.Decimal('8641.92'),
        }),
      });
      expect(receipt.total).toBe(8641.92);
      expect(receipt.unitPrice).toBe(1234.56);

      // And the other edge the contract names: a half-kyat price, three tickets.
      jest.clearAllMocks();
      const half = openDraw({ ticketPrice: new Prisma.Decimal('1000.50') });
      prisma.lotteryDraw.findUnique.mockResolvedValue(half);
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(half);
      prisma.lotteryPurchase.findUnique.mockResolvedValue(null);
      await service.create(
        user,
        { ...BASKET, lines: [{ number: '123456', quantity: 3 }] },
        NOW,
      );
      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(
        prisma,
        user.id,
        3001.5,
      );
    });
  });

  describe('create — failures after the debit', () => {
    afterEach(() => {
      // The debit happened inside the transaction that then failed: the
      // rejection leaves $transaction (so a real one rolls the debit back)
      // and no balance is pushed to the app.
      expect(walletService.debitWithinTransaction).toHaveBeenCalledTimes(1);
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('lets a failed ticket insert reject the whole transaction', async () => {
      prisma.lotteryTicket.createMany.mockRejectedValue(new Error('disk full'));

      await expect(service.create(user, BASKET, NOW)).rejects.toThrow(
        'disk full',
      );
      await expect(
        prisma.$transaction.mock.results[0].value as Promise<unknown>,
      ).rejects.toThrow('disk full');
    });

    it('lets a failed seq bump reject the whole transaction', async () => {
      prisma.lotteryDraw.update.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(user, BASKET, NOW)).rejects.toThrow(
        'connection lost',
      );
      await expect(
        prisma.$transaction.mock.results[0].value as Promise<unknown>,
      ).rejects.toThrow('connection lost');
      expect(prisma.lotteryTicket.createMany).not.toHaveBeenCalled();
    });

    it('lets a failed purchase insert (not the key) reject the whole transaction', async () => {
      prisma.lotteryPurchase.create.mockRejectedValue(new Error('timeout'));

      await expect(service.create(user, BASKET, NOW)).rejects.toThrow(
        'timeout',
      );
      expect(prisma.lotteryDraw.update).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.createMany).not.toHaveBeenCalled();
    });
  });

  describe('create — refusals (nothing is debited)', () => {
    afterEach(() => {
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPurchase.create).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.createMany).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('404s an unknown draw before opening a transaction', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);

      const error = await codedError(service.create(user, BASKET, NOW));

      expect(error.code).toBe(LOTTERY_ERRORS.DRAW_NOT_FOUND);
      expect(error.getStatus()).toBe(404);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['scheduled', openDraw({ status: LotteryDrawStatus.SCHEDULED }), NOW],
      ['paused', openDraw({ status: LotteryDrawStatus.PAUSED }), NOW],
      ['closed', openDraw({ status: LotteryDrawStatus.CLOSED }), NOW],
      ['published', openDraw({ status: LotteryDrawStatus.PUBLISHED }), NOW],
      [
        'open but past its sales close time (the cron is not trusted)',
        openDraw(),
        new Date('2026-11-01T06:30:00Z'),
      ],
    ])(
      'refuses a draw that is %s with LOTTERY_SALES_CLOSED',
      async (_label, draw, now) => {
        prisma.lotteryDraw.findUnique.mockResolvedValue(draw);
        prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(draw);

        const error = await codedError(service.create(user, BASKET, now));

        expect(error.code).toBe(LOTTERY_ERRORS.SALES_CLOSED);
        expect(error.getStatus()).toBe(400);
        expect(error.extra).toEqual({
          status: draw.status.toLowerCase(),
          salesCloseAt: '2026-11-01T06:30:00.000Z',
        });
        expect(prisma.lotteryOffSaleNumber.findMany).not.toHaveBeenCalled();
      },
    );

    it('checks the status of the row read under the lock, not the one read before it', async () => {
      // Someone closed the draw between the first read and the lock.
      prisma.lotteryDraw.findUniqueOrThrow.mockResolvedValue(
        openDraw({ status: LotteryDrawStatus.CLOSED }),
      );

      const error = await codedError(service.create(user, BASKET, NOW));

      expect(error.code).toBe(LOTTERY_ERRORS.SALES_CLOSED);
    });

    it('names the numbers that are off sale and stops there', async () => {
      prisma.lotteryOffSaleNumber.findMany.mockResolvedValue([
        { number: '123456' },
      ]);

      const error = await codedError(service.create(user, BASKET, NOW));

      expect(error.code).toBe(LOTTERY_ERRORS.NUMBER_OFF_SALE);
      expect(error.getStatus()).toBe(400);
      expect(error.extra).toEqual({ details: { numbers: ['123456'] } });
      expect(prisma.lotteryTicket.groupBy).not.toHaveBeenCalled();
    });

    it('refuses a number whose held + buying would pass the draw’s limit, listing held and left', async () => {
      prisma.lotteryTicket.groupBy.mockResolvedValue([
        { number: '123456', _count: { _all: 19 } },
        { number: '000777', _count: { _all: 17 } },
      ]);

      // 123456: 19 held + 2 > 20; 000777: 17 held + 3 = 20 is fine.
      const error = await codedError(service.create(user, BASKET, NOW));

      expect(error.code).toBe(LOTTERY_ERRORS.LIMIT_EXCEEDED);
      expect(error.getStatus()).toBe(400);
      expect(error.extra).toEqual({
        details: [{ number: '123456', held: 19, left: 1 }],
      });
    });

    it('refuses a quantity over the limit even with nothing held', async () => {
      const error = await codedError(
        service.create(
          user,
          { ...BASKET, lines: [{ number: '123456', quantity: 21 }] },
          NOW,
        ),
      );

      expect(error.code).toBe(LOTTERY_ERRORS.LIMIT_EXCEEDED);
      expect(error.extra).toEqual({
        details: [{ number: '123456', held: 0, left: 20 }],
      });
    });

    it('refuses a number that is not six digits, or sent twice, before reading anything', async () => {
      for (const lines of [
        [{ number: '12345', quantity: 1 }],
        [{ number: '1234567', quantity: 1 }],
        [{ number: '12a456', quantity: 1 }],
        [
          { number: '123456', quantity: 1 },
          { number: '123456', quantity: 2 },
        ],
      ]) {
        const error = await codedError(
          service.create(user, { ...BASKET, lines }, NOW),
        );
        expect(error.code).toBe(LOTTERY_ERRORS.BAD_NUMBER);
        expect(error.getStatus()).toBe(400);
      }
      expect(prisma.lotteryDraw.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('create — the wallet', () => {
    afterEach(() => {
      // The debit was attempted and refused: nothing after it was written.
      expect(walletService.debitWithinTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.lotteryPurchase.create).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.createMany).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('turns a short wallet into LOTTERY_INSUFFICIENT_BALANCE with the total and the balance', async () => {
      walletService.debitWithinTransaction.mockRejectedValue(
        new BadRequestException('Insufficient wallet balance'),
      );

      const error = await codedError(service.create(user, BASKET, NOW));

      expect(error.code).toBe(LOTTERY_ERRORS.INSUFFICIENT_BALANCE);
      expect(error.getStatus()).toBe(400);
      expect(error.extra).toEqual({
        details: { total: 5000, balance: 1500 },
      });
      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
        where: { userId: user.id },
        select: { balance: true },
      });
    });

    it('lets a missing wallet stay the 404 WalletService raises', async () => {
      walletService.debitWithinTransaction.mockRejectedValue(
        new NotFoundException('Wallet not found for this user'),
      );

      await expect(service.create(user, BASKET, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create — retries (idempotency)', () => {
    it('answers a key already written with the stored receipt and the wallet as it stands, touching nothing', async () => {
      prisma.lotteryPurchase.findUnique.mockResolvedValue(makeStoredPurchase());
      prisma.wallet.findUnique.mockResolvedValue({
        balance: new Prisma.Decimal(7000),
      });

      const receipt = await service.create(user, BASKET, NOW);

      expect(prisma.lotteryPurchase.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_idempotencyKey: { userId: user.id, idempotencyKey: KEY },
          },
        }),
      );
      expect(receipt).toMatchObject({
        ref: 'LP-261020-0042',
        drawNo: 24,
        lines: SORTED_LINES,
        total: 5000,
        status: 'paid',
        balanceAfter: 7000,
      });
      expect(receipt.tickets).toHaveLength(5);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.lotteryPurchase.create).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('probes the key again under the draw lock: a second send that queued behind the first replays it, never a refusal', async () => {
      // Pre-lock: nothing yet (the first send is still inside its
      // transaction). Under the lock: the first send has committed.
      prisma.lotteryPurchase.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeStoredPurchase());
      // The winner's own tickets now fill the limit, and its debit left the
      // wallet short: both checks would refuse if they ran.
      prisma.lotteryTicket.groupBy.mockResolvedValue([
        { number: '123456', _count: { _all: 20 } },
        { number: '000777', _count: { _all: 20 } },
      ]);
      walletService.debitWithinTransaction.mockRejectedValue(
        new BadRequestException('Insufficient wallet balance'),
      );
      prisma.wallet.findUnique.mockResolvedValue({
        balance: new Prisma.Decimal(2000),
      });

      const receipt = await service.create(user, BASKET, NOW);

      expect(receipt).toMatchObject({
        ref: 'LP-261020-0042',
        total: 5000,
        balanceAfter: 2000,
      });
      // Lock first, then the probe under it.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryPurchase.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.lotteryPurchase.findUnique.mock.invocationCallOrder[1],
      );
      expect(prisma.lotteryDraw.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.groupBy).not.toHaveBeenCalled();
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(prisma.lotteryPurchase.create).not.toHaveBeenCalled();
      expect(prisma.lotteryTicket.createMany).not.toHaveBeenCalled();
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('P2002 race: when a concurrent send wins the unique key after both probes, refetches the winner and replays it without emitting', async () => {
      prisma.lotteryPurchase.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeStoredPurchase());
      prisma.lotteryPurchase.create.mockRejectedValue(makeP2002());

      const receipt = await service.create(user, BASKET, NOW);

      expect(receipt.ref).toBe('LP-261020-0042');
      // Pre-lock, under the lock, then after the rollback.
      expect(prisma.lotteryPurchase.findUnique).toHaveBeenCalledTimes(3);
      // The loser's transaction rolled back: its debit moved nothing, so no emit.
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('rethrows a P2002 that is not the idempotency key', async () => {
      prisma.lotteryPurchase.create.mockRejectedValue(makeP2002());

      await expect(service.create(user, BASKET, NOW)).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(gateway.notifyUserBalanceUpdated).not.toHaveBeenCalled();
    });

    it('409s a key reused for a different basket or draw instead of answering with the old receipt', async () => {
      prisma.lotteryPurchase.findUnique.mockResolvedValue(makeStoredPurchase());

      const otherBasket = await codedError(
        service.create(
          user,
          { ...BASKET, lines: [{ number: '123456', quantity: 2 }] },
          NOW,
        ),
      );
      expect(otherBasket.code).toBe(LOTTERY_ERRORS.IDEMPOTENCY_MISMATCH);
      expect(otherBasket.getStatus()).toBe(409);
      expect(otherBasket.extra).toEqual({ ref: 'LP-261020-0042' });

      prisma.lotteryPurchase.findUnique.mockResolvedValue(
        makeStoredPurchase({ drawId: 'another-draw' }),
      );
      const otherDraw = await codedError(service.create(user, BASKET, NOW));
      expect(otherDraw.code).toBe(LOTTERY_ERRORS.IDEMPOTENCY_MISMATCH);

      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });
  });

  describe('list / findOne', () => {
    it('pages the caller’s own purchases newest first, without balanceAfter', async () => {
      prisma.lotteryPurchase.findMany.mockResolvedValue([makeStoredPurchase()]);
      prisma.lotteryPurchase.count.mockResolvedValue(31);

      const page = await service.list(user.id, { page: 2, pageSize: 10 });

      expect(prisma.lotteryPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.lotteryPurchase.count).toHaveBeenCalledWith({
        where: { userId: user.id },
      });
      expect(page).toMatchObject({ total: 31, page: 2, pageSize: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        ref: 'LP-261020-0042',
        drawNo: 24,
        lines: SORTED_LINES,
        tickets: expect.arrayContaining([
          { ticketNo: 'MFL-24-000468', number: '000777' },
        ]) as unknown,
        total: 5000,
        unitPrice: 1000,
        status: 'paid',
        createdAt: new Date('2026-10-20T10:00:00Z'),
      });
      expect(page.items[0]).not.toHaveProperty('balanceAfter');
    });

    it('defaults to page 1 of 20', async () => {
      await service.list(user.id, {});
      expect(prisma.lotteryPurchase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('finds one of the caller’s purchases by ref, and 404s anyone else’s like a missing one', async () => {
      prisma.lotteryPurchase.findFirst.mockResolvedValue(makeStoredPurchase());
      await expect(
        service.findOne(user.id, 'LP-261020-0042'),
      ).resolves.toMatchObject({ ref: 'LP-261020-0042', drawNo: 24 });
      expect(prisma.lotteryPurchase.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ref: 'LP-261020-0042', userId: user.id },
        }),
      );

      prisma.lotteryPurchase.findFirst.mockResolvedValue(null);
      const error = await codedError(
        service.findOne('user-2', 'LP-261020-0042'),
      );
      expect(error.code).toBe(LOTTERY_ERRORS.PURCHASE_NOT_FOUND);
      expect(error.getStatus()).toBe(404);
    });
  });

  it('sorts the lines by number and keeps only number and quantity', () => {
    expect(
      normaliseLines([
        { number: '999999', quantity: 1 },
        { number: '000001', quantity: 4 },
      ]),
    ).toEqual([
      { number: '000001', quantity: 4 },
      { number: '999999', quantity: 1 },
    ]);
  });

  it('maps the purchase status to the wire', () => {
    expect(purchaseStatusToWire(LotteryPurchaseStatus.PAID)).toBe('paid');
  });
});
