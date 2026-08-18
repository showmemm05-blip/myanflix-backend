import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SeriesService } from './series.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AccessType, MovieStatus, Role } from '../generated/prisma/client';

describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: {
    series: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    movie: { groupBy: jest.Mock; findMany: jest.Mock };
    seriesPurchase: { findMany: jest.Mock };
    watchHistory: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let minioService: { imageUrl: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mirrors the real MinioService.imageUrl(): a URL under our bucket is
    // re-hosted against the current request, anything else passes through.
    minioService = {
      imageUrl: jest.fn((url: string | null | undefined) => {
        if (!url) return url ?? null;
        const match = /\/movies\/(.+)$/.exec(url);
        return match ? `http://current-host:8080/movies/${match[1]}` : url;
      }),
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
      seriesPurchase: { findMany: jest.fn() },
      watchHistory: { findMany: jest.fn() },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: unknown) => Promise<unknown>)(undefined) : Promise.all(arg as Promise<unknown>[]),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
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

  describe('getPlayerEpisodes', () => {
    const episodes = [
      { id: 'ep-1', title: 'Pilot', seasonNumber: 1, episodeNumber: 1, duration: 42, thumbnailUrl: 't1', posterUrl: 'p1' },
      { id: 'ep-2', title: 'Episode 2', seasonNumber: 1, episodeNumber: 2, duration: 40, thumbnailUrl: 't2', posterUrl: 'p2' },
      { id: 'ep-3', title: 'Season Finale', seasonNumber: 2, episodeNumber: 1, duration: 45, thumbnailUrl: 't3', posterUrl: 'p3' },
    ];

    it('throws NotFoundException for an unknown series', async () => {
      prisma.series.findUnique.mockResolvedValue(null);
      await expect(service.getPlayerEpisodes('nope', 'user-1', Role.USER)).rejects.toThrow(NotFoundException);
    });

    it('regular users only ever see PUBLISHED episodes — same rule as getEpisodes', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([]);
      prisma.watchHistory.findMany.mockResolvedValue([]);

      await service.getPlayerEpisodes('series-1', 'user-1', Role.USER);

      expect(prisma.movie.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ seriesId: 'series-1', status: MovieStatus.PUBLISHED }),
        }),
      );
    });

    it('groups episodes by season, in season/episode order', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue(episodes);
      prisma.watchHistory.findMany.mockResolvedValue([]);

      const result = await service.getPlayerEpisodes('series-1', 'user-1', Role.ADMIN);

      expect(result.seasons).toEqual([
        {
          seasonNumber: 1,
          episodes: [
            { id: 'ep-1', title: 'Pilot', episodeNumber: 1, duration: 42, thumbnailUrl: 't1', posterUrl: 'p1', watchProgress: null },
            { id: 'ep-2', title: 'Episode 2', episodeNumber: 2, duration: 40, thumbnailUrl: 't2', posterUrl: 'p2', watchProgress: null },
          ],
        },
        {
          seasonNumber: 2,
          episodes: [
            { id: 'ep-3', title: 'Season Finale', episodeNumber: 1, duration: 45, thumbnailUrl: 't3', posterUrl: 'p3', watchProgress: null },
          ],
        },
      ]);
    });

    it("attaches the caller's own watch progress per episode via one batched query, not one per episode", async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue(episodes);
      prisma.watchHistory.findMany.mockResolvedValue([
        { movieId: 'ep-1', progress: 100, lastPosition: 2520 },
        { movieId: 'ep-2', progress: 35, lastPosition: 840 },
      ]);

      const result = await service.getPlayerEpisodes('series-1', 'user-1', Role.USER);

      expect(prisma.watchHistory.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.watchHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', movieId: { in: ['ep-1', 'ep-2', 'ep-3'] } },
        }),
      );

      const [season1] = result.seasons;
      expect(season1.episodes[0].watchProgress).toEqual({ progressPercent: 100, lastPositionSeconds: 2520 });
      expect(season1.episodes[1].watchProgress).toEqual({ progressPercent: 35, lastPositionSeconds: 840 });
      expect(result.seasons[1].episodes[0].watchProgress).toBeNull();
    });

    it('skips the watch-history query entirely when the series has no episodes', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([]);

      const result = await service.getPlayerEpisodes('series-1', 'user-1', Role.USER);

      expect(prisma.watchHistory.findMany).not.toHaveBeenCalled();
      expect(result.seasons).toEqual([]);
    });

    it('skips any episode with no seasonNumber — it cannot be grouped', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([
        { id: 'ep-orphan', title: 'Orphan', seasonNumber: null, episodeNumber: null, duration: 10, thumbnailUrl: null, posterUrl: null },
        ...episodes,
      ]);
      prisma.watchHistory.findMany.mockResolvedValue([]);

      const result = await service.getPlayerEpisodes('series-1', 'user-1', Role.ADMIN);

      const allIds = result.seasons.flatMap((s) => s.episodes.map((e) => e.id));
      expect(allIds).not.toContain('ep-orphan');
      expect(allIds).toHaveLength(3);
    });
  });

  /**
   * Poster/cover/thumbnail URLs are persisted absolute, baked with whatever
   * host uploaded them, so every read path has to re-derive the host from
   * the current request (MinioService.imageUrl) or the images 404 the
   * moment this machine changes networks.
   */
  describe('persisted image URLs are re-hosted per request', () => {
    const stale = (name: string) =>
      `http://192.168.10.122:8080/movies/images/${name}.jpeg`;
    const fresh = (name: string) =>
      `http://current-host:8080/movies/images/${name}.jpeg`;

    it('re-hosts poster and cover on the series list', async () => {
      prisma.series.findMany.mockResolvedValue([
        {
          id: 'series-1',
          title: 'A Show',
          posterUrl: stale('poster'),
          coverUrl: stale('cover'),
          _count: { episodes: 4 },
        },
      ]);
      prisma.series.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(result.items[0]).toMatchObject({
        id: 'series-1',
        title: 'A Show',
        posterUrl: fresh('poster'),
        coverUrl: fresh('cover'),
        episodeCount: 4,
      });
    });

    it('re-hosts poster and cover on series detail, leaving an external one alone', async () => {
      prisma.series.findUnique.mockResolvedValue({
        id: 'series-1',
        posterUrl: stale('poster'),
        coverUrl: 'https://picsum.photos/seed/A%20Show-cover/1280/720',
        categories: [],
      });

      const result = await service.getForViewer('series-1', 'user-1', Role.USER);

      expect(result.posterUrl).toBe(fresh('poster'));
      expect(result.coverUrl).toBe(
        'https://picsum.photos/seed/A%20Show-cover/1280/720',
      );
    });

    it('re-hosts episode thumbnails and posters on the player episode list', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.findMany.mockResolvedValue([
        {
          id: 'ep-1',
          title: 'Pilot',
          seasonNumber: 1,
          episodeNumber: 1,
          duration: 42,
          thumbnailUrl: stale('thumb'),
          posterUrl: null,
        },
      ]);
      prisma.watchHistory.findMany.mockResolvedValue([]);

      const result = await service.getPlayerEpisodes('series-1', 'user-1', Role.ADMIN);

      expect(result.seasons[0].episodes[0]).toMatchObject({
        thumbnailUrl: fresh('thumb'),
        posterUrl: null,
      });
    });

    it('re-hosts the poster on owned-series purchase history', async () => {
      prisma.seriesPurchase.findMany.mockResolvedValue([
        {
          id: 'sp-1',
          seriesId: 'series-1',
          amount: 5000,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          series: { id: 'series-1', title: 'A Show', posterUrl: stale('poster') },
        },
      ]);

      const result = await service.getPurchasesForUser('user-1');

      expect(result[0].posterUrl).toBe(fresh('poster'));
    });
  });

  describe('getForViewer', () => {
    const series = { id: 'series-1', accessType: AccessType.SUBSCRIPTION, categories: [], posterUrl: null, coverUrl: null };

    it('throws NotFoundException for an unknown series', async () => {
      prisma.series.findUnique.mockResolvedValue(null);
      await expect(service.getForViewer('nope', 'user-1', Role.USER)).rejects.toThrow(NotFoundException);
    });

    it('returns the series as-is — access is a global per-user subscription flag, not computed per item', async () => {
      prisma.series.findUnique.mockResolvedValue(series);

      const result = await service.getForViewer('series-1', 'user-1', Role.USER);

      expect(result).toEqual(series);
      expect(prisma.seriesPurchase.findMany).not.toHaveBeenCalled();
    });
  });
});
