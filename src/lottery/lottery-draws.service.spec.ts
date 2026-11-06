import { Test, TestingModule } from '@nestjs/testing';
import { LotteryDrawStatus, Prisma, Role } from '../generated/prisma/client';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { DRAW_ID, makeDraw } from '../../test/lottery-fixtures';
import {
  drawStatusFromWire,
  drawStatusToWire,
  LotteryDrawsService,
} from './lottery-draws.service';
import { LOTTERY_ERRORS } from './lottery-errors';

const user = {
  id: 'user-1',
  username: 'user_959',
  role: Role.USER,
  appRoleId: null,
};

const NOW = new Date('2026-10-20T10:00:00Z');

describe('LotteryDrawsService', () => {
  let service: LotteryDrawsService;
  let prisma: {
    lotteryDraw: Record<
      'findFirst' | 'findMany' | 'findUnique' | 'count',
      jest.Mock
    >;
    lotteryOffSaleNumber: { findMany: jest.Mock };
    lotteryTicket: { groupBy: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      lotteryDraw: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      lotteryOffSaleNumber: { findMany: jest.fn().mockResolvedValue([]) },
      lotteryTicket: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryDrawsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MinioService,
          useValue: {
            imageUrl: jest.fn((url: string | null) =>
              url ? url.replace('STORED', 'REQUEST') : null,
            ),
          },
        },
      ],
    }).compile();
    service = module.get(LotteryDrawsService);
  });

  describe('current', () => {
    it('prefers the selling draw (open or paused) with the nearest draw time', async () => {
      const open = makeDraw({ status: LotteryDrawStatus.OPEN });
      prisma.lotteryDraw.findFirst.mockResolvedValueOnce(open);

      const result = await service.current(NOW);

      expect(result.draw?.status).toBe('open');
      expect(result.serverNow).toBe('2026-10-20T10:00:00.000Z');
      expect(prisma.lotteryDraw.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryDraw.findFirst).toHaveBeenCalledWith({
        where: { status: { in: ['OPEN', 'PAUSED'] } },
        orderBy: { drawAt: 'asc' },
      });
    });

    it('falls back to the next scheduled draw that has not been drawn yet', async () => {
      prisma.lotteryDraw.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeDraw());

      const result = await service.current(NOW);

      expect(result.draw?.status).toBe('scheduled');
      expect(prisma.lotteryDraw.findFirst).toHaveBeenNthCalledWith(2, {
        where: { status: 'SCHEDULED', drawAt: { gte: NOW } },
        orderBy: { drawAt: 'asc' },
      });
    });

    it('then to the latest finished draw, and to null when there is none', async () => {
      prisma.lotteryDraw.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          makeDraw({ status: LotteryDrawStatus.PUBLISHED }),
        );
      expect((await service.current(NOW)).draw?.status).toBe('published');
      expect(prisma.lotteryDraw.findFirst).toHaveBeenNthCalledWith(3, {
        where: { status: { in: ['CLOSED', 'PUBLISHED'] } },
        orderBy: { drawAt: 'desc' },
      });

      prisma.lotteryDraw.findFirst.mockReset().mockResolvedValue(null);
      expect(await service.current(NOW)).toEqual({
        draw: null,
        serverNow: NOW.toISOString(),
      });
    });
  });

  describe('listPublic / findPublic', () => {
    it('pages every draw, newest draw number first', async () => {
      prisma.lotteryDraw.findMany.mockResolvedValue([makeDraw()]);
      prisma.lotteryDraw.count.mockResolvedValue(31);

      const page = await service.listPublic({ page: 2, pageSize: 10 });

      expect(prisma.lotteryDraw.findMany).toHaveBeenCalledWith({
        orderBy: { drawNo: 'desc' },
        skip: 10,
        take: 10,
      });
      expect(page).toEqual(
        expect.objectContaining({ total: 31, page: 2, pageSize: 10 }),
      );
      expect(page.items[0].drawNo).toBe(24);
    });

    it('404s an unknown draw number with LOTTERY_DRAW_NOT_FOUND', async () => {
      await expect(service.findPublic(99)).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
        status: 404,
      });
      await expect(service.findPublic(99)).rejects.toBeInstanceOf(
        CodedHttpException,
      );
    });
  });

  describe('availability', () => {
    beforeEach(() => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(makeDraw());
    });

    it('answers a guest with nothing held and the whole limit left, repeats once', async () => {
      prisma.lotteryOffSaleNumber.findMany.mockResolvedValue([
        { number: '000002' },
      ]);

      const { items } = await service.availability(24, [
        '000001',
        '000002',
        '000001',
      ]);

      expect(items).toEqual([
        { number: '000001', offSale: false, held: 0, left: 20 },
        { number: '000002', offSale: true, held: 0, left: 0 },
      ]);
      expect(prisma.lotteryTicket.groupBy).not.toHaveBeenCalled();
      expect(prisma.lotteryOffSaleNumber.findMany).toHaveBeenCalledWith({
        where: { drawId: DRAW_ID, number: { in: ['000001', '000002'] } },
        select: { number: true },
      });
    });

    it("counts a signed-in customer's own tickets against the limit", async () => {
      prisma.lotteryTicket.groupBy.mockResolvedValue([
        { number: '000001', _count: { _all: 17 } },
        { number: '000003', _count: { _all: 20 } },
      ]);

      const { items } = await service.availability(
        24,
        ['000001', '000003', '000004'],
        user,
      );

      expect(items).toEqual([
        { number: '000001', offSale: false, held: 17, left: 3 },
        { number: '000003', offSale: false, held: 20, left: 0 },
        { number: '000004', offSale: false, held: 0, left: 20 },
      ]);
      expect(prisma.lotteryTicket.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', drawId: DRAW_ID }),
        }),
      );
    });

    it('404s an unknown draw before reading anything else', async () => {
      prisma.lotteryDraw.findUnique.mockResolvedValue(null);
      await expect(service.availability(5, ['000001'])).rejects.toMatchObject({
        code: LOTTERY_ERRORS.DRAW_NOT_FOUND,
      });
      expect(prisma.lotteryOffSaleNumber.findMany).not.toHaveBeenCalled();
    });
  });

  it('sells only while OPEN and before the sales close time', () => {
    const open = makeDraw({ status: LotteryDrawStatus.OPEN });
    expect(service.isSellingNow(open, new Date('2026-11-01T06:29:59Z'))).toBe(
      true,
    );
    expect(service.isSellingNow(open, new Date('2026-11-01T06:30:00Z'))).toBe(
      false,
    );
    expect(
      service.isSellingNow(
        makeDraw({ status: LotteryDrawStatus.PAUSED }),
        new Date('2026-10-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('draws the wire shape: a date string, a lower-case status, numbers for money, a re-hosted picture and frame', () => {
    const view = service.view(
      makeDraw({
        status: LotteryDrawStatus.PAUSED,
        pictureUrl: 'http://STORED/movies/images/lottery/a.webp',
        frameUrl: 'http://STORED/movies/images/lottery_frame/f.png',
        openedAt: new Date('2026-10-20T00:00:00Z'),
      }),
    );
    expect(view).toEqual({
      id: DRAW_ID,
      drawNo: 24,
      thaiDrawDate: '2026-11-01',
      drawAt: new Date('2026-11-01T07:30:00Z'),
      salesCloseAt: new Date('2026-11-01T06:30:00Z'),
      status: 'paused',
      ticketPrice: 1000,
      maxPerNumber: 20,
      pictureUrl: 'http://REQUEST/movies/images/lottery/a.webp',
      frameUrl: 'http://REQUEST/movies/images/lottery_frame/f.png',
      openedAt: new Date('2026-10-20T00:00:00Z'),
      closedAt: null,
      publishedAt: null,
      winnersCount: null,
      prizesPaidKs: null,
    });
    // Publish figures (phase 3) come out as numbers once set.
    expect(
      service.view(
        makeDraw({
          winnersCount: 12,
          prizesPaidKs: new Prisma.Decimal('1234000.5'),
        }),
      ),
    ).toEqual(
      expect.objectContaining({ winnersCount: 12, prizesPaidKs: 1234000.5 }),
    );
    // No frame of its own = the app's built-in frame, sent as null, never ''.
    expect(service.view(makeDraw()).frameUrl).toBeNull();
  });

  it('maps every status both ways', () => {
    for (const status of Object.values(LotteryDrawStatus)) {
      expect(drawStatusFromWire(drawStatusToWire(status))).toBe(status);
    }
  });
});
