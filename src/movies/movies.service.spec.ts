import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingService } from '../tracking/tracking.service';
import { AccessType, MovieStatus, Role } from '../generated/prisma/client';

describe('MoviesService', () => {
  let service: MoviesService;
  let prisma: {
    movie: { create: jest.Mock; findUnique: jest.Mock; delete: jest.Mock };
    series: { findUnique: jest.Mock };
  };
  let minioService: {
    deleteByPrefix: jest.Mock;
    deleteObject: jest.Mock;
    keyFromPublicUrl: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { create: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
      series: { findUnique: jest.fn() },
    };
    minioService = {
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      keyFromPublicUrl: jest.fn((url: string) => `images/${url.split('/').pop()}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoviesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        // findAll fire-and-forgets a search row; nothing else in this suite
        // touches tracking.
        {
          provide: TrackingService,
          useValue: {
            recordSearch: jest.fn().mockResolvedValue(undefined),
            fireAndForget: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(MoviesService);
  });

  describe('createUploadPlaceholder', () => {
    it(
      'creates a movie with only the given title populated and every other ' +
        'field defaulted, starting at UPLOADING — the bulk upload flow only knows the title at this point',
      async () => {
        prisma.movie.create.mockResolvedValue({ id: 'movie-1', title: 'My Cool Movie', status: MovieStatus.UPLOADING });

        const result = await service.createUploadPlaceholder('My Cool Movie');

        expect(prisma.movie.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            title: 'My Cool Movie',
            description: '',
            genre: '',
            language: '',
            duration: 0,
            accessType: AccessType.SUBSCRIPTION,
            status: MovieStatus.UPLOADING,
          }),
        });
        expect(result).toEqual({ id: 'movie-1', title: 'My Cool Movie', status: MovieStatus.UPLOADING });
      },
    );

    it('never sets status to PUBLISHED — that only ever happens via an explicit admin action', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Anything');

      const callData = prisma.movie.create.mock.calls[0][0].data;
      expect(callData.status).toBe(MovieStatus.UPLOADING);
      expect(callData.status).not.toBe(MovieStatus.PUBLISHED);
    });

    it('as an episode: throws NotFoundException when the series does not exist, without creating anything', async () => {
      prisma.series.findUnique.mockResolvedValue(null);

      await expect(
        service.createUploadPlaceholder('Episode 1', { seriesId: 'series-1', seasonNumber: 1, episodeNumber: 1 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.movie.create).not.toHaveBeenCalled();
    });

    it('as an episode: carries season/episode position and inherits genre/language/releaseYear from the show', async () => {
      prisma.series.findUnique.mockResolvedValue({
        id: 'series-1',
        genre: 'Drama',
        language: 'Burmese',
        releaseYear: 2020,
      });
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Episode 3', { seriesId: 'series-1', seasonNumber: 2, episodeNumber: 3 });

      expect(prisma.movie.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: 'Episode 3',
          seriesId: 'series-1',
          seasonNumber: 2,
          episodeNumber: 3,
          genre: 'Drama',
          language: 'Burmese',
          releaseYear: 2020,
          status: MovieStatus.UPLOADING,
        }),
      });
    });

    it('as a standalone movie: leaves every series field unset', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Just A Movie');

      const callData = prisma.movie.create.mock.calls[0][0].data;
      expect(callData.seriesId).toBeUndefined();
      expect(callData.seasonNumber).toBeUndefined();
      expect(callData.episodeNumber).toBeUndefined();
      expect(prisma.series.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(service.remove('movie-1')).rejects.toThrow(NotFoundException);
      expect(prisma.movie.delete).not.toHaveBeenCalled();
    });

    it('deletes the DB row, then cleans up its whole videos/<id>/ tree and its three images in storage', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        posterUrl: 'http://cache/movies/images/poster.jpg',
        coverUrl: 'http://cache/movies/images/cover.jpg',
        thumbnailUrl: 'http://cache/movies/images/thumb.jpg',
        videos: [],
      });

      await service.remove('movie-1');

      expect(prisma.movie.delete).toHaveBeenCalledWith({ where: { id: 'movie-1' } });
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith('videos/movie-1/');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/poster.jpg');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/cover.jpg');
      expect(minioService.deleteObject).toHaveBeenCalledWith('images/thumb.jpg');
    });

    it('skips any image field that was never set, instead of trying to delete a null URL', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        posterUrl: null,
        coverUrl: null,
        thumbnailUrl: null,
        videos: [],
      });

      await service.remove('movie-1');

      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });

    it(
      'deletes a manually-uploaded subtitle (global subtitles/<id>/ prefix) individually, but does not ' +
        'double-delete a bundle-detected one that the videos/<movieId>/ prefix delete already caught',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          posterUrl: null,
          coverUrl: null,
          thumbnailUrl: null,
          videos: [
            {
              id: 'video-1',
              subtitles: [
                { objectKey: 'subtitles/sub-1/original.vtt' }, // manually uploaded — separate global prefix
                { objectKey: 'videos/movie-1/subtitles/english.vtt' }, // bundle-detected — already under the deleted prefix
              ],
            },
          ],
        });

        await service.remove('movie-1');

        expect(minioService.deleteObject).toHaveBeenCalledWith('subtitles/sub-1/original.vtt');
        expect(minioService.deleteObject).not.toHaveBeenCalledWith('videos/movie-1/subtitles/english.vtt');
      },
    );

    it('still deletes the movie even if storage cleanup fails — a storage hiccup must not block removing it from the catalog', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', posterUrl: null, coverUrl: null, thumbnailUrl: null, videos: [] });
      minioService.deleteByPrefix.mockRejectedValue(new Error('storage server unreachable'));

      await expect(service.remove('movie-1')).resolves.toBeUndefined();
      expect(prisma.movie.delete).toHaveBeenCalledWith({ where: { id: 'movie-1' } });
    });
  });
});

describe('MoviesService — search logging', () => {
  let service: MoviesService;
  let prisma: {
    movie: { findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };
  let trackingService: { recordSearch: jest.Mock; fireAndForget: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    trackingService = {
      recordSearch: jest.fn().mockResolvedValue(undefined),
      // Matches the real helper: run it, swallow failures into a log.
      fireAndForget: jest.fn((_what: string, run: Promise<void>) => {
        void run.catch(() => undefined);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoviesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: {} },
        { provide: TrackingService, useValue: trackingService },
      ],
    }).compile();

    service = module.get(MoviesService);
  });

  it('logs a search with the real total the query returned, not the page size', async () => {
    prisma.movie.findMany.mockResolvedValue([{ id: 'movie-1' }]);
    prisma.movie.count.mockResolvedValue(42);

    await service.findAll({ search: 'avengers', limit: 1 }, Role.USER, 'user-1');

    expect(trackingService.recordSearch).toHaveBeenCalledWith({
      term: 'avengers',
      resultCount: 42,
      userId: 'user-1',
      viewerRole: Role.USER,
    });
  });

  it('logs a search that found nothing — that is the most interesting kind', async () => {
    prisma.movie.count.mockResolvedValue(0);

    await service.findAll({ search: 'kdrama 2035' }, Role.USER, 'user-1');

    expect(trackingService.recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({ resultCount: 0 }),
    );
  });

  it('logs nothing when the request carries no search term', async () => {
    await service.findAll({ genre: 'Action' }, Role.USER, 'user-1');

    expect(trackingService.recordSearch).not.toHaveBeenCalled();
  });

  it('logs nothing for a whitespace-only search term', async () => {
    await service.findAll({ search: '   ' }, Role.USER, 'user-1');

    expect(trackingService.recordSearch).not.toHaveBeenCalled();
  });

  it("hands the caller's role through, so staff searches can be dropped", async () => {
    await service.findAll({ search: 'avengers' }, Role.ADMIN, 'admin-1');

    expect(trackingService.recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({ viewerRole: Role.ADMIN }),
    );
  });

  it('is fire-and-forget — the search still returns when logging rejects', async () => {
    prisma.movie.count.mockResolvedValue(7);
    trackingService.recordSearch.mockRejectedValue(new Error('db down'));

    const result = await service.findAll(
      { search: 'avengers' },
      Role.USER,
      'user-1',
    );

    expect(result.total).toBe(7);
    expect(trackingService.fireAndForget).toHaveBeenCalled();
    // Let the rejected promise's .catch handler run.
    await new Promise(process.nextTick);
  });

  it('logs after the query, so a search is never slowed down by tracking', async () => {
    const order: string[] = [];
    prisma.movie.count.mockImplementation(() => {
      order.push('count');
      return Promise.resolve(1);
    });
    trackingService.fireAndForget.mockImplementation(() => order.push('log'));

    await service.findAll({ search: 'avengers' }, Role.USER, 'user-1');

    expect(order).toEqual(['count', 'log']);
  });
});
