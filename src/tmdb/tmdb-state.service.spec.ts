import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MinioService } from '../common/storage/minio.service';
import { TmdbLookupStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { descriptionHash } from './tmdb-auto';
import { TmdbRunRegistry, movieRunKey } from './tmdb-runs';
import { TmdbStateService, movieSearchInput } from './tmdb-state.service';
import { TmdbClient } from './tmdb.client';

type Row = Record<string, any>;

const MOVIE_A = '11111111-1111-4111-8111-111111111111';
const MOVIE_B = '22222222-2222-4222-8222-222222222222';
const MISSING = '99999999-9999-4999-8999-999999999999';
const SERIES_ID = '33333333-3333-4333-8333-333333333333';
const FETCHED = new Date('2026-11-06T09:30:00.000Z');

const stored = (name: string) =>
  `http://cache.local/movies/images/movie/${name}`;

/** A movie straight after its folder upload: never looked up. */
const movieRow = (overrides: Row = {}): Row => ({
  id: MOVIE_A,
  title: 'Inception',
  description: '',
  releaseYear: 2010,
  duration: 0,
  genre: '',
  language: '',
  country: null,
  director: null,
  ageRating: null,
  posterUrl: null,
  coverUrl: null,
  sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
  tmdbId: null,
  tmdbStatus: TmdbLookupStatus.NONE,
  tmdbError: null,
  tmdbFetchedAt: null,
  tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
  categories: [],
  actors: [],
  ...overrides,
});

describe('movieSearchInput — what a lookup searches for (PLAN 2.4)', () => {
  const born = { v: 1, title: 'The Dark Knight', releaseYear: 2008 };

  it('parses the folder name while the title is still the one the upload gave', () => {
    expect(
      movieSearchInput(
        {
          title: 'The Dark Knight',
          sourceName: 'The_Dark_Knight_2008_720p_BrRip',
          tmdbAuto: born,
        },
        2026,
      ),
    ).toEqual({ query: 'The Dark Knight', year: 2008, yearFollowsTitle: true });
  });

  it('parses the title once staff renamed it', () => {
    expect(
      movieSearchInput(
        {
          title: 'Batman Begins 2005',
          sourceName: 'The_Dark_Knight_2008_720p_BrRip',
          tmdbAuto: born,
        },
        2026,
      ),
    ).toEqual({ query: 'Batman Begins', year: 2005, yearFollowsTitle: true });
  });

  it('parses the title when there is no folder name, or no tmdbAuto to compare with', () => {
    expect(
      movieSearchInput(
        { title: 'The Dark Knight', sourceName: null, tmdbAuto: born },
        2026,
      ).query,
    ).toBe('The Dark Knight');
    expect(
      movieSearchInput(
        {
          title: 'Old Row',
          sourceName: 'Something.Else.1999',
          tmdbAuto: null,
        },
        2026,
      ),
    ).toEqual({ query: 'Old Row', year: null, yearFollowsTitle: false });
  });
});

describe('TmdbStateService', () => {
  let service: TmdbStateService;
  let prisma: {
    movie: { findMany: jest.Mock };
    series: { findUnique: jest.Mock };
  };
  let client: { isEnabled: boolean };
  let runs: TmdbRunRegistry;

  beforeEach(async () => {
    prisma = {
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      series: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    client = { isEnabled: true };
    runs = new TmdbRunRegistry();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbStateService,
        { provide: PrismaService, useValue: prisma },
        { provide: TmdbClient, useValue: client },
        { provide: TmdbRunRegistry, useValue: runs },
        {
          provide: MinioService,
          useValue: {
            keyFromPublicUrl: (url: string) => url.split('/movies/')[1] ?? null,
          },
        },
      ],
    }).compile();
    service = module.get(TmdbStateService);
  });

  describe('movieStates', () => {
    it('reads the movies in one query, with only the ids of their lists', async () => {
      await service.movieStates([MOVIE_A, MOVIE_B]);

      expect(prisma.movie.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.movie.findMany).toHaveBeenCalledWith({
        where: { id: { in: [MOVIE_A, MOVIE_B] } },
        include: {
          categories: { select: { id: true } },
          actors: { select: { id: true } },
        },
      });
    });

    it('a movie that was never looked up', async () => {
      prisma.movie.findMany.mockResolvedValue([movieRow()]);

      await expect(service.movieStates([MOVIE_A])).resolves.toEqual({
        items: [
          {
            movieId: MOVIE_A,
            status: 'NONE',
            error: null,
            tmdbId: null,
            match: null,
            fetchedAt: null,
            sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
            // What the pick-a-match dialog starts with.
            search: { query: 'Inception', year: 2010 },
            images: { poster: 'none', cover: 'none' },
            // The born title is remembered too, but it came from the folder
            // name: nothing is "from TMDB" on a title that is not linked.
            autoFields: [],
          },
        ],
      });
    });

    it('a matched movie: the entry, when it was fetched, and what is still automatic', async () => {
      const overview = 'A thief who steals secrets.';
      prisma.movie.findMany.mockResolvedValue([
        movieRow({
          description: overview,
          genre: 'Thriller',
          language: 'English',
          director: 'Christopher Nolan',
          duration: 151,
          posterUrl: stored('tmdb-poster.jpg'),
          coverUrl: stored('staff-upload.jpg'),
          categories: [{ id: 'c-1' }, { id: 'c-2' }],
          actors: [{ id: 'a-1' }, { id: 'a-staff' }],
          tmdbId: 27205,
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbFetchedAt: FETCHED,
          tmdbAuto: {
            v: 1,
            match: { title: 'Inception', year: 2010 },
            title: 'Inception',
            releaseYear: 2010,
            descriptionHash: descriptionHash(overview),
            duration: 148,
            genre: 'Action',
            language: 'English',
            director: 'Christopher Nolan',
            posterUrl: stored('tmdb-poster.jpg'),
            posterPath: '/poster.jpg',
            coverUrl: stored('tmdb-backdrop.jpg'),
            coverPath: '/backdrop.jpg',
            categoryIds: ['c-2', 'c-1'],
            actorIds: ['a-1'],
          },
        }),
      ]);

      const { items } = await service.movieStates([MOVIE_A]);

      expect(items[0]).toEqual({
        movieId: MOVIE_A,
        status: 'MATCHED',
        error: null,
        tmdbId: 27205,
        match: { title: 'Inception', year: 2010 },
        fetchedAt: '2026-11-06T09:30:00.000Z',
        sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
        search: { query: 'Inception', year: 2010 },
        // Read off the file name: tmdb-<uuid> or not.
        images: { poster: 'tmdb', cover: 'own' },
        // Not genre (staff changed it), duration (measured), cover (staff's
        // upload) or cast (staff added someone).
        autoFields: [
          'title',
          'description',
          'releaseYear',
          'language',
          'director',
          'poster',
          'categories',
        ],
      });
    });

    it.each([
      'unreachable',
      'rate_limited',
      'key_rejected',
      'interrupted',
      'internal',
    ])('a failed lookup says why: %s', async (tmdbError) => {
      prisma.movie.findMany.mockResolvedValue([
        movieRow({ tmdbStatus: TmdbLookupStatus.FAILED, tmdbError }),
      ]);

      const { items } = await service.movieStates([MOVIE_A]);

      expect(items[0]).toEqual(
        expect.objectContaining({ status: 'FAILED', error: tmdbError }),
      );
    });

    it('an unknown reason reads as internal; a reason left on a status that is not FAILED is not shown', async () => {
      prisma.movie.findMany.mockResolvedValue([
        movieRow({
          tmdbStatus: TmdbLookupStatus.FAILED,
          tmdbError: 'something new',
        }),
        movieRow({
          id: MOVIE_B,
          tmdbStatus: TmdbLookupStatus.PENDING,
          tmdbError: 'unreachable',
        }),
      ]);
      // MOVIE_B's lookup is running.
      runs.tryStart(movieRunKey(MOVIE_B));

      const { items } = await service.movieStates([MOVIE_A, MOVIE_B]);

      expect(items.map((item) => [item.status, item.error])).toEqual([
        ['FAILED', 'internal'],
        ['PENDING', null],
      ]);
    });

    it('answers in the order asked, each movie once, and leaves out an id that does not exist', async () => {
      prisma.movie.findMany.mockResolvedValue([
        movieRow({ id: MOVIE_A }),
        movieRow({ id: MOVIE_B }),
      ]);

      const { items } = await service.movieStates([
        MOVIE_B,
        MISSING,
        MOVIE_A,
        MOVIE_B,
      ]);

      expect(items.map((item) => item.movieId)).toEqual([MOVIE_B, MOVIE_A]);
    });

    it('starts the dialog from the title staff typed, once they renamed the movie', async () => {
      prisma.movie.findMany.mockResolvedValue([
        movieRow({ title: 'Batman Begins' }),
      ]);

      const { items } = await service.movieStates([MOVIE_A]);

      expect(items[0].search).toEqual({ query: 'Batman Begins', year: null });
    });

    it('never hands out the staff-only columns raw', async () => {
      prisma.movie.findMany.mockResolvedValue([movieRow()]);

      const { items } = await service.movieStates([MOVIE_A]);

      expect(Object.keys(items[0]).sort()).toEqual([
        'autoFields',
        'error',
        'fetchedAt',
        'images',
        'match',
        'movieId',
        'search',
        'sourceName',
        'status',
        'tmdbId',
      ]);
    });

    it('answers while the key is missing too — the folder name of an upload stays readable', async () => {
      client.isEnabled = false;
      // Born with a cleaned title: the folder name is the only place the
      // cut words ("1984") can still be read.
      prisma.movie.findMany.mockResolvedValue([
        movieRow({
          title: 'Wonder Woman',
          releaseYear: 1984,
          sourceName: 'Wonder.Woman.1984.1080p.BluRay',
          tmdbAuto: { v: 1, title: 'Wonder Woman', releaseYear: 1984 },
        }),
      ]);

      const { items } = await service.movieStates([MOVIE_A]);

      expect(items).toEqual([
        expect.objectContaining({
          movieId: MOVIE_A,
          status: 'NONE',
          error: null,
          tmdbId: null,
          sourceName: 'Wonder.Woman.1984.1080p.BluRay',
          autoFields: [],
        }),
      ]);
    });

    describe('a movie that is PENDING', () => {
      const pending = () =>
        prisma.movie.findMany.mockResolvedValue([
          movieRow({ tmdbStatus: TmdbLookupStatus.PENDING }),
        ]);

      it('with its lookup running: PENDING', async () => {
        pending();
        runs.tryStart(movieRunKey(MOVIE_A));

        const { items } = await service.movieStates([MOVIE_A]);

        expect([items[0].status, items[0].error]).toEqual(['PENDING', null]);
      });

      it('with no run behind it (its result could not be written): shown as FAILED / interrupted, so staff get "Try again"', async () => {
        pending();

        const { items } = await service.movieStates([MOVIE_A]);

        expect([items[0].status, items[0].error]).toEqual([
          'FAILED',
          'interrupted',
        ]);
        // Read-time only: the state route never writes.
        expect(Object.keys(prisma.movie)).toEqual(['findMany']);
      });

      it('whose lookup ended while the rows were being read is not called interrupted', async () => {
        runs.tryStart(movieRunKey(MOVIE_A));
        prisma.movie.findMany.mockImplementation(async () => {
          const rows = [movieRow({ tmdbStatus: TmdbLookupStatus.PENDING })];
          // The run settles and lets go right after this read saw PENDING.
          runs.finish(movieRunKey(MOVIE_A));
          return rows;
        });

        const { items } = await service.movieStates([MOVIE_A]);

        expect([items[0].status, items[0].error]).toEqual(['PENDING', null]);
      });

      it('whose lookup started while the rows were being read is not called interrupted either', async () => {
        prisma.movie.findMany.mockImplementation(async () => {
          runs.tryStart(movieRunKey(MOVIE_A));
          return [movieRow({ tmdbStatus: TmdbLookupStatus.PENDING })];
        });

        const { items } = await service.movieStates([MOVIE_A]);

        expect([items[0].status, items[0].error]).toEqual(['PENDING', null]);
      });

      it('a run of another movie does not count', async () => {
        pending();
        runs.tryStart(movieRunKey(MOVIE_B));

        const { items } = await service.movieStates([MOVIE_A]);

        expect(items[0].status).toBe('FAILED');
      });
    });
  });

  describe('seriesState', () => {
    const seriesRow = (overrides: Row = {}): Row => ({
      id: SERIES_ID,
      title: 'Stranger Things',
      description: 'Typed by staff.',
      releaseYear: 2016,
      genre: 'Drama',
      language: 'English',
      country: null,
      posterUrl: null,
      coverUrl: null,
      tmdbId: null,
      tmdbFetchedAt: null,
      tmdbAuto: null,
      categories: [],
      actors: [],
      ...overrides,
    });

    it('a show that is not linked: the search starts from its title, with no year', async () => {
      prisma.series.findUnique.mockResolvedValue(seriesRow());

      await expect(service.seriesState(SERIES_ID)).resolves.toEqual({
        seriesId: SERIES_ID,
        tmdbId: null,
        match: null,
        fetchedAt: null,
        search: { query: 'Stranger Things', year: null },
        images: { poster: 'none', cover: 'none' },
        autoFields: [],
      });
      expect(prisma.series.findUnique).toHaveBeenCalledWith({
        where: { id: SERIES_ID },
        include: {
          categories: { select: { id: true } },
          actors: { select: { id: true } },
        },
      });
    });

    it('a linked show: the entry and the fields that are still automatic — never a movie-only field', async () => {
      prisma.series.findUnique.mockResolvedValue(
        seriesRow({
          title: 'Stranger Things',
          genre: 'Sci-Fi',
          country: 'English',
          posterUrl: 'http://cache.local/movies/images/series/tmdb-st.jpg',
          coverUrl: 'http://cache.local/movies/images/series/own.jpg',
          categories: [{ id: 'c-1' }],
          tmdbId: 66732,
          tmdbFetchedAt: FETCHED,
          tmdbAuto: {
            v: 1,
            match: { title: 'Stranger Things', year: 2016 },
            title: 'Stranger Things',
            releaseYear: 2016,
            genre: 'Sci-Fi',
            country: 'English',
            posterUrl: 'http://cache.local/movies/images/series/tmdb-st.jpg',
            posterPath: '/st.jpg',
            categoryIds: ['c-1'],
          },
        }),
      );

      await expect(service.seriesState(SERIES_ID)).resolves.toEqual({
        seriesId: SERIES_ID,
        tmdbId: 66732,
        match: { title: 'Stranger Things', year: 2016 },
        fetchedAt: '2026-11-06T09:30:00.000Z',
        search: { query: 'Stranger Things', year: null },
        images: { poster: 'tmdb', cover: 'own' },
        autoFields: [
          'title',
          'releaseYear',
          'genre',
          'country',
          'poster',
          'categories',
        ],
      });
    });

    it('404 for a series that does not exist; 503 while the key is missing', async () => {
      await expect(service.seriesState(SERIES_ID)).rejects.toThrow(
        NotFoundException,
      );

      client.isEnabled = false;
      await expect(service.seriesState(SERIES_ID)).rejects.toMatchObject({
        code: 'TMDB_NOT_CONFIGURED',
      });
    });
  });
});
