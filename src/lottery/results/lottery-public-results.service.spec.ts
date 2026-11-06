import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryDrawStatus,
  LotteryPayoutStatus,
  Prisma,
} from '../../generated/prisma/client';
import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { DRAW_ID, makeDraw, makeSheet } from '../../../test/lottery-fixtures';
import { LOTTERY_ERRORS } from '../lottery-errors';
import { LotteryPublicResultsService } from './lottery-public-results.service';
import { LotteryResultsService } from './lottery-results.service';
import { parseStoredPrizeGroups, PRIZE_GROUP_KEYS } from './prize-groups';

const PUBLISHED_AT = new Date('2026-11-01T09:00:00Z');

const publishedDraw = (overrides: Parameters<typeof makeDraw>[0] = {}) => ({
  ...makeDraw({
    status: LotteryDrawStatus.PUBLISHED,
    openedAt: new Date('2026-10-19T08:00:00Z'),
    closedAt: new Date('2026-11-01T06:30:00Z'),
    publishedAt: PUBLISHED_AT,
    exchangeRate: new Prisma.Decimal('75.5'),
    winnersCount: 2,
    prizesPaidKs: new Prisma.Decimal('453604000.00'),
    ...overrides,
  }),
  result: { groups: makeSheet() },
});

const payout = (overrides: Record<string, unknown> = {}) => ({
  id: 'payout-1',
  drawId: DRAW_ID,
  ticketId: 't1',
  userId: 'user-1',
  groups: [
    { key: 'first', name: 'First prize', baht: 6_000_000, ks: 453_000_000 },
    { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 302_000 },
  ],
  baht: new Prisma.Decimal('6004000.00'),
  ks: new Prisma.Decimal('453302000.00'),
  rate: new Prisma.Decimal('75.5000'),
  transactionId: 'txn-1',
  status: LotteryPayoutStatus.PAID,
  createdAt: PUBLISHED_AT,
  ticket: { number: '123456' },
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

describe('LotteryPublicResultsService', () => {
  let service: LotteryPublicResultsService;
  let prisma: {
    lotteryDraw: Record<'findMany' | 'count' | 'findUnique', jest.Mock>;
    lotteryPayout: Record<'findMany', jest.Mock>;
  };
  let results: { rateFor: jest.Mock; sheetOf: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lotteryDraw: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(publishedDraw()),
      },
      lotteryPayout: { findMany: jest.fn().mockResolvedValue([]) },
    };
    results = {
      rateFor: jest.fn((draw: { exchangeRate: Prisma.Decimal | null }) =>
        Promise.resolve(draw.exchangeRate?.toNumber() ?? 75),
      ),
      sheetOf: jest.fn((row: { groups: unknown }) =>
        parseStoredPrizeGroups(row.groups),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryPublicResultsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LotteryResultsService, useValue: results },
      ],
    }).compile();
    service = module.get(LotteryPublicResultsService);
  });

  describe('list', () => {
    it('pages the PUBLISHED draws newest first, each with its whole sheet priced at its own rate', async () => {
      prisma.lotteryDraw.findMany.mockResolvedValue([
        publishedDraw(),
        publishedDraw({
          id: 'draw-23',
          drawNo: 23,
          thaiDrawDate: new Date('2026-10-16T00:00:00Z'),
          exchangeRate: new Prisma.Decimal('75'),
        }),
      ]);
      prisma.lotteryDraw.count.mockResolvedValue(12);

      const page = await service.list({ page: 2, pageSize: 10 });

      expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
        where: { status: LotteryDrawStatus.PUBLISHED },
        orderBy: { drawNo: 'desc' },
        skip: 10,
        take: 10,
        include: { result: { select: { groups: true } } },
      });
      expect(prisma.lotteryDraw.count).toHaveBeenCalledWith({
        where: { status: LotteryDrawStatus.PUBLISHED },
      });
      expect(page.total).toBe(12);
      expect(page.page).toBe(2);
      expect(page.pageSize).toBe(10);
      expect(page.items.map((item) => [item.drawNo, item.rate])).toEqual([
        [24, 75.5],
        [23, 75],
      ]);
      const first = page.items[0];
      expect(first).toMatchObject({
        drawNo: 24,
        thaiDrawDate: '2026-11-01',
        publishedAt: PUBLISHED_AT,
        rate: 75.5,
      });
      expect(first.groups.map((group) => group.key)).toEqual([
        ...PRIZE_GROUP_KEYS,
      ]);
      expect(first.groups[0]).toEqual({
        key: 'first',
        name: 'First prize',
        baht: 6_000_000,
        count: 1,
        digits: 6,
        numbers: ['123456'],
        ks: 453_000_000,
      });
      expect(first.groups[8]).toMatchObject({
        key: 'back2',
        numbers: ['56'],
        ks: 151_000,
      });
      // The second draw's groups are at ITS rate.
      expect(page.items[1].groups[0].ks).toBe(450_000_000);
      // Nothing of the draw's bookkeeping leaks onto the public sheet.
      expect(Object.keys(first).sort()).toEqual([
        'drawNo',
        'groups',
        'publishedAt',
        'rate',
        'thaiDrawDate',
      ]);
    });

    it('defaults to page 1 of 20 and reads an empty sheet when the results row is missing', async () => {
      prisma.lotteryDraw.findMany.mockResolvedValue([
        { ...publishedDraw(), result: null },
      ]);
      prisma.lotteryDraw.count.mockResolvedValue(1);

      const page = await service.list({});

      expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(page.items[0].groups).toEqual([]);
    });
  });

  describe('findByDrawNo', () => {
    it('serves a published draw’s sheet', async () => {
      const view = await service.findByDrawNo(24);

      expect(prisma.lotteryDraw.findUnique).toHaveBeenCalledWith({
        where: { drawNo: 24 },
        include: { result: { select: { groups: true } } },
      });
      expect(view).toMatchObject({
        drawNo: 24,
        thaiDrawDate: '2026-11-01',
        publishedAt: PUBLISHED_AT,
        rate: 75.5,
      });
      expect(view.groups).toHaveLength(9);
    });

    it('404s LOTTERY_RESULTS_NOT_PUBLISHED for a draw that is not published, whatever its sheet holds', async () => {
      for (const status of [
        LotteryDrawStatus.SCHEDULED,
        LotteryDrawStatus.OPEN,
        LotteryDrawStatus.PAUSED,
        LotteryDrawStatus.CLOSED,
      ]) {
        prisma.lotteryDraw.findUnique.mockResolvedValue(
          publishedDraw({ status, publishedAt: null }),
        );
        await expect(codeOf(service.findByDrawNo(24))).resolves.toEqual({
          status: 404,
          code: LOTTERY_ERRORS.RESULTS_NOT_PUBLISHED,
          extra: { drawNo: 24 },
        });
      }
    });

    it('404s LOTTERY_DRAW_NOT_FOUND for a draw number that does not exist', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(codeOf(service.findByDrawNo(99))).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
    });
  });

  describe('winners', () => {
    it('lists the paid tickets biggest prize first, by number only, under the biggest group each won', async () => {
      prisma.lotteryPayout.findMany.mockResolvedValue([
        payout(),
        payout({
          id: 'payout-2',
          ticketId: 't2',
          userId: 'user-2',
          groups: [
            { key: 'back3', name: 'Back 3 digits', baht: 4000, ks: 302_000 },
          ],
          baht: new Prisma.Decimal('4000.00'),
          ks: new Prisma.Decimal('302000.00'),
          ticket: { number: '000001' },
        }),
      ]);

      const { items } = await service.winners(24, 20);

      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID },
        orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
        take: 20,
        include: { ticket: { select: { number: true } } },
      });
      expect(items).toEqual([
        {
          number: '123456',
          groupKey: 'first',
          groupName: 'First prize',
          ks: 453_302_000,
        },
        {
          number: '000001',
          groupKey: 'back3',
          groupName: 'Back 3 digits',
          ks: 302_000,
        },
      ]);
      // Never a user field.
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([
          'groupKey',
          'groupName',
          'ks',
          'number',
        ]);
      }
    });

    it('passes the limit through, is empty for a draw that paid nothing, and skips a payout row whose groups are unreadable', async () => {
      await service.winners(24, 5);
      expect(prisma.lotteryPayout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );

      await expect(service.winners(24, 20)).resolves.toEqual({ items: [] });

      prisma.lotteryPayout.findMany.mockResolvedValue([
        payout({ groups: 'oops' }),
        payout({ id: 'payout-2', ticket: { number: '000001' } }),
      ]);
      const { items } = await service.winners(24, 20);
      expect(items.map((item) => item.number)).toEqual(['000001']);
    });

    it('404s before publish and for a missing draw, without reading the payouts', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(
        publishedDraw({ status: LotteryDrawStatus.CLOSED, publishedAt: null }),
      );
      await expect(codeOf(service.winners(24, 20))).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.RESULTS_NOT_PUBLISHED,
      });

      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(codeOf(service.winners(24, 20))).resolves.toMatchObject({
        status: 404,
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.lotteryPayout.findMany).not.toHaveBeenCalled();
    });
  });
});
