import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  MoviesService,
  buildMovieWhere,
  movieOrderBy,
  movieSearchOr,
} from './movies.service';
import { MovieSort } from './dto/movie-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingService } from '../tracking/tracking.service';
import {
  AccessType,
  AgeRating,
  MovieStatus,
  Role,
} from '../generated/prisma/client';

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

    it('stores the runtime the uploader probed from the bundle when one is given', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Probed Movie', undefined, {
        duration: 91,
      });

      expect(prisma.movie.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ title: 'Probed Movie', duration: 91 }),
      });
    });

    it('is born with the 0 unknown sentinel when the probe produced nothing — never a guess', async () => {
      prisma.movie.create.mockResolvedValue({ id: 'movie-1' });

      await service.createUploadPlaceholder('Unprobed Movie', undefined, {});

      expect(prisma.movie.create.mock.calls[0][0].data.duration).toBe(0);
    });

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

/**
 * The pure where-builder — every filter branch without a database.
 * Facet semantics under test: OR within a facet, AND across facets.
 */
describe('buildMovieWhere', () => {
  it('USER forcing (PUBLISHED + standalone) survives every new param', () => {
    const where = buildMovieWhere(
      {
        status: MovieStatus.DRAFT, // must be ignored for USER
        genres: ['Action', 'Drama'],
        languages: ['Burmese'],
        actorIds: ['11111111-1111-4111-8111-111111111111'],
        ageRatings: [AgeRating.PG13],
        yearFrom: 2000,
        yearTo: 2020,
        ratingMin: 5,
        durationMax: 120,
      },
      Role.USER,
    );

    expect(where.status).toBe(MovieStatus.PUBLISHED);
    expect(where.seriesId).toBeNull();
  });

  it('staff keep their status/seriesId filters', () => {
    const where = buildMovieWhere(
      { status: MovieStatus.DRAFT, seriesId: 'series-1' },
      Role.ADMIN,
    );
    expect(where.status).toBe(MovieStatus.DRAFT);
    expect(where.seriesId).toBe('series-1');
  });

  it('a single genre keeps the legacy equals-insensitive shape (case-proof deep links)', () => {
    const where = buildMovieWhere({ genres: ['action'] }, Role.USER);
    expect(where.genre).toEqual({ equals: 'action', mode: 'insensitive' });
  });

  it('two or more genres use exact `in` — values are facet-sourced, casing is exact', () => {
    const where = buildMovieWhere({ genres: ['Action', 'Drama'] }, Role.USER);
    expect(where.genre).toEqual({ in: ['Action', 'Drama'] });
  });

  it('legacy ?genre= merges into genres instead of being a second code path', () => {
    const single = buildMovieWhere({ genre: 'Action' }, Role.USER);
    expect(single.genre).toEqual({ equals: 'Action', mode: 'insensitive' });

    const merged = buildMovieWhere(
      { genre: 'Action', genres: ['Drama'] },
      Role.USER,
    );
    expect(merged.genre).toEqual({ in: ['Drama', 'Action'] });
  });

  it('languages/directors/countries follow the same 1-vs-many rule', () => {
    const where = buildMovieWhere(
      {
        languages: ['Burmese'],
        directors: ['A', 'B'],
        countries: ['Myanmar'],
      },
      Role.USER,
    );
    expect(where.language).toEqual({ equals: 'Burmese', mode: 'insensitive' });
    expect(where.director).toEqual({ in: ['A', 'B'] });
    expect(where.country).toEqual({ equals: 'Myanmar', mode: 'insensitive' });
  });

  it('actorIds are OR within the facet — any of the selected cast', () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const where = buildMovieWhere({ actorIds: ids }, Role.USER);
    expect(where.actors).toEqual({ some: { id: { in: ids } } });
  });

  it('ageRatings map to an enum `in`', () => {
    const where = buildMovieWhere(
      { ageRatings: [AgeRating.G, AgeRating.PG13] },
      Role.USER,
    );
    expect(where.ageRating).toEqual({ in: [AgeRating.G, AgeRating.PG13] });
  });

  it('ranges apply only the bounds that were provided', () => {
    const where = buildMovieWhere(
      { yearFrom: 2000, ratingMax: 8, durationMin: 91 },
      Role.USER,
    );
    expect(where.releaseYear).toEqual({ gte: 2000 });
    expect(where.rating).toEqual({ lte: 8 });
    expect(where.duration).toEqual({ gte: 91 });
  });

  it('swapped bounds are normalized, not turned into an empty set', () => {
    const where = buildMovieWhere(
      { yearFrom: 2020, yearTo: 2000, ratingMin: 9, ratingMax: 2, durationMin: 120, durationMax: 90 },
      Role.USER,
    );
    expect(where.releaseYear).toEqual({ gte: 2000, lte: 2020 });
    expect(where.rating).toEqual({ gte: 2, lte: 9 });
    expect(where.duration).toEqual({ gte: 90, lte: 120 });
  });

  it('a single year is yearFrom === yearTo', () => {
    const where = buildMovieWhere({ yearFrom: 2018, yearTo: 2018 }, Role.USER);
    expect(where.releaseYear).toEqual({ gte: 2018, lte: 2018 });
  });

  it('a duration ceiling alone floors at 1 — unmeasured titles (duration 0) are not short films', () => {
    const where = buildMovieWhere({ durationMax: 90 }, Role.USER);
    expect(where.duration).toEqual({ gte: 1, lte: 90 });
  });

  it('a duration range whose low edge is 0 is lifted to 1, and nothing else inherits the floor', () => {
    const where = buildMovieWhere(
      { durationMin: 0, durationMax: 90, yearFrom: 0, ratingMin: 0 },
      Role.USER,
    );
    expect(where.duration).toEqual({ gte: 1, lte: 90 });
    expect(where.releaseYear).toEqual({ gte: 0 });
    expect(where.rating).toEqual({ gte: 0 });
  });

  it('no duration filter at all leaves duration unset — the sentinel rows stay browsable', () => {
    const where = buildMovieWhere({}, Role.USER);
    expect(where.duration).toBeUndefined();
  });

  it('never includes the search term — the caller decides how (plain OR vs relevance tiers)', () => {
    const where = buildMovieWhere({ search: 'avengers' }, Role.USER);
    expect(where.OR).toBeUndefined();
    expect(where.title).toBeUndefined();
  });
});

describe('movieOrderBy — the sort mapping table', () => {
  it.each([
    [MovieSort.RECENTLY_ADDED, [{ createdAt: 'desc' }, { id: 'desc' }]],
    [MovieSort.NEWEST, [{ releaseYear: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]],
    [MovieSort.OLDEST, [{ releaseYear: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]],
    [MovieSort.RATING, [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]],
    [MovieSort.TITLE, [{ title: 'asc' }, { id: 'asc' }]],
  ] as const)('%s', (sort, expected) => {
    expect(movieOrderBy(sort)).toEqual(expected);
  });
});

describe('MoviesService — catalog sort paths, facets, and metadata normalization', () => {
  let service: MoviesService;
  let prisma: {
    movie: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
    };
    watchHistory: { groupBy: jest.Mock };
    purchase: { groupBy: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'movie-1' }),
        create: jest.fn().mockResolvedValue({ id: 'movie-1' }),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({
          _min: { releaseYear: null },
          _max: { releaseYear: null },
        }),
      },
      watchHistory: { groupBy: jest.fn().mockResolvedValue([]) },
      purchase: { groupBy: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoviesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MinioService,
          useValue: { canonicalImageUrl: (u: string | null) => u },
        },
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

  describe('plain sorts', () => {
    it('applies the mapped orderBy chain (not the old hard-coded createdAt)', async () => {
      await service.findAll({ sort: MovieSort.RATING }, Role.USER);

      expect(prisma.movie.findMany.mock.calls[0][0].orderBy).toEqual([
        { rating: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('defaults to recentlyAdded when no sort is given', async () => {
      await service.findAll({}, Role.USER);

      expect(prisma.movie.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('relevance WITHOUT a search term falls back to recentlyAdded', async () => {
      await service.findAll({ sort: MovieSort.RELEVANCE }, Role.USER);

      expect(prisma.movie.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
      // One findMany + one count — no tier queries.
      expect(prisma.movie.findMany).toHaveBeenCalledTimes(1);
    });

    it('search still ORs title+description on non-relevance sorts', async () => {
      await service.findAll(
        { search: 'avengers', sort: MovieSort.TITLE },
        Role.USER,
      );

      expect(prisma.movie.findMany.mock.calls[0][0].where.OR).toEqual(
        movieSearchOr('avengers'),
      );
    });

    it('still loads CATALOG_INCLUDE on the page query', async () => {
      await service.findAll({ sort: MovieSort.NEWEST }, Role.USER);
      expect(prisma.movie.findMany.mock.calls[0][0].include).toMatchObject({
        categories: true,
        actors: true,
      });
    });
  });

  describe('relevance — two-tier deterministic ranking', () => {
    it('total is count(tier1) + count(tier2), which equals the plain OR count because the tiers are disjoint', async () => {
      prisma.movie.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

      const result = await service.findAll(
        { search: 'dota', sort: MovieSort.RELEVANCE },
        Role.USER,
      );

      expect(result.total).toBe(5);
    });

    it('tier 1 is base+title-contains; tier 2 is base+description-contains AND NOT title-contains (disjoint by construction)', async () => {
      prisma.movie.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      prisma.movie.findMany.mockResolvedValue([]);

      await service.findAll(
        { search: 'dota', sort: MovieSort.RELEVANCE },
        Role.USER,
      );

      const titleCond = { title: { contains: 'dota', mode: 'insensitive' } };
      const base = { status: MovieStatus.PUBLISHED, seriesId: null };
      const [tier1Count, tier2Count] = prisma.movie.count.mock.calls;
      expect(tier1Count[0].where).toEqual({ AND: [base, titleCond] });
      expect(tier2Count[0].where).toEqual({
        AND: [
          base,
          { description: { contains: 'dota', mode: 'insensitive' } },
          { NOT: titleCond },
        ],
      });
    });

    it('a page straddling the boundary takes the tail of tier 1 and the head of tier 2, both with CATALOG_INCLUDE', async () => {
      // 15 title matches; page 2 of 10 = rows 10..19 → 5 + 5.
      prisma.movie.count.mockResolvedValueOnce(15).mockResolvedValueOnce(30);
      const tier1Rows = [{ id: 't1' }];
      const tier2Rows = [{ id: 't2' }];
      prisma.movie.findMany
        .mockResolvedValueOnce(tier1Rows)
        .mockResolvedValueOnce(tier2Rows);

      const result = await service.findAll(
        { search: 'dota', sort: MovieSort.RELEVANCE, page: 2, limit: 10 },
        Role.USER,
      );

      const [firstCall, secondCall] = prisma.movie.findMany.mock.calls;
      expect(firstCall[0]).toMatchObject({ skip: 10, take: 5 });
      expect(secondCall[0]).toMatchObject({ skip: 0, take: 5 });
      expect(firstCall[0].include).toMatchObject({ categories: true, actors: true });
      expect(secondCall[0].include).toMatchObject({ categories: true, actors: true });
      expect(result.items).toEqual([{ id: 't1' }, { id: 't2' }]);
      expect(result.total).toBe(45);
    });

    it('a page fully inside tier 1 never queries tier 2 at all', async () => {
      prisma.movie.count.mockResolvedValueOnce(30).mockResolvedValueOnce(10);
      prisma.movie.findMany.mockResolvedValue([]);

      await service.findAll(
        { search: 'dota', sort: MovieSort.RELEVANCE, page: 1, limit: 10 },
        Role.USER,
      );

      expect(prisma.movie.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('mostViewed — unique viewers from watch_history', () => {
    const day = (n: number) => new Date(2026, 0, n);

    it('orders by viewer count desc, then createdAt desc for ties, 0-history movies last', async () => {
      prisma.watchHistory.groupBy.mockResolvedValue([
        { movieId: 'm-popular', _count: { _all: 3 } },
        { movieId: 'm-once', _count: { _all: 1 } },
      ]);
      // Id-only scan of the filtered set (deliberately unordered input).
      prisma.movie.findMany
        .mockResolvedValueOnce([
          { id: 'm-unwatched-old', createdAt: day(1) },
          { id: 'm-once', createdAt: day(2) },
          { id: 'm-popular', createdAt: day(3) },
          { id: 'm-unwatched-new', createdAt: day(4) },
        ])
        // Page refetch returns in arbitrary DB order — must be reordered.
        .mockResolvedValueOnce([
          { id: 'm-unwatched-old' },
          { id: 'm-popular' },
          { id: 'm-once' },
          { id: 'm-unwatched-new' },
        ]);

      const result = await service.findAll(
        { sort: MovieSort.MOST_VIEWED },
        Role.USER,
      );

      expect(result.items.map((m) => m.id)).toEqual([
        'm-popular',
        'm-once',
        'm-unwatched-new', // 0 viewers → after every watched movie,
        'm-unwatched-old', // newest first among themselves
      ]);
      expect(result.total).toBe(4);
    });

    it('refetches the page ids with CATALOG_INCLUDE — the aggregate path must not leak bare rows to MovieResponseDto', async () => {
      prisma.watchHistory.groupBy.mockResolvedValue([]);
      prisma.movie.findMany
        .mockResolvedValueOnce([{ id: 'm-1', createdAt: day(1) }])
        .mockResolvedValueOnce([{ id: 'm-1' }]);

      await service.findAll({ sort: MovieSort.MOST_VIEWED }, Role.USER);

      const refetch = prisma.movie.findMany.mock.calls[1][0];
      expect(refetch.where).toEqual({ id: { in: ['m-1'] } });
      expect(refetch.include).toMatchObject({ categories: true, actors: true });
    });

    it('total is the filtered set size, and an empty page skips the refetch', async () => {
      prisma.watchHistory.groupBy.mockResolvedValue([]);
      prisma.movie.findMany.mockResolvedValueOnce([]);

      const result = await service.findAll(
        { sort: MovieSort.MOST_VIEWED },
        Role.USER,
      );

      expect(result).toMatchObject({ items: [], total: 0 });
      expect(prisma.movie.findMany).toHaveBeenCalledTimes(1);
    });

    it('respects the catalog filters — the id scan carries the built where', async () => {
      prisma.watchHistory.groupBy.mockResolvedValue([]);
      prisma.movie.findMany.mockResolvedValueOnce([]);

      await service.findAll(
        { sort: MovieSort.MOST_VIEWED, genres: ['Action'] },
        Role.USER,
      );

      expect(prisma.movie.findMany.mock.calls[0][0].where).toMatchObject({
        status: MovieStatus.PUBLISHED,
        seriesId: null,
        genre: { equals: 'Action', mode: 'insensitive' },
      });
    });
  });

  describe('mostPurchased — the frozen pre-subscription table', () => {
    it('groups the purchases table, not watch history', async () => {
      prisma.purchase.groupBy.mockResolvedValue([
        { movieId: 'm-1', _count: { _all: 2 } },
      ]);
      prisma.movie.findMany
        .mockResolvedValueOnce([
          { id: 'm-1', createdAt: new Date(2026, 0, 1) },
          { id: 'm-2', createdAt: new Date(2026, 0, 2) },
        ])
        .mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-2' }]);

      const result = await service.findAll(
        { sort: MovieSort.MOST_PURCHASED },
        Role.USER,
      );

      expect(prisma.purchase.groupBy).toHaveBeenCalledWith({
        by: ['movieId'],
        _count: { _all: true },
      });
      expect(prisma.watchHistory.groupBy).not.toHaveBeenCalled();
      expect(result.items.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    });
  });

  describe('getFacets', () => {
    const groupRows = {
      genre: [
        { genre: 'Drama', _count: 1 },
        { genre: 'Action', _count: 3 },
        { genre: '', _count: 2 }, // placeholder rows — must be dropped
      ],
      language: [{ language: 'English', _count: 3 }],
      country: [{ country: null, _count: 6 }],
      ageRating: [{ ageRating: null, _count: 6 }],
      director: [{ director: null, _count: 6 }],
    };

    beforeEach(() => {
      prisma.movie.groupBy.mockImplementation(
        ({ by }: { by: [keyof typeof groupRows] }) =>
          Promise.resolve(groupRows[by[0]]),
      );
      prisma.movie.aggregate.mockResolvedValue({
        _min: { releaseYear: 2019 },
        _max: { releaseYear: 2026 },
      });
    });

    it('offers only real values: count-desc order, null/empty dropped, empty facets stay [] (auto-hide)', async () => {
      const facets = await service.getFacets();

      expect(facets.genres).toEqual([
        { value: 'Action', count: 3 },
        { value: 'Drama', count: 1 },
      ]);
      expect(facets.languages).toEqual([{ value: 'English', count: 3 }]);
      // All-null facets are empty lists — the clients hide those controls.
      expect(facets.countries).toEqual([]);
      expect(facets.ageRatings).toEqual([]);
      expect(facets.directors).toEqual([]);
      expect(facets.years).toEqual({ min: 2019, max: 2026 });
    });

    it('always computes over the PUBLIC set: PUBLISHED standalone movies', async () => {
      await service.getFacets();

      for (const call of prisma.movie.groupBy.mock.calls) {
        expect(call[0].where).toEqual({
          status: MovieStatus.PUBLISHED,
          seriesId: null,
        });
      }
    });

    it('caches for 60s — a second call within the TTL never hits prisma again', async () => {
      await service.getFacets();
      const callsAfterFirst = prisma.movie.groupBy.mock.calls.length;

      const again = await service.getFacets();

      expect(prisma.movie.groupBy.mock.calls.length).toBe(callsAfterFirst);
      expect(again.genres[0]).toEqual({ value: 'Action', count: 3 });
    });

    it('years is null on an empty catalog instead of a fake range', async () => {
      prisma.movie.aggregate.mockResolvedValue({
        _min: { releaseYear: null },
        _max: { releaseYear: null },
      });

      const facets = await service.getFacets();
      expect(facets.years).toBeNull();
    });
  });

  describe("'' → null on the optional metadata fields", () => {
    beforeEach(() => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
    });

    it('update: a blanked director/country persists as NULL, so it cannot become a fake facet value', async () => {
      await service.update('movie-1', { director: '', country: '  ' });

      expect(prisma.movie.update.mock.calls[0][0].data).toMatchObject({
        director: null,
        country: null,
      });
    });

    it('update: absent fields stay absent — a partial edit never touches them', async () => {
      await service.update('movie-1', { title: 'New title' });

      const data = prisma.movie.update.mock.calls[0][0].data;
      expect('director' in data).toBe(false);
      expect('country' in data).toBe(false);
    });

    it('update: real values pass through, and ageRating null clears to Unrated', async () => {
      await service.update('movie-1', {
        director: 'Some Director',
        country: 'Myanmar',
        ageRating: null,
      });

      expect(prisma.movie.update.mock.calls[0][0].data).toMatchObject({
        director: 'Some Director',
        country: 'Myanmar',
        ageRating: null,
      });
    });

    it('create: same normalization', async () => {
      await service.create({
        title: 'T',
        description: 'D',
        genre: 'Action',
        language: 'Burmese',
        releaseYear: 2026,
        duration: 100,
        director: '',
        country: 'Myanmar',
      });

      expect(prisma.movie.create.mock.calls[0][0].data).toMatchObject({
        director: null,
        country: 'Myanmar',
      });
    });
  });
});
