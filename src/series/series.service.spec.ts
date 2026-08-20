import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SeriesService } from './series.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import {
  AccessType,
  MovieStatus,
  Role,
  SeriesStatus,
} from '../generated/prisma/client';

describe('SeriesService', () => {
  let service: SeriesService;
  let prisma: {
    series: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    movie: { groupBy: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    seriesPurchase: { findMany: jest.Mock };
    watchHistory: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let minioService: {
    imageUrl: jest.Mock;
    keyFromPublicUrl: jest.Mock;
    deleteByPrefix: jest.Mock;
    deleteObject: jest.Mock;
  };

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
      // Mirrors the real keyFromPublicUrl(): recovers the object key from a
      // URL under our bucket, null for anything external.
      keyFromPublicUrl: jest.fn((url: string) => {
        const match = /\/movies\/(.+)$/.exec(url);
        return match ? match[1] : null;
      }),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
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
      movie: { groupBy: jest.fn(), findMany: jest.fn(), count: jest.fn() },
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
      await expect(service.getSeasons('nope', Role.ADMIN)).rejects.toThrow(NotFoundException);
    });

    it('reports distinct season numbers with per-season episode counts, in order', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1' });
      prisma.movie.groupBy.mockResolvedValue([
        { seasonNumber: 1, _count: { seasonNumber: 8 } },
        { seasonNumber: 2, _count: { seasonNumber: 3 } },
      ]);

      const result = await service.getSeasons('series-1', Role.ADMIN);

      expect(result).toEqual([
        { seasonNumber: 1, episodeCount: 8 },
        { seasonNumber: 2, episodeCount: 3 },
      ]);
    });
  });

  describe('getEpisodes', () => {
    it('regular users only ever see PUBLISHED episodes — same rule as the movies catalog', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', status: SeriesStatus.PUBLISHED });
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
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', status: SeriesStatus.PUBLISHED });
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
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', status: SeriesStatus.PUBLISHED });
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
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', status: SeriesStatus.PUBLISHED });
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

      const result = await service.findAll({}, Role.ADMIN);

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
        status: SeriesStatus.PUBLISHED,
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
    const series = { id: 'series-1', accessType: AccessType.SUBSCRIPTION, status: SeriesStatus.PUBLISHED, categories: [], posterUrl: null, coverUrl: null };

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

    it.each([SeriesStatus.DRAFT, SeriesStatus.UNPUBLISHED])(
      'a %s series does not exist for regular users — same NotFoundException as a bogus id, no leak',
      async (status) => {
        prisma.series.findUnique.mockResolvedValue({ ...series, status });

        await expect(
          service.getForViewer('series-1', 'user-1', Role.USER),
        ).rejects.toThrow(NotFoundException);
      },
    );

    it('staff see a DRAFT series normally', async () => {
      const draft = { ...series, status: SeriesStatus.DRAFT };
      prisma.series.findUnique.mockResolvedValue(draft);

      const result = await service.getForViewer('series-1', 'admin-1', Role.SUPER_ADMIN);

      expect(result).toEqual(draft);
    });
  });

  describe('findAll — series-level visibility', () => {
    beforeEach(() => {
      prisma.series.findMany.mockResolvedValue([]);
      prisma.series.count.mockResolvedValue(0);
    });

    const whereUsed = () =>
      prisma.series.findMany.mock.calls[0][0].where as Record<string, unknown>;

    it('forces status=PUBLISHED for regular users', async () => {
      await service.findAll({}, Role.USER);
      expect(whereUsed().status).toBe(SeriesStatus.PUBLISHED);
    });

    it('ignores (does not honor) a status filter passed by a regular user', async () => {
      await service.findAll({ status: SeriesStatus.DRAFT }, Role.USER);
      expect(whereUsed().status).toBe(SeriesStatus.PUBLISHED);
    });

    it('staff see every status by default', async () => {
      await service.findAll({}, Role.ADMIN);
      expect(whereUsed().status).toBeUndefined();
    });

    it('staff can narrow to one status', async () => {
      await service.findAll({ status: SeriesStatus.UNPUBLISHED }, Role.SUPER_ADMIN);
      expect(whereUsed().status).toBe(SeriesStatus.UNPUBLISHED);
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException for an unknown series', async () => {
      prisma.series.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus('nope', SeriesStatus.PUBLISHED),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.series.update).not.toHaveBeenCalled();
    });

    it('updates only the status and returns the admin shape (categories included)', async () => {
      prisma.series.findUnique.mockResolvedValue({ id: 'series-1', status: SeriesStatus.DRAFT, posterUrl: null, coverUrl: null, categories: [] });
      prisma.series.update.mockResolvedValue({ id: 'series-1', title: 'A Show', status: SeriesStatus.PUBLISHED, posterUrl: null, coverUrl: null, categories: [] });

      const result = await service.updateStatus('series-1', SeriesStatus.PUBLISHED);

      expect(prisma.series.update).toHaveBeenCalledWith({
        where: { id: 'series-1' },
        data: { status: SeriesStatus.PUBLISHED },
        include: { categories: true },
      });
      expect(result.status).toBe(SeriesStatus.PUBLISHED);
    });
  });

  describe('remove', () => {
    const img = (name: string) =>
      `http://192.168.10.122:8080/movies/images/${name}.jpeg`;

    const makeSeries = (episodes: unknown[]) => ({
      id: 'series-1',
      title: 'A Show',
      posterUrl: img('series-poster'),
      coverUrl: img('series-cover'),
      episodes,
    });

    const episode = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      posterUrl: null,
      coverUrl: null,
      thumbnailUrl: null,
      videos: [],
      ...overrides,
    });

    beforeEach(() => {
      prisma.series.delete.mockResolvedValue({});
      // Shared-asset guard default: nothing else references any image key.
      prisma.movie.count.mockResolvedValue(0);
      prisma.series.count.mockResolvedValue(0);
    });

    it('throws NotFoundException for an unknown series and deletes nothing', async () => {
      prisma.series.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
      expect(prisma.series.delete).not.toHaveBeenCalled();
      expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes the series row (Cascade takes the episodes) and reports the episode count', async () => {
      prisma.series.findUnique.mockResolvedValue(
        makeSeries([episode('ep-1'), episode('ep-2')]),
      );

      const result = await service.remove('series-1');

      expect(prisma.series.delete).toHaveBeenCalledWith({ where: { id: 'series-1' } });
      expect(result).toEqual({
        deletedEpisodes: 2,
        storageCleanup: 'complete',
        failedObjects: [],
      });
    });

    it('cleans MinIO per episode video prefix plus every episode and series image key', async () => {
      prisma.series.findUnique.mockResolvedValue(
        makeSeries([
          episode('ep-1', { posterUrl: img('ep1-poster'), thumbnailUrl: img('ep1-thumb') }),
          episode('ep-2'),
        ]),
      );

      await service.remove('series-1');

      expect(minioService.deleteByPrefix).toHaveBeenCalledWith('videos/ep-1/');
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith('videos/ep-2/');
      const deletedKeys = minioService.deleteObject.mock.calls.map((c) => c[0]);
      expect(deletedKeys).toEqual(
        expect.arrayContaining([
          'images/ep1-poster.jpeg',
          'images/ep1-thumb.jpeg',
          'images/series-poster.jpeg',
          'images/series-cover.jpeg',
        ]),
      );
    });

    it('deletes a manually-uploaded subtitle individually, but not one already under the video prefix', async () => {
      prisma.series.findUnique.mockResolvedValue(
        makeSeries([
          episode('ep-1', {
            videos: [
              {
                subtitles: [
                  { objectKey: 'subtitles/sub-1/my.vtt' },
                  { objectKey: 'videos/ep-1/bundle/en.vtt' },
                ],
              },
            ],
          }),
        ]),
      );

      await service.remove('series-1');

      const deletedKeys = minioService.deleteObject.mock.calls.map((c) => c[0]);
      expect(deletedKeys).toContain('subtitles/sub-1/my.vtt');
      expect(deletedKeys).not.toContain('videos/ep-1/bundle/en.vtt');
    });

    it('skips an image key another surviving row still references — the shared-asset guard', async () => {
      prisma.series.findUnique.mockResolvedValue(makeSeries([episode('ep-1')]));
      // Another movie still references the series poster key.
      prisma.movie.count.mockImplementation(
        ({ where }: { where: { OR: { posterUrl?: { contains: string } }[] } }) =>
          Promise.resolve(
            where.OR[0].posterUrl?.contains === 'images/series-poster.jpeg' ? 1 : 0,
          ),
      );

      const result = await service.remove('series-1');

      const deletedKeys = minioService.deleteObject.mock.calls.map((c) => c[0]);
      expect(deletedKeys).not.toContain('images/series-poster.jpeg');
      expect(deletedKeys).toContain('images/series-cover.jpeg');
      // A skipped shared key is not a failure.
      expect(result.storageCleanup).toBe('complete');
    });

    it('a MinIO failure yields storageCleanup partial with the failed keys, is logged, and never rolls back the DB delete', async () => {
      prisma.series.findUnique.mockResolvedValue(
        makeSeries([episode('ep-1'), episode('ep-2')]),
      );
      minioService.deleteByPrefix.mockImplementation((prefix: string) =>
        prefix === 'videos/ep-1/'
          ? Promise.reject(new Error('minio down'))
          : Promise.resolve(),
      );
      minioService.deleteObject.mockImplementation((key: string) =>
        key === 'images/series-cover.jpeg'
          ? Promise.reject(new Error('minio down'))
          : Promise.resolve(),
      );
      const errorSpy = jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);

      const result = await service.remove('series-1');

      expect(prisma.series.delete).toHaveBeenCalledWith({ where: { id: 'series-1' } });
      expect(result.deletedEpisodes).toBe(2);
      expect(result.storageCleanup).toBe('partial');
      expect(result.failedObjects).toEqual(
        expect.arrayContaining(['videos/ep-1/', 'images/series-cover.jpeg']),
      );
      expect(result.failedObjects).toHaveLength(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('videos/ep-1/'),
      );
    });
  });

  /**
   * The series-level gate: seasons, episodes and player-episodes of a
   * non-PUBLISHED series are 404 for regular users (indistinguishable from
   * a nonexistent series) while staff keep full access for management.
   */
  describe('series-level gating of seasons/episodes', () => {
    const draft = { id: 'series-1', status: SeriesStatus.DRAFT, posterUrl: null, coverUrl: null, categories: [] };

    it('getSeasons: 404 for USER on a non-PUBLISHED series', async () => {
      prisma.series.findUnique.mockResolvedValue(draft);
      await expect(service.getSeasons('series-1', Role.USER)).rejects.toThrow(NotFoundException);
      expect(prisma.movie.groupBy).not.toHaveBeenCalled();
    });

    it('getSeasons: staff still list seasons of a DRAFT series', async () => {
      prisma.series.findUnique.mockResolvedValue(draft);
      prisma.movie.groupBy.mockResolvedValue([]);
      await expect(service.getSeasons('series-1', Role.ADMIN)).resolves.toEqual([]);
    });

    it('getEpisodes: 404 for USER on a non-PUBLISHED series', async () => {
      prisma.series.findUnique.mockResolvedValue({ ...draft, status: SeriesStatus.UNPUBLISHED });
      await expect(service.getEpisodes('series-1', Role.USER)).rejects.toThrow(NotFoundException);
      expect(prisma.movie.findMany).not.toHaveBeenCalled();
    });

    it('getEpisodes: staff still list episodes of an UNPUBLISHED series', async () => {
      prisma.series.findUnique.mockResolvedValue({ ...draft, status: SeriesStatus.UNPUBLISHED });
      prisma.movie.findMany.mockResolvedValue([]);
      await expect(service.getEpisodes('series-1', Role.ADMIN)).resolves.toEqual([]);
    });

    it('getPlayerEpisodes: 404 for USER on a non-PUBLISHED series', async () => {
      prisma.series.findUnique.mockResolvedValue(draft);
      await expect(
        service.getPlayerEpisodes('series-1', 'user-1', Role.USER),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.movie.findMany).not.toHaveBeenCalled();
    });

    it('getPlayerEpisodes: staff still get the grouped list for a DRAFT series', async () => {
      prisma.series.findUnique.mockResolvedValue(draft);
      prisma.movie.findMany.mockResolvedValue([]);
      const result = await service.getPlayerEpisodes('series-1', 'admin-1', Role.SUPER_ADMIN);
      expect(result.seasons).toEqual([]);
    });
  });
});
