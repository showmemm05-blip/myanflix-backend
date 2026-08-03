import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { SeriesService } from './series.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { MovieStatus, Prisma, Role } from '../generated/prisma/client';

describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: {
    series: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    movie: { groupBy: jest.Mock; findMany: jest.Mock };
    seriesPurchase: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let walletService: { debitWithinTransaction: jest.Mock };
  let tx: { seriesPurchase: { create: jest.Mock }; transaction: { create: jest.Mock } };

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      seriesPurchase: { create: jest.fn().mockResolvedValue({ id: 'sp-1' }) },
      transaction: { create: jest.fn().mockResolvedValue({ id: 'tx-1' }) },
    };
    prisma = {
      series: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      movie: { groupBy: jest.fn(), findMany: jest.fn() },
      seriesPurchase: { findUnique: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => Promise<unknown>)(tx) : Promise.all(arg as Promise<unknown>[]),
      ),
    };
    walletService = { debitWithinTransaction: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
      ],
    }).compile();

    service = module.get(SeriesService);
  });

  describe('getSeasons', () => {
    it('throws NotFoundException for an unknown series', async () => {
      prisma.series.findUnique.mockResolvedValue(null);
      await expect(service.getSeasons('nope')).rejects.toThrow(NotFoundException);
    });

    it('reports distinct season numbers with per-season episode counts, in order', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.groupBy.mockResolvedValue([
        { seasonNumber: 1, _count: { seasonNumber: 8 } },
        { seasonNumber: 2, _count: { seasonNumber: 3 } },
      ]);

      const result = await service.getSeasons('series-1');

      expect(result).toEqual([
        { seasonNumber: 1, episodeCount: 8 },
        { seasonNumber: 2, episodeCount: 3 },
      ]);
    });
  });

  describe('getEpisodes', () => {
    it('regular users only ever see PUBLISHED episodes — same rule as the movies catalog', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([]);

      await service.getEpisodes('series-1', Role.USER);

      expect(prisma.movie.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ seriesId: 'series-1', status: MovieStatus.PUBLISHED }),
        }),
      );
    });

    it('staff see every episode regardless of status, and can narrow to one season', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([]);

      await service.getEpisodes('series-1', Role.ADMIN, 2);

      const where = prisma.movie.findMany.mock.calls[0][0].where;
      expect(where.seriesId).toBe('series-1');
      expect(where.seasonNumber).toBe(2);
      expect(where.status).toBeUndefined();
    });

    it('orders by season then episode — playback order, not upload order', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([]);

      await service.getEpisodes('series-1', Role.ADMIN);

      expect(prisma.movie.findMany.mock.calls[0][0].orderBy).toEqual([
        { seasonNumber: 'asc' },
        { episodeNumber: 'asc' },
        { createdAt: 'asc' },
      ]);
    });
  });

  describe('purchase', () => {
    const premiumSeries = { id: 'series-1', isPremium: true, price: new Prisma.Decimal(5000) };

    it('throws NotFoundException for an unknown series', async () => {
      prisma.series.findUnique.mockResolvedValue(null);
      await expect(service.purchase('user-1', 'nope')).rejects.toThrow(NotFoundException);
    });

    it('one purchase per user per series — buying twice conflicts', async () => {
      prisma.series.findUnique.mockResolvedValue(premiumSeries);
      prisma.seriesPurchase.findUnique.mockResolvedValue({ id: 'sp-existing' });

      await expect(service.purchase('user-1', 'series-1')).rejects.toThrow(ConflictException);
      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
    });

    it('debits the wallet and records the purchase + ledger transaction atomically', async () => {
      prisma.series.findUnique.mockResolvedValue(premiumSeries);
      prisma.seriesPurchase.findUnique.mockResolvedValue(null);

      await service.purchase('user-1', 'series-1');

      expect(walletService.debitWithinTransaction).toHaveBeenCalledWith(tx, 'user-1', 5000);
      expect(tx.seriesPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user-1', seriesId: 'series-1' }),
      });
      expect(tx.transaction.create).toHaveBeenCalled();
    });

    it('a free series is claimable without touching the wallet', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', isPremium: false, price: new Prisma.Decimal(0) });
      prisma.seriesPurchase.findUnique.mockResolvedValue(null);

      await service.purchase('user-1', 'series-1');

      expect(walletService.debitWithinTransaction).not.toHaveBeenCalled();
      expect(tx.seriesPurchase.create).toHaveBeenCalled();
    });
  });

  describe('getForViewer', () => {
    const series = { id: 'series-1', isPremium: true, price: new Prisma.Decimal(5000), categories: [] };

    it('staff always count as owning — they never see a Buy button', async () => {
      prisma.series.findUnique.mockResolvedValue(series);

      const result = await service.getForViewer('series-1', 'admin-1', Role.ADMIN);

      expect(result.isPurchased).toBe(true);
      expect(prisma.seriesPurchase.findUnique).not.toHaveBeenCalled();
    });

    it('a regular user without a purchase sees isPurchased false (and price as a plain number)', async () => {
      prisma.series.findUnique.mockResolvedValue(series);
      prisma.seriesPurchase.findUnique.mockResolvedValue(null);

      const result = await service.getForViewer('series-1', 'user-1', Role.USER);

      expect(result.isPurchased).toBe(false);
      expect(result.price).toBe(5000);
    });

    it('a regular user who bought the show sees isPurchased true', async () => {
      prisma.series.findUnique.mockResolvedValue(series);
      prisma.seriesPurchase.findUnique.mockResolvedValue({ id: 'sp-1' });

      const result = await service.getForViewer('series-1', 'user-1', Role.USER);

      expect(result.isPurchased).toBe(true);
    });
  });
});
