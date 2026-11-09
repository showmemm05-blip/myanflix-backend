import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { movieSnapshot, seriesSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import {
  AccessType,
  MovieStatus,
  Role,
  SeriesStatus,
  TmdbLookupStatus,
} from '../generated/prisma/client';
import { ImageStoreService } from '../images/image-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { descriptionHash, type TmdbAuto } from './tmdb-auto';
import { TmdbCastService } from './tmdb-cast.service';
import { TmdbFillService } from './tmdb-fill.service';
import { TmdbImageFetcher } from './tmdb-image.fetcher';
import type { TmdbCastPerson } from './tmdb-mapping';
import type { TmdbMovieDetails, TmdbTvDetails } from './tmdb-payload';
import { TmdbRunRegistry, movieRunKey } from './tmdb-runs';
import { TmdbClient } from './tmdb.client';
import {
  TMDB_MOVIE_FIELDS,
  TMDB_SERIES_FIELDS,
  type TmdbField,
  type TmdbPreviewLine,
} from './tmdb.types';

type Row = Record<string, any>;

const STAFF = {
  id: 'staff-1',
  username: 'uploader',
  role: Role.CONTENT_UPLOADER,
  appRoleId: null,
} as unknown as AuthenticatedUser;

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const INCEPTION = 27205;
const STRANGER_THINGS = 66732;
const WHEN = new Date('2026-11-01T08:00:00Z');

/**
 * A deep copy, as a database hands a row back: the caller can change it
 * without changing what is stored. (Not structuredClone: its Dates come
 * from another realm under jest and fail `expect.any(Date)`.)
 */
function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((entry) => copy(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copy(entry)]),
    ) as T;
  }
  return value;
}

/** A stored picture URL, as ImageStoreService hands one back. */
const stored = (purpose: string, name: string) =>
  `http://cache.local/movies/images/${purpose}/${name}`;
const keyOfUrl = (url: string): string | null =>
  url.split('/movies/')[1] ?? null;

const OVERVIEW = 'A thief who steals corporate secrets through dreams.';

const CATEGORIES = [
  { id: 'c-action', name: 'Action', description: null },
  { id: 'c-scifi', name: 'Sci-Fi', description: null },
  { id: 'c-adventure', name: 'Adventure', description: null },
  { id: 'c-drama', name: 'Drama', description: null },
  { id: 'c-mystery', name: 'Mystery', description: null },
  { id: 'c-staff', name: 'Staff Picks', description: null },
];

const actorRow = (id: string, name: string, tmdbPersonId: number | null) => ({
  id,
  name,
  imageUrl: null,
  tmdbPersonId,
  createdAt: WHEN,
  updatedAt: WHEN,
});

const ACTORS = [
  actorRow('a-leo', 'Leonardo DiCaprio', 6193),
  actorRow('a-jgl', 'Joseph Gordon-Levitt', 24045),
  actorRow('a-old', 'Old Match Actor', 1),
  actorRow('a-staff', 'Added By Staff', null),
];

const LEO: TmdbCastPerson = {
  tmdbPersonId: 6193,
  name: 'Leonardo DiCaprio',
  profilePath: '/leo.jpg',
};
const JGL: TmdbCastPerson = {
  tmdbPersonId: 24045,
  name: 'Joseph Gordon-Levitt',
  profilePath: null,
};

/** A standalone movie as the upload placeholder and a finished finalize leave it, claimed by a lookup. */
const movieRow = (overrides: Row = {}): Row => ({
  id: MOVIE_ID,
  title: 'Inception',
  description: '',
  descriptionMm: null,
  posterUrl: null,
  coverUrl: null,
  thumbnailUrl: null,
  genre: '',
  language: '',
  country: null,
  director: null,
  ageRating: null,
  releaseYear: 2010,
  duration: 0,
  rating: 0,
  accessType: AccessType.SUBSCRIPTION,
  status: MovieStatus.READY_TO_PUBLISH,
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
  tmdbId: null,
  tmdbStatus: TmdbLookupStatus.PENDING,
  tmdbError: null,
  tmdbFetchedAt: null,
  tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
  createdAt: WHEN,
  updatedAt: WHEN,
  categories: [],
  actors: [],
  videos: [],
  ...overrides,
});

/** A show staff made by hand: no tmdbAuto, so its title and year are theirs. */
const seriesRow = (overrides: Row = {}): Row => ({
  id: SERIES_ID,
  title: 'Stranger Things',
  description: 'Typed by staff.',
  descriptionMm: null,
  posterUrl: null,
  coverUrl: null,
  genre: 'Drama',
  language: 'English',
  country: null,
  releaseYear: 2016,
  rating: 0,
  accessType: AccessType.SUBSCRIPTION,
  status: SeriesStatus.DRAFT,
  tmdbId: null,
  tmdbFetchedAt: null,
  tmdbAuto: null,
  createdAt: WHEN,
  updatedAt: WHEN,
  categories: [],
  actors: [],
  ...overrides,
});

const inception = (
  overrides: Partial<TmdbMovieDetails> = {},
): TmdbMovieDetails => ({
  id: INCEPTION,
  title: 'Inception',
  originalTitle: 'Inception',
  overview: OVERVIEW,
  releaseDate: '2010-07-15',
  runtime: 148,
  genres: [
    { id: 28, name: 'Action' },
    { id: 878, name: 'Science Fiction' },
    { id: 12, name: 'Adventure' },
  ],
  originalLanguage: 'en',
  productionCountries: ['US'],
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
  cast: [
    {
      id: 6193,
      name: 'Leonardo DiCaprio',
      characters: ['Cobb'],
      order: 0,
      profilePath: '/leo.jpg',
    },
    {
      id: 24045,
      name: 'Joseph Gordon-Levitt',
      characters: ['Arthur'],
      order: 1,
      profilePath: null,
    },
  ],
  crew: [{ name: 'Christopher Nolan', job: 'Director' }],
  usCertifications: [{ certification: 'PG-13', type: 3 }],
  ...overrides,
});

const strangerThings = (
  overrides: Partial<TmdbTvDetails> = {},
): TmdbTvDetails => ({
  id: STRANGER_THINGS,
  title: 'Stranger Things',
  originalTitle: 'Stranger Things',
  overview: 'A boy vanishes and a town uncovers a mystery.',
  firstAirDate: '2016-07-15',
  genres: [
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 9648, name: 'Mystery' },
  ],
  originalLanguage: 'en',
  originCountries: ['US'],
  posterPath: '/st.jpg',
  backdropPath: '/st-wide.jpg',
  cast: [
    {
      id: 6193,
      name: 'Leonardo DiCaprio',
      characters: ['Guest'],
      order: 0,
      profilePath: '/leo.jpg',
    },
  ],
  ...overrides,
});

/** Everything a fill always writes besides the fields themselves. */
const MOVIE_BOOKKEEPING = [
  'tmdbAuto',
  'tmdbError',
  'tmdbFetchedAt',
  'tmdbId',
  'tmdbStatus',
];
const SERIES_BOOKKEEPING = ['tmdbAuto', 'tmdbFetchedAt', 'tmdbId'];

/** Columns no TMDB action may ever write (PLAN.md 2.6 and 3). */
const NEVER_WRITTEN = [
  'status',
  'accessType',
  'rating',
  'descriptionMm',
  'thumbnailUrl',
  'seriesId',
  'seasonNumber',
  'episodeNumber',
  'sourceName',
];

describe('TmdbFillService', () => {
  let service: TmdbFillService;
  let runs: TmdbRunRegistry;
  let movies: Map<string, Row>;
  let shows: Map<string, Row>;
  let prisma: {
    movie: { findUnique: jest.Mock; update: jest.Mock };
    series: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    category: { findMany: jest.Mock };
    actor: { findMany: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let client: {
    isEnabled: boolean;
    movieDetails: jest.Mock;
    tvDetails: jest.Mock;
  };
  let images: { fetch: jest.Mock };
  let imageStore: { save: jest.Mock };
  let cast: { plan: jest.Mock; attach: jest.Mock };
  let minioService: {
    keyFromPublicUrl: jest.Mock;
    imageUrl: jest.Mock;
    deleteObject: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let categories: typeof CATEGORIES;
  let actors: typeof ACTORS;

  /**
   * A table held in memory, behaving like the two Prisma calls a fill makes
   * on a title: findUnique with its relations, and update with `set` on the
   * two lists (which, like Prisma, refuses an id that does not exist).
   */
  const table = (rows: Map<string, Row>) => ({
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? copy(row) : null;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('Record to update not found');
        for (const [key, value] of Object.entries(data)) {
          if (key === 'categories' || key === 'actors') {
            const source: Row[] = key === 'categories' ? categories : actors;
            row[key] = (value as { set: Array<{ id: string }> }).set.map(
              ({ id }) => {
                const found = source.find((entry) => entry.id === id);
                if (!found) throw new Error(`No ${key} row ${id} to connect`);
                return found;
              },
            );
          } else {
            row[key] = value;
          }
        }
        return copy(row);
      },
    ),
  });

  const byIds =
    (source: () => Row[]) =>
    async (args?: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      return copy(
        ids ? source().filter((row) => ids.includes(row.id)) : source(),
      );
    };

  const haveMovie = (overrides: Row = {}) => {
    const row = movieRow(overrides);
    movies.set(row.id, row);
    return row;
  };
  const haveSeries = (overrides: Row = {}) => {
    const row = seriesRow(overrides);
    shows.set(row.id, row);
    return row;
  };
  const movieNow = () => movies.get(MOVIE_ID) as Row;
  const seriesNow = (id = SERIES_ID) => shows.get(id) as Row;

  /** The `data` of the one write a fill made to the movie / the series. */
  const movieWrite = (): Row => {
    expect(prisma.movie.update).toHaveBeenCalledTimes(1);
    return (prisma.movie.update.mock.calls[0][0] as { data: Row }).data;
  };
  const seriesWrite = (): Row => {
    expect(prisma.series.update).toHaveBeenCalledTimes(1);
    return (prisma.series.update.mock.calls[0][0] as { data: Row }).data;
  };
  const fieldKeys = (data: Row, bookkeeping: string[]) =>
    Object.keys(data)
      .filter((key) => !bookkeeping.includes(key))
      .sort();
  const auditRows = (action: string): Row[] =>
    audit.record.mock.calls
      .map(([row]) => row as Row)
      .filter((row) => row.action === action);
  const deletedKeys = (): string[] =>
    minioService.deleteObject.mock.calls.map(([key]) => key as string);

  const automatic = (trigger: 'upload' | 'staff' = 'upload') =>
    service.fillMovieAutomatically(MOVIE_ID, INCEPTION, STAFF, trigger);

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    movies = new Map();
    shows = new Map();
    categories = copy(CATEGORIES);
    actors = copy(ACTORS);

    prisma = {
      movie: table(movies),
      series: {
        ...table(shows),
        findFirst: jest.fn(
          async ({ where }: { where: { tmdbId: number } }) =>
            [...shows.values()].find((row) => row.tmdbId === where.tmdbId) ??
            null,
        ),
        create: jest.fn(async ({ data }: { data: Row }) => {
          const row = seriesRow({
            id: 'series-new',
            description: '',
            genre: '',
            language: '',
            ...data,
          });
          shows.set(row.id, row);
          return copy(row);
        }),
      },
      category: { findMany: jest.fn(byIds(() => categories)) },
      actor: { findMany: jest.fn(byIds(() => actors)) },
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    client = {
      isEnabled: true,
      movieDetails: jest
        .fn()
        .mockResolvedValue({ ok: true, data: inception() }),
      tvDetails: jest
        .fn()
        .mockResolvedValue({ ok: true, data: strangerThings() }),
    };
    images = {
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        buffer: Buffer.from('jpeg-bytes'),
        size: 'original',
      }),
    };
    imageStore = {
      // "poster.jpg" for a movie is stored as images/movie/tmdb-poster.jpg.
      save: jest.fn(async (purpose: string, filename: string) =>
        stored(purpose, `tmdb-${filename}`),
      ),
    };
    cast = {
      plan: jest.fn().mockResolvedValue([
        {
          person: LEO,
          action: 'reuse',
          actor: { ...ACTORS[0] },
          link: false,
        },
        { person: JGL, action: 'create', actor: null, link: false },
      ]),
      attach: jest.fn().mockResolvedValue({
        actorIds: ['a-leo', 'a-jgl'],
        reused: 1,
        created: 1,
        skipped: [],
      }),
    };
    minioService = {
      keyFromPublicUrl: jest.fn(keyOfUrl),
      // Re-hosted for the request, as every stored URL that leaves the API is.
      imageUrl: jest.fn((url: string | null) =>
        url ? url.replace('cache.local', 'request.host') : url,
      ),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    runs = new TmdbRunRegistry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbFillService,
        { provide: PrismaService, useValue: prisma },
        { provide: TmdbClient, useValue: client },
        { provide: TmdbImageFetcher, useValue: images },
        { provide: ImageStoreService, useValue: imageStore },
        { provide: TmdbCastService, useValue: cast },
        { provide: MinioService, useValue: minioService },
        { provide: AuditService, useValue: audit },
        { provide: TmdbRunRegistry, useValue: runs },
      ],
    }).compile();
    service = module.get(TmdbFillService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------
  describe('the automatic fill (after an upload, one clear match)', () => {
    it('fills every detail of a fresh upload and links the movie', async () => {
      haveMovie();

      const result = await automatic();

      expect(result).toEqual({
        outcome: 'filled',
        report: {
          filled: [...TMDB_MOVIE_FIELDS],
          skipped: [],
          actors: { reused: 1, created: 1, skipped: [] },
          categories: {
            added: ['Action', 'Sci-Fi', 'Adventure'],
            unmatched: [],
          },
        },
      });
      const movie = movieNow();
      expect(movie).toEqual(
        expect.objectContaining({
          title: 'Inception',
          description: OVERVIEW,
          releaseYear: 2010,
          duration: 148,
          genre: 'Action',
          language: 'English',
          country: 'English',
          director: 'Christopher Nolan',
          ageRating: 'PG13',
          posterUrl: stored('movie', 'tmdb-poster.jpg'),
          coverUrl: stored('movie', 'tmdb-backdrop.jpg'),
          tmdbId: INCEPTION,
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbError: null,
          tmdbFetchedAt: expect.any(Date),
        }),
      );
      expect(movie.categories.map((c: Row) => c.id)).toEqual([
        'c-action',
        'c-scifi',
        'c-adventure',
      ]);
      expect(movie.actors.map((a: Row) => a.id)).toEqual(['a-leo', 'a-jgl']);
      const remembered: TmdbAuto = {
        v: 1,
        match: { title: 'Inception', year: 2010 },
        title: 'Inception',
        descriptionHash: descriptionHash(OVERVIEW),
        releaseYear: 2010,
        duration: 148,
        genre: 'Action',
        language: 'English',
        country: 'English',
        director: 'Christopher Nolan',
        ageRating: 'PG13',
        posterUrl: stored('movie', 'tmdb-poster.jpg'),
        posterPath: '/poster.jpg',
        coverUrl: stored('movie', 'tmdb-backdrop.jpg'),
        coverPath: '/backdrop.jpg',
        categoryIds: ['c-action', 'c-scifi', 'c-adventure'],
        actorIds: ['a-leo', 'a-jgl'],
      };
      expect(movie.tmdbAuto).toEqual(remembered);
    });

    it('never writes the status, Free or paid, the star rating, the Burmese text or the thumbnail', async () => {
      const before = haveMovie({
        descriptionMm: 'မြန်မာစာ',
        thumbnailUrl: stored('movie', 'thumb.jpg'),
        rating: 7.5,
        accessType: AccessType.FREE,
      });
      const untouched = copy(before);

      await automatic();

      const data = movieWrite();
      for (const column of NEVER_WRITTEN)
        expect(data).not.toHaveProperty(column);
      const movie = movieNow();
      for (const column of NEVER_WRITTEN) {
        expect(movie[column]).toEqual(untouched[column]);
      }
    });

    it('asks TMDB for the entry once and stores each picture through the image store, as a TMDB picture', async () => {
      haveMovie();

      await automatic();

      expect(client.movieDetails).toHaveBeenCalledTimes(1);
      expect(client.movieDetails).toHaveBeenCalledWith(INCEPTION);
      expect(images.fetch.mock.calls).toEqual(
        expect.arrayContaining([
          ['poster', '/poster.jpg', 10 * 1024 * 1024],
          ['backdrop', '/backdrop.jpg', 10 * 1024 * 1024],
        ]),
      );
      expect(images.fetch).toHaveBeenCalledTimes(2);
      expect(imageStore.save.mock.calls).toEqual(
        expect.arrayContaining([
          [
            'movie',
            'poster.jpg',
            Buffer.from('jpeg-bytes'),
            STAFF,
            { source: 'tmdb', sourceRef: '/poster.jpg' },
          ],
          [
            'movie',
            'backdrop.jpg',
            Buffer.from('jpeg-bytes'),
            STAFF,
            { source: 'tmdb', sourceRef: '/backdrop.jpg' },
          ],
        ]),
      );
      expect(cast.attach).toHaveBeenCalledWith([LEO, JGL], STAFF);
    });

    it('writes the row once, in one transaction, holding the row lock', async () => {
      haveMovie();

      await automatic();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [sql, id] = prisma.$queryRaw.mock.calls[0] as [string[], string];
      expect(sql.join('?')).toContain('FROM "movies"');
      expect(sql.join('?')).toContain('FOR UPDATE');
      expect(id).toBe(MOVIE_ID);
      expect(prisma.movie.update).toHaveBeenCalledTimes(1);
    });

    it('writes only untouched fields: what staff typed, uploaded or picked stays', async () => {
      haveMovie({
        title: 'Inception (our cut)',
        description: 'Our own words.',
        genre: 'Thriller',
        duration: 151,
        posterUrl: stored('movie', 'staff-upload.jpg'),
        categories: [CATEGORIES[5]],
        actors: [ACTORS[3]],
      });

      const result = await automatic();

      const data = movieWrite();
      expect(fieldKeys(data, MOVIE_BOOKKEEPING)).toEqual([
        'ageRating',
        'country',
        'coverUrl',
        'director',
        'language',
        'releaseYear',
      ]);
      expect(movieNow()).toEqual(
        expect.objectContaining({
          title: 'Inception (our cut)',
          description: 'Our own words.',
          genre: 'Thriller',
          duration: 151,
          posterUrl: stored('movie', 'staff-upload.jpg'),
          language: 'English',
          director: 'Christopher Nolan',
          tmdbStatus: TmdbLookupStatus.MATCHED,
        }),
      );
      expect(movieNow().categories.map((c: Row) => c.id)).toEqual(['c-staff']);
      expect(movieNow().actors.map((a: Row) => a.id)).toEqual(['a-staff']);
      // Nothing was fetched or created for a field that is staff's.
      expect(images.fetch).toHaveBeenCalledTimes(1);
      expect(images.fetch).toHaveBeenCalledWith(
        'backdrop',
        '/backdrop.jpg',
        expect.any(Number),
      );
      expect(cast.attach).not.toHaveBeenCalled();
      expect(result).toEqual({
        outcome: 'filled',
        report: expect.objectContaining({
          filled: [
            'releaseYear',
            'language',
            'country',
            'director',
            'ageRating',
            'cover',
          ],
          skipped: [
            { field: 'title', reason: 'hand' },
            { field: 'description', reason: 'hand' },
            { field: 'duration', reason: 'hand' },
            { field: 'genre', reason: 'hand' },
            { field: 'poster', reason: 'hand' },
            { field: 'categories', reason: 'hand' },
            { field: 'cast', reason: 'hand' },
          ],
        }),
      });
    });

    it('a runtime measured from the real file is never replaced', async () => {
      haveMovie({ duration: 151 });

      await automatic();

      expect(movieWrite()).not.toHaveProperty('duration');
      expect(movieNow().duration).toBe(151);
    });

    it('a row that predates the feature (no tmdbAuto) keeps its title and year', async () => {
      haveMovie({ title: 'inception', releaseYear: 2026, tmdbAuto: null });

      await automatic();

      const data = movieWrite();
      expect(data).not.toHaveProperty('title');
      expect(data).not.toHaveProperty('releaseYear');
      expect(movieNow().description).toBe(OVERVIEW);
    });

    it('where TMDB has no value, an empty field stays empty and is reported', async () => {
      haveMovie();
      client.movieDetails.mockResolvedValue({
        ok: true,
        data: inception({
          overview: '',
          runtime: null,
          genres: [{ id: 10752, name: 'War' }],
          originalLanguage: 'de',
          productionCountries: [],
          posterPath: null,
          backdropPath: null,
          cast: [],
          crew: [],
          usCertifications: [{ certification: 'NR', type: 3 }],
        }),
      });

      const result = await automatic();

      expect(fieldKeys(movieWrite(), MOVIE_BOOKKEEPING)).toEqual([
        'country',
        'releaseYear',
        'title',
      ]);
      expect(movieNow().country).toBe('Other');
      expect(result).toEqual({
        outcome: 'filled',
        report: {
          filled: ['title', 'releaseYear', 'country'],
          skipped: [
            { field: 'description', reason: 'no_value' },
            { field: 'duration', reason: 'no_value' },
            { field: 'genre', reason: 'no_value' },
            { field: 'language', reason: 'no_value' },
            { field: 'director', reason: 'no_value' },
            { field: 'ageRating', reason: 'no_value' },
            { field: 'poster', reason: 'no_value' },
            { field: 'cover', reason: 'no_value' },
            { field: 'categories', reason: 'no_value' },
            { field: 'cast', reason: 'no_value' },
          ],
          actors: { reused: 0, created: 0, skipped: [] },
          // "War" has no category of ours — none is created.
          categories: { added: [], unmatched: ['War'] },
        },
      });
      expect(images.fetch).not.toHaveBeenCalled();
      expect(cast.attach).not.toHaveBeenCalled();
    });

    it('a picture that fails is skipped and reported; the text is still saved', async () => {
      haveMovie();
      images.fetch.mockImplementation(async (kind: string) =>
        kind === 'poster'
          ? { ok: false, reason: 'not_found' }
          : { ok: true, buffer: Buffer.from('jpeg-bytes'), size: 'original' },
      );

      const result = await automatic();

      expect(movieNow()).toEqual(
        expect.objectContaining({
          description: OVERVIEW,
          posterUrl: null,
          coverUrl: stored('movie', 'tmdb-backdrop.jpg'),
        }),
      );
      expect(result).toEqual({
        outcome: 'filled',
        report: expect.objectContaining({
          filled: TMDB_MOVIE_FIELDS.filter((field) => field !== 'poster'),
          skipped: [{ field: 'poster', reason: 'image_failed' }],
        }),
      });
      expect(movieNow().tmdbAuto).not.toHaveProperty('posterUrl');
    });

    it('a download that is not an image (the store refuses it) is skipped the same way', async () => {
      haveMovie();
      imageStore.save.mockRejectedValue(
        new CodedHttpException(400, 'IMAGE_UPLOAD_UNSUPPORTED_TYPE', 'no'),
      );

      const result = await automatic();

      expect(result).toEqual({
        outcome: 'filled',
        report: expect.objectContaining({
          skipped: [
            { field: 'poster', reason: 'image_failed' },
            { field: 'cover', reason: 'image_failed' },
          ],
        }),
      });
      expect(movieNow().description).toBe(OVERVIEW);
      expect(movieNow().posterUrl).toBeNull();
    });

    it('when the cast cannot be attached to anyone, the rest is still filled', async () => {
      haveMovie();
      cast.attach.mockResolvedValue({
        actorIds: [],
        reused: 0,
        created: 0,
        skipped: [
          { name: 'Leonardo DiCaprio', reason: 'same_name' },
          { name: 'Joseph Gordon-Levitt', reason: 'no_permission' },
        ],
      });

      const result = await automatic();

      expect(movieWrite()).not.toHaveProperty('actors');
      expect(result).toEqual({
        outcome: 'filled',
        report: expect.objectContaining({
          filled: TMDB_MOVIE_FIELDS.filter((field) => field !== 'cast'),
          skipped: [{ field: 'cast', reason: 'no_value' }],
          actors: {
            reused: 0,
            created: 0,
            skipped: [
              { name: 'Leonardo DiCaprio', reason: 'same_name' },
              { name: 'Joseph Gordon-Levitt', reason: 'no_permission' },
            ],
          },
        }),
      });
    });

    it('does not set a category or an actor that was deleted a moment ago', async () => {
      haveMovie();
      cast.attach.mockImplementation(async () => {
        // Deleted between the fill reading them and writing the row.
        categories = categories.filter((c) => c.id !== 'c-scifi');
        actors = actors.filter((a) => a.id !== 'a-jgl');
        return {
          actorIds: ['a-leo', 'a-jgl'],
          reused: 1,
          created: 1,
          skipped: [],
        };
      });

      const result = await automatic();

      expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
        'c-action',
        'c-adventure',
      ]);
      expect(movieNow().actors.map((a: Row) => a.id)).toEqual(['a-leo']);
      expect(
        result.outcome === 'filled' && result.report.categories.added,
      ).toEqual(['Action', 'Adventure']);
    });

    describe('the audit row', () => {
      it("is one movie.update in the uploader's name, with snapshots and what was filled", async () => {
        const before = copy(haveMovie());

        await automatic('upload');

        expect(auditRows('movie.update')).toEqual([
          {
            action: 'movie.update',
            actor: STAFF,
            target: { type: 'movie', id: MOVIE_ID, label: 'Inception' },
            before: movieSnapshot(before),
            after: movieSnapshot(movieNow()),
            metadata: {
              via: 'tmdb',
              trigger: 'upload',
              tmdbId: INCEPTION,
              fields: [...TMDB_MOVIE_FIELDS],
            },
          },
        ]);
        expect(audit.record).toHaveBeenCalledTimes(1);
      });

      it('says "staff" when staff started the lookup', async () => {
        haveMovie();

        await automatic('staff');

        expect(auditRows('movie.update')[0].metadata).toEqual(
          expect.objectContaining({ via: 'tmdb', trigger: 'staff' }),
        );
      });

      it('is written after the row, never inside its transaction', async () => {
        haveMovie();
        const order: string[] = [];
        prisma.$transaction.mockImplementation(
          async (work: (tx: unknown) => Promise<unknown>) => {
            const result = await work(prisma);
            order.push('transaction over');
            return result;
          },
        );
        audit.record.mockImplementation(async () => {
          order.push('audit');
        });

        await automatic();

        expect(order).toEqual(['transaction over', 'audit']);
      });
    });

    describe('a refill of a movie that is already linked', () => {
      const linked = (overrides: Row = {}) =>
        haveMovie({
          title: 'Inception',
          description: 'An older overview.',
          genre: 'Drama',
          language: 'English',
          posterUrl: stored('movie', 'tmdb-old.jpg'),
          coverUrl: stored('movie', 'tmdb-backdrop.jpg'),
          categories: [CATEGORIES[3]],
          actors: [ACTORS[2]],
          tmdbId: 1,
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbAuto: {
            v: 1,
            match: { title: 'Old Match', year: 2009 },
            title: 'Inception',
            releaseYear: 2010,
            descriptionHash: descriptionHash('An older overview.'),
            genre: 'Drama',
            language: 'English',
            posterUrl: stored('movie', 'tmdb-old.jpg'),
            posterPath: '/old.jpg',
            coverUrl: stored('movie', 'tmdb-backdrop.jpg'),
            coverPath: '/backdrop.jpg',
            categoryIds: ['c-drama'],
            actorIds: ['a-old'],
          },
          ...overrides,
        });

      it('replaces what the previous match put there', async () => {
        linked();

        await automatic();

        expect(movieNow()).toEqual(
          expect.objectContaining({
            description: OVERVIEW,
            genre: 'Action',
            posterUrl: stored('movie', 'tmdb-poster.jpg'),
            tmdbId: INCEPTION,
          }),
        );
        expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
          'c-action',
          'c-scifi',
          'c-adventure',
        ]);
        expect(movieNow().actors.map((a: Row) => a.id)).toEqual([
          'a-leo',
          'a-jgl',
        ]);
        expect(movieNow().tmdbAuto.match).toEqual({
          title: 'Inception',
          year: 2010,
        });
      });

      it('deletes the TMDB picture that was replaced — after the row is written', async () => {
        linked();
        const order: string[] = [];
        prisma.movie.update.mockImplementationOnce(async (args: Row) => {
          order.push('row written');
          return table(movies).update(args as never);
        });
        minioService.deleteObject.mockImplementation(async (key: string) => {
          order.push(`deleted ${key}`);
        });

        await automatic();

        expect(order).toEqual([
          'row written',
          'deleted images/movie/tmdb-old.jpg',
        ]);
      });

      it('does not download a picture the row already shows', async () => {
        linked();

        const result = await automatic();

        // The banner is the same TMDB file: only the poster is fetched.
        expect(images.fetch).toHaveBeenCalledTimes(1);
        expect(images.fetch).toHaveBeenCalledWith(
          'poster',
          '/poster.jpg',
          expect.any(Number),
        );
        expect(movieNow().coverUrl).toBe(stored('movie', 'tmdb-backdrop.jpg'));
        expect(deletedKeys()).toEqual(['images/movie/tmdb-old.jpg']);
        expect(result.outcome === 'filled' && result.report.filled).toContain(
          'cover',
        );
      });

      it('takes back an automatic value TMDB no longer has, and its picture', async () => {
        linked();
        client.movieDetails.mockResolvedValue({
          ok: true,
          data: inception({ genres: [], posterPath: null, overview: '' }),
        });

        const result = await automatic();

        expect(movieNow()).toEqual(
          expect.objectContaining({
            description: '',
            genre: '',
            posterUrl: null,
          }),
        );
        expect(movieNow().categories).toEqual([]);
        expect(movieNow().tmdbAuto).not.toHaveProperty('genre');
        expect(movieNow().tmdbAuto).not.toHaveProperty('posterUrl');
        expect(movieNow().tmdbAuto).not.toHaveProperty('posterPath');
        expect(movieNow().tmdbAuto).not.toHaveProperty('categoryIds');
        expect(deletedKeys()).toEqual(['images/movie/tmdb-old.jpg']);
        expect(result.outcome === 'filled' && result.report.skipped).toEqual(
          expect.arrayContaining([
            { field: 'description', reason: 'no_value' },
            { field: 'genre', reason: 'no_value' },
            { field: 'poster', reason: 'no_value' },
            { field: 'categories', reason: 'no_value' },
          ]),
        );
      });

      it('leaves a list staff added to alone', async () => {
        linked({ categories: [CATEGORIES[3], CATEGORIES[5]] });

        await automatic();

        expect(movieWrite()).not.toHaveProperty('categories');
        expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
          'c-drama',
          'c-staff',
        ]);
      });
    });

    describe('when the title changes under the fill', () => {
      it('the movie was deleted before the fill read it: nothing is fetched or written', async () => {
        const result = await automatic();

        expect(result).toEqual({ outcome: 'gone' });
        expect(images.fetch).not.toHaveBeenCalled();
        expect(cast.attach).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('the movie was deleted while its pictures were fetched: nothing is written and the pictures are removed again', async () => {
        haveMovie();
        cast.attach.mockImplementation(async () => {
          movies.delete(MOVIE_ID);
          return { actorIds: ['a-leo'], reused: 1, created: 0, skipped: [] };
        });

        const result = await automatic();

        expect(result).toEqual({ outcome: 'gone' });
        expect(prisma.movie.update).not.toHaveBeenCalled();
        expect(deletedKeys().sort()).toEqual([
          'images/movie/tmdb-backdrop.jpg',
          'images/movie/tmdb-poster.jpg',
        ]);
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('gives way to what staff typed while the details were being fetched', async () => {
        haveMovie();
        cast.attach.mockImplementation(async () => {
          // Staff saved the Edit dialog in the meantime.
          Object.assign(movieNow(), {
            genre: 'Thriller',
            posterUrl: stored('movie', 'staff-upload.jpg'),
          });
          return {
            actorIds: ['a-leo', 'a-jgl'],
            reused: 1,
            created: 1,
            skipped: [],
          };
        });

        const result = await automatic();

        const data = movieWrite();
        expect(data).not.toHaveProperty('genre');
        expect(data).not.toHaveProperty('posterUrl');
        expect(movieNow()).toEqual(
          expect.objectContaining({
            genre: 'Thriller',
            posterUrl: stored('movie', 'staff-upload.jpg'),
            description: OVERVIEW,
          }),
        );
        expect(movieNow().tmdbAuto).not.toHaveProperty('genre');
        expect(movieNow().tmdbAuto).not.toHaveProperty('posterUrl');
        // The TMDB poster that was stored for nothing is removed; staff's stays.
        expect(deletedKeys()).toEqual(['images/movie/tmdb-poster.jpg']);
        expect(result).toEqual({
          outcome: 'filled',
          report: expect.objectContaining({
            filled: TMDB_MOVIE_FIELDS.filter(
              (field) => field !== 'genre' && field !== 'poster',
            ),
            skipped: [
              { field: 'genre', reason: 'hand' },
              { field: 'poster', reason: 'hand' },
            ],
          }),
        });
        expect(auditRows('movie.update')[0].metadata.fields).not.toContain(
          'genre',
        );
      });
    });

    describe('when something fails', () => {
      it.each(['unreachable', 'rate_limited', 'key_rejected', 'not_found'])(
        'TMDB answers %s for the details: reported as failed, nothing read or written',
        async (reason) => {
          haveMovie();
          client.movieDetails.mockResolvedValue({ ok: false, reason });

          await expect(automatic()).resolves.toEqual({
            outcome: 'failed',
            reason,
          });
          expect(prisma.movie.findUnique).not.toHaveBeenCalled();
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(images.fetch).not.toHaveBeenCalled();
        },
      );

      it('an error while attaching the cast rejects — and the pictures already stored are removed', async () => {
        haveMovie();
        cast.attach.mockRejectedValue(new Error('database went away'));

        await expect(automatic()).rejects.toThrow('database went away');

        expect(prisma.movie.update).not.toHaveBeenCalled();
        expect(deletedKeys().sort()).toEqual([
          'images/movie/tmdb-backdrop.jpg',
          'images/movie/tmdb-poster.jpg',
        ]);
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('an error while writing the row rejects — and the pictures stored for it are removed', async () => {
        haveMovie();
        prisma.movie.update.mockRejectedValue(new Error('deadlock'));

        await expect(automatic()).rejects.toThrow('deadlock');

        expect(deletedKeys().sort()).toEqual([
          'images/movie/tmdb-backdrop.jpg',
          'images/movie/tmdb-poster.jpg',
        ]);
        expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.PENDING);
      });

      it('a picture that cannot be deleted afterwards does not fail the fill', async () => {
        haveMovie({
          posterUrl: stored('movie', 'tmdb-old.jpg'),
          tmdbAuto: {
            v: 1,
            title: 'Inception',
            releaseYear: 2010,
            posterUrl: stored('movie', 'tmdb-old.jpg'),
            posterPath: '/old.jpg',
          },
        });
        minioService.deleteObject.mockRejectedValue(new Error('storage down'));

        await expect(automatic()).resolves.toEqual(
          expect.objectContaining({ outcome: 'filled' }),
        );
        expect(auditRows('movie.update')).toHaveLength(1);
      });
    });
  });

  // -------------------------------------------------------------------
  describe('applyMovie — Apply after the review', () => {
    const apply = (fields: TmdbField[], tmdbId = INCEPTION) =>
      service.applyMovie(MOVIE_ID, tmdbId, fields, STAFF);

    it('writes exactly the fields staff left switched on', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.NEEDS_PICK });

      const { movie, report } = await apply(['description', 'genre']);

      expect(fieldKeys(movieWrite(), MOVIE_BOOKKEEPING)).toEqual([
        'description',
        'genre',
      ]);
      expect(report).toEqual({
        filled: ['description', 'genre'],
        skipped: [],
        actors: { reused: 0, created: 0, skipped: [] },
        categories: { added: [], unmatched: [] },
      });
      expect(movie).toEqual(
        expect.objectContaining({
          id: MOVIE_ID,
          description: OVERVIEW,
          genre: 'Action',
          language: '',
          director: null,
          posterUrl: null,
          duration: 0,
          tmdbId: INCEPTION,
          tmdbStatus: TmdbLookupStatus.MATCHED,
        }),
      );
      // The relations MovieResponseDto reads are loaded.
      expect(movie.categories).toEqual([]);
      expect(movie.actors).toEqual([]);
      expect(movie.videos).toEqual([]);
      // Nothing was fetched for a line that was off.
      expect(images.fetch).not.toHaveBeenCalled();
      expect(cast.attach).not.toHaveBeenCalled();
      expect(prisma.category.findMany).not.toHaveBeenCalled();
    });

    it('with every line off it only links the movie', async () => {
      haveMovie({ tmdbStatus: TmdbLookupStatus.NOT_FOUND });

      const { report } = await apply([]);

      expect(fieldKeys(movieWrite(), MOVIE_BOOKKEEPING)).toEqual([]);
      expect(report.filled).toEqual([]);
      expect(movieNow()).toEqual(
        expect.objectContaining({
          tmdbId: INCEPTION,
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbError: null,
          description: '',
        }),
      );
      expect(movieNow().tmdbAuto.match).toEqual({
        title: 'Inception',
        year: 2010,
      });
    });

    it('replaces a detail staff changed by hand only because they switched it on', async () => {
      haveMovie({
        title: 'Inception (our cut)',
        description: 'Our own words.',
        genre: 'Thriller',
      });

      const { report } = await apply(['title', 'genre']);

      expect(movieNow()).toEqual(
        expect.objectContaining({
          title: 'Inception',
          genre: 'Action',
          // Not switched on: left exactly as staff wrote it.
          description: 'Our own words.',
        }),
      );
      expect(report.filled).toEqual(['title', 'genre']);
      expect(report.skipped).toEqual([]);
    });

    it('still never replaces a runtime that is not the automatic one', async () => {
      haveMovie({ duration: 151 });

      const { report } = await apply(['duration', 'genre']);

      expect(movieWrite()).not.toHaveProperty('duration');
      expect(report.filled).toEqual(['genre']);
      expect(report.skipped).toEqual([{ field: 'duration', reason: 'hand' }]);
    });

    it('never writes the status or anything else that is not a TMDB detail', async () => {
      haveMovie({ status: MovieStatus.PUBLISHED });

      await apply([...TMDB_MOVIE_FIELDS]);

      const data = movieWrite();
      for (const column of NEVER_WRITTEN)
        expect(data).not.toHaveProperty(column);
      expect(movieNow().status).toBe(MovieStatus.PUBLISHED);
    });

    it("a change of match swaps the automatic cast and categories and keeps staff's", async () => {
      haveMovie({
        tmdbId: 1,
        tmdbStatus: TmdbLookupStatus.MATCHED,
        categories: [CATEGORIES[3], CATEGORIES[5]],
        actors: [ACTORS[2], ACTORS[3]],
        tmdbAuto: {
          v: 1,
          match: { title: 'Old Match', year: 2009 },
          title: 'Inception',
          releaseYear: 2010,
          categoryIds: ['c-drama'],
          actorIds: ['a-old'],
        },
      });

      const { report } = await apply(['categories', 'cast']);

      expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
        'c-staff',
        'c-action',
        'c-scifi',
        'c-adventure',
      ]);
      expect(movieNow().actors.map((a: Row) => a.id)).toEqual([
        'a-staff',
        'a-leo',
        'a-jgl',
      ]);
      expect(movieNow().tmdbAuto).toEqual(
        expect.objectContaining({
          match: { title: 'Inception', year: 2010 },
          categoryIds: ['c-action', 'c-scifi', 'c-adventure'],
          actorIds: ['a-leo', 'a-jgl'],
        }),
      );
      expect(movieNow().tmdbId).toBe(INCEPTION);
      expect(report.categories.added).toEqual([
        'Action',
        'Sci-Fi',
        'Adventure',
      ]);
      expect(report.actors).toEqual({ reused: 1, created: 1, skipped: [] });
    });

    it('a TMDB picture that is replaced is deleted from storage', async () => {
      haveMovie({
        posterUrl: stored('movie', 'tmdb-old.jpg'),
        tmdbAuto: {
          v: 1,
          title: 'Inception',
          releaseYear: 2010,
          posterUrl: stored('movie', 'tmdb-old.jpg'),
          posterPath: '/old.jpg',
        },
      });

      await apply(['poster']);

      expect(movieNow().posterUrl).toBe(stored('movie', 'tmdb-poster.jpg'));
      expect(deletedKeys()).toEqual(['images/movie/tmdb-old.jpg']);
    });

    it('a picture staff uploaded is replaced when asked, and is not deleted', async () => {
      haveMovie({ posterUrl: stored('movie', 'staff-upload.jpg') });

      await apply(['poster']);

      expect(movieNow().posterUrl).toBe(stored('movie', 'tmdb-poster.jpg'));
      expect(minioService.deleteObject).not.toHaveBeenCalled();
    });

    it('records movie.update with trigger "staff" and the fields that were written', async () => {
      const before = copy(haveMovie());

      await apply(['description', 'poster']);

      expect(auditRows('movie.update')).toEqual([
        {
          action: 'movie.update',
          actor: STAFF,
          target: { type: 'movie', id: MOVIE_ID, label: 'Inception' },
          before: movieSnapshot(before),
          after: movieSnapshot(movieNow()),
          metadata: {
            via: 'tmdb',
            trigger: 'staff',
            tmdbId: INCEPTION,
            fields: ['description', 'poster'],
          },
        },
      ]);
    });

    it('a failed picture is reported and the rest is applied', async () => {
      haveMovie();
      images.fetch.mockResolvedValue({ ok: false, reason: 'too_large' });

      const { report } = await apply(['description', 'poster', 'cover']);

      expect(report.filled).toEqual(['description']);
      expect(report.skipped).toEqual([
        { field: 'poster', reason: 'image_failed' },
        { field: 'cover', reason: 'image_failed' },
      ]);
      expect(movieNow().description).toBe(OVERVIEW);
    });

    describe('a change of match to an entry that has less (PLAN 2.9)', () => {
      /**
       * A movie the automatic path linked to the WRONG film: every detail
       * below is what that match put there — except the genre, which staff
       * picked themselves, and the runtime, which was never filled.
       */
      const wronglyMatched = (overrides: Row = {}) =>
        haveMovie({
          description: 'The story of the wrong film.',
          genre: 'Thriller',
          language: 'English',
          country: 'English',
          director: 'Wrong Director',
          ageRating: 'R',
          posterUrl: stored('movie', 'tmdb-old.jpg'),
          coverUrl: stored('movie', 'tmdb-old-wide.jpg'),
          categories: [CATEGORIES[3]],
          actors: [ACTORS[2]],
          tmdbId: 1,
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbAuto: {
            v: 1,
            match: { title: 'Old Match', year: 2009 },
            title: 'Inception',
            releaseYear: 2010,
            descriptionHash: descriptionHash('The story of the wrong film.'),
            genre: 'Drama',
            language: 'English',
            country: 'English',
            director: 'Wrong Director',
            ageRating: 'R',
            posterUrl: stored('movie', 'tmdb-old.jpg'),
            posterPath: '/old.jpg',
            coverUrl: stored('movie', 'tmdb-old-wide.jpg'),
            coverPath: '/old-wide.jpg',
            categoryIds: ['c-drama'],
            actorIds: ['a-old'],
          },
          ...overrides,
        });

      /**
       * The right film as TMDB has it: a name, a year, a language — and no
       * story, director, US certificate, pictures, cast or genre of ours.
       * The review draws those lines as "TMDB has nothing", with no switch,
       * so Apply never names them.
       */
      const rightFilmHasLittle = (overrides: Partial<TmdbMovieDetails> = {}) =>
        client.movieDetails.mockResolvedValue({
          ok: true,
          data: inception({
            overview: '',
            genres: [{ id: 10752, name: 'War' }],
            posterPath: null,
            backdropPath: null,
            cast: [],
            crew: [],
            usCertifications: [],
            ...overrides,
          }),
        });

      it("takes back what the previous match put there, though no line named it — and keeps staff's own", async () => {
        const before = copy(wronglyMatched());
        rightFilmHasLittle();

        const { movie, report } = await apply(['title']);

        expect(fieldKeys(movieWrite(), MOVIE_BOOKKEEPING)).toEqual([
          'actors',
          'ageRating',
          'categories',
          'coverUrl',
          'description',
          'director',
          'posterUrl',
          'title',
        ]);
        expect(movieNow()).toEqual(
          expect.objectContaining({
            tmdbId: INCEPTION,
            // Back to their empty placeholders.
            description: '',
            director: null,
            ageRating: null,
            posterUrl: null,
            coverUrl: null,
            categories: [],
            actors: [],
            // Staff's own genre, and what this film does have, stay.
            genre: 'Thriller',
            language: 'English',
            country: 'English',
            duration: 0,
          }),
        );
        expect(movie.description).toBe('');
        // Nothing of the old match is remembered as automatic any more, so
        // nothing of it can be tagged "From TMDB".
        expect(movieNow().tmdbAuto).toEqual({
          v: 1,
          match: { title: 'Inception', year: 2010 },
          title: 'Inception',
          releaseYear: 2010,
          genre: 'Drama',
          language: 'English',
          country: 'English',
        });
        // The old match's pictures are removed from storage.
        expect(deletedKeys().sort()).toEqual([
          'images/movie/tmdb-old-wide.jpg',
          'images/movie/tmdb-old.jpg',
        ]);
        expect(report).toEqual({
          filled: ['title'],
          skipped: [
            { field: 'description', reason: 'no_value' },
            { field: 'director', reason: 'no_value' },
            { field: 'ageRating', reason: 'no_value' },
            { field: 'poster', reason: 'no_value' },
            { field: 'cover', reason: 'no_value' },
            { field: 'categories', reason: 'no_value' },
            { field: 'cast', reason: 'no_value' },
          ],
          actors: { reused: 0, created: 0, skipped: [] },
          categories: { added: [], unmatched: ['War'] },
        });
        // Nothing was fetched or created for a field TMDB has nothing for.
        expect(images.fetch).not.toHaveBeenCalled();
        expect(cast.attach).not.toHaveBeenCalled();
        expect(auditRows('movie.update')).toEqual([
          expect.objectContaining({
            before: movieSnapshot(before),
            after: movieSnapshot(movieNow()),
            metadata: expect.objectContaining({ fields: ['title'] }),
          }),
        ]);
      });

      it('leaves a line alone that staff switched off while TMDB had a value for it', async () => {
        const before = copy(wronglyMatched());

        // The usual, complete entry — and every line off.
        const { report } = await apply([]);

        expect(fieldKeys(movieWrite(), MOVIE_BOOKKEEPING)).toEqual([]);
        expect(movieNow()).toEqual(
          expect.objectContaining({
            description: before.description,
            director: 'Wrong Director',
            ageRating: 'R',
            posterUrl: before.posterUrl,
            coverUrl: before.coverUrl,
          }),
        );
        expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
          'c-drama',
        ]);
        expect(movieNow().actors.map((a: Row) => a.id)).toEqual(['a-old']);
        expect(report.skipped).toEqual([]);
        expect(minioService.deleteObject).not.toHaveBeenCalled();
      });

      it('never takes back what staff typed, nor a title or a year', async () => {
        wronglyMatched({
          description: 'Our own words.',
          director: 'Typed By Staff',
          posterUrl: stored('movie', 'staff-upload.jpg'),
          categories: [CATEGORIES[3], CATEGORIES[5]],
          actors: [ACTORS[3]],
        });
        rightFilmHasLittle({ title: '', releaseDate: '' });

        const { report } = await apply([]);

        expect(movieNow()).toEqual(
          expect.objectContaining({
            title: 'Inception',
            releaseYear: 2010,
            description: 'Our own words.',
            director: 'Typed By Staff',
            posterUrl: stored('movie', 'staff-upload.jpg'),
            // Still the old match's own: taken back.
            ageRating: null,
            coverUrl: null,
          }),
        );
        expect(movieNow().categories.map((c: Row) => c.id)).toEqual([
          'c-drama',
          'c-staff',
        ]);
        expect(movieNow().actors.map((a: Row) => a.id)).toEqual(['a-staff']);
        expect(report.skipped).toEqual([
          { field: 'ageRating', reason: 'no_value' },
          { field: 'cover', reason: 'no_value' },
        ]);
        expect(deletedKeys()).toEqual(['images/movie/tmdb-old-wide.jpg']);
      });

      it('a cast nobody of which can be attached is "nothing" too, as in the review', async () => {
        wronglyMatched();
        // TMDB lists someone, but they are a namesake of an actor of ours.
        cast.plan.mockResolvedValue([
          { person: LEO, action: 'skip_same_name', actor: null, link: false },
        ]);

        const { report } = await apply([]);

        expect(cast.plan).toHaveBeenCalledWith([LEO, JGL], STAFF);
        expect(movieNow().actors).toEqual([]);
        expect(movieNow().tmdbAuto).not.toHaveProperty('actorIds');
        expect(report.skipped).toEqual([{ field: 'cast', reason: 'no_value' }]);
        // Looked at only: nobody is linked, created or given a photo.
        expect(cast.attach).not.toHaveBeenCalled();
      });

      it('gives way to what staff typed while the pictures were being fetched', async () => {
        wronglyMatched();
        rightFilmHasLittle({ posterPath: '/poster.jpg' });
        images.fetch.mockImplementation(async () => {
          // Staff saved the Edit dialog in the meantime.
          movieNow().description = 'Typed meanwhile.';
          return {
            ok: true,
            buffer: Buffer.from('jpeg-bytes'),
            size: 'original',
          };
        });

        const { report } = await apply(['poster']);

        expect(movieWrite()).not.toHaveProperty('description');
        expect(movieNow()).toEqual(
          expect.objectContaining({
            description: 'Typed meanwhile.',
            posterUrl: stored('movie', 'tmdb-poster.jpg'),
            director: null,
          }),
        );
        expect(report.filled).toEqual(['poster']);
        expect(report.skipped).toEqual(
          expect.arrayContaining([
            { field: 'description', reason: 'hand' },
            { field: 'director', reason: 'no_value' },
          ]),
        );
        expect(report.skipped).not.toContainEqual({
          field: 'description',
          reason: 'no_value',
        });
      });

      it('a Refill of the same entry takes back a value TMDB no longer has', async () => {
        wronglyMatched({ tmdbId: INCEPTION });
        client.movieDetails.mockResolvedValue({
          ok: true,
          data: inception({ usCertifications: [] }),
        });

        const { report } = await apply(['description']);

        expect(movieNow()).toEqual(
          expect.objectContaining({ description: OVERVIEW, ageRating: null }),
        );
        expect(movieNow().tmdbAuto).not.toHaveProperty('ageRating');
        expect(report.filled).toEqual(['description']);
        expect(report.skipped).toEqual([
          { field: 'ageRating', reason: 'no_value' },
        ]);
      });
    });

    describe('refusals', () => {
      const refusal = async (attempt: Promise<unknown>) => {
        const error: unknown = await attempt.then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(CodedHttpException);
        const coded = error as CodedHttpException;
        return { status: coded.getStatus(), code: coded.code };
      };

      it('503 TMDB_NOT_CONFIGURED while the key is missing — TMDB and the database are not asked', async () => {
        haveMovie();
        client.isEnabled = false;

        await expect(refusal(apply(['genre']))).resolves.toEqual({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'TMDB_NOT_CONFIGURED',
        });
        await expect(
          refusal(service.previewMovie(MOVIE_ID, INCEPTION, STAFF)),
        ).resolves.toEqual({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'TMDB_NOT_CONFIGURED',
        });
        expect(client.movieDetails).not.toHaveBeenCalled();
        expect(prisma.movie.findUnique).not.toHaveBeenCalled();
      });

      it('404 for a movie that does not exist', async () => {
        await expect(apply(['genre'])).rejects.toThrow(NotFoundException);
        await expect(
          service.previewMovie(MOVIE_ID, INCEPTION, STAFF),
        ).rejects.toThrow(NotFoundException);
        expect(client.movieDetails).not.toHaveBeenCalled();
      });

      it('400 TMDB_NOT_A_MOVIE for an episode — episodes are not filled', async () => {
        haveMovie({ seriesId: SERIES_ID, seasonNumber: 1, episodeNumber: 3 });

        await expect(refusal(apply(['genre']))).resolves.toEqual({
          status: HttpStatus.BAD_REQUEST,
          code: 'TMDB_NOT_A_MOVIE',
        });
        await expect(
          refusal(service.previewMovie(MOVIE_ID, INCEPTION, STAFF)),
        ).resolves.toEqual({
          status: HttpStatus.BAD_REQUEST,
          code: 'TMDB_NOT_A_MOVIE',
        });
        expect(client.movieDetails).not.toHaveBeenCalled();
        expect(prisma.movie.update).not.toHaveBeenCalled();
      });

      it.each([
        ['not_found', HttpStatus.NOT_FOUND, 'TMDB_TITLE_NOT_FOUND'],
        ['unreachable', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
        ['bad_response', HttpStatus.BAD_GATEWAY, 'TMDB_UNREACHABLE'],
        ['key_rejected', HttpStatus.BAD_GATEWAY, 'TMDB_KEY_REJECTED'],
        ['rate_limited', HttpStatus.SERVICE_UNAVAILABLE, 'TMDB_RATE_LIMITED'],
      ])(
        'TMDB answers %s: %i %s, and nothing is written',
        async (reason, status, code) => {
          haveMovie();
          client.movieDetails.mockResolvedValue({ ok: false, reason });

          await expect(refusal(apply(['genre']))).resolves.toEqual({
            status,
            code,
          });
          await expect(
            refusal(service.previewMovie(MOVIE_ID, INCEPTION, STAFF)),
          ).resolves.toEqual({ status, code });
          expect(prisma.movie.update).not.toHaveBeenCalled();
        },
      );

      it('409 TMDB_BUSY while another run holds the movie, and lets go of it afterwards', async () => {
        haveMovie();
        let answer: (value: unknown) => void = () => undefined;
        client.movieDetails.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = resolve;
          }),
        );

        const first = apply(['genre']);
        await expect(refusal(apply(['description']))).resolves.toEqual({
          status: HttpStatus.CONFLICT,
          code: 'TMDB_BUSY',
        });
        answer({ ok: true, data: inception() });
        await first;

        expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
        await expect(apply(['description'])).resolves.toBeDefined();
      });

      it('409 TMDB_BUSY while the automatic lookup is running for it', async () => {
        haveMovie();
        runs.tryStart(movieRunKey(MOVIE_ID));

        await expect(refusal(apply(['genre']))).resolves.toEqual({
          status: HttpStatus.CONFLICT,
          code: 'TMDB_BUSY',
        });
        expect(client.movieDetails).not.toHaveBeenCalled();
      });

      it('lets go of the movie when the apply fails', async () => {
        haveMovie();
        client.movieDetails.mockResolvedValueOnce({
          ok: false,
          reason: 'unreachable',
        });

        await expect(apply(['genre'])).rejects.toBeInstanceOf(
          CodedHttpException,
        );

        expect(runs.isRunning(movieRunKey(MOVIE_ID))).toBe(false);
      });

      it('404 when the movie is deleted while the apply runs', async () => {
        haveMovie();
        images.fetch.mockImplementation(async () => {
          movies.delete(MOVIE_ID);
          return { ok: true, buffer: Buffer.from('x'), size: 'original' };
        });

        await expect(apply(['poster'])).rejects.toThrow(NotFoundException);
        expect(deletedKeys()).toEqual(['images/movie/tmdb-poster.jpg']);
      });
    });
  });

  // -------------------------------------------------------------------
  describe('previewMovie — the review', () => {
    const preview = () => service.previewMovie(MOVIE_ID, INCEPTION, STAFF);
    const lineOf = (lines: TmdbPreviewLine[], field: TmdbField) =>
      lines.find((line) => line.field === field) as TmdbPreviewLine;

    it('writes nothing, downloads nothing, creates nobody and records nothing', async () => {
      haveMovie();

      await preview();

      expect(prisma.movie.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(images.fetch).not.toHaveBeenCalled();
      expect(imageStore.save).not.toHaveBeenCalled();
      expect(cast.attach).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(minioService.deleteObject).not.toHaveBeenCalled();
      expect(cast.plan).toHaveBeenCalledWith([LEO, JGL], STAFF);
    });

    it('a fresh upload: one line per detail, the empty ones switched on', async () => {
      haveMovie();

      const review = await preview();

      expect(review.tmdbId).toBe(INCEPTION);
      expect(review.match).toEqual({ title: 'Inception', year: 2010 });
      expect(review.fields).toEqual([
        {
          field: 'title',
          current: 'Inception',
          proposed: 'Inception',
          state: 'same',
          defaultOn: false,
        },
        {
          field: 'description',
          current: null,
          proposed: OVERVIEW,
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'releaseYear',
          current: 2010,
          proposed: 2010,
          state: 'same',
          defaultOn: false,
        },
        {
          field: 'duration',
          current: null,
          proposed: 148,
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'genre',
          current: null,
          proposed: 'Action',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'language',
          current: null,
          proposed: 'English',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'country',
          current: null,
          proposed: 'English',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'director',
          current: null,
          proposed: 'Christopher Nolan',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'ageRating',
          current: null,
          proposed: 'PG13',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'poster',
          current: null,
          // Shown to staff straight from TMDB; never stored for a preview.
          proposed: 'https://image.tmdb.org/t/p/w342/poster.jpg',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'cover',
          current: null,
          proposed: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'categories',
          current: [],
          proposed: ['Action', 'Sci-Fi', 'Adventure'],
          state: 'empty',
          defaultOn: true,
        },
        {
          field: 'cast',
          current: [],
          proposed: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt'],
          state: 'empty',
          defaultOn: true,
        },
      ]);
    });

    it('says what would happen to each person of the cast, and which categories would be connected', async () => {
      haveMovie({ categories: [CATEGORIES[0]] });
      client.movieDetails.mockResolvedValue({
        ok: true,
        data: inception({
          genres: [
            { id: 28, name: 'Action' },
            { id: 878, name: 'Science Fiction' },
            { id: 10752, name: 'War' },
          ],
        }),
      });
      cast.plan.mockResolvedValue([
        { person: LEO, action: 'reuse', actor: { ...ACTORS[0] }, link: true },
        { person: JGL, action: 'create', actor: null, link: false },
        {
          person: { tmdbPersonId: 3, name: 'Name Sake', profilePath: null },
          action: 'skip_same_name',
          actor: null,
          link: false,
        },
        {
          person: { tmdbPersonId: 4, name: 'No Right', profilePath: '/n.jpg' },
          action: 'skip_no_permission',
          actor: null,
          link: false,
        },
      ]);

      const review = await preview();

      expect(review.cast).toEqual([
        {
          name: 'Leonardo DiCaprio',
          tmdbPersonId: 6193,
          action: 'reuse',
          actorId: 'a-leo',
          hasPhoto: true,
        },
        {
          name: 'Joseph Gordon-Levitt',
          tmdbPersonId: 24045,
          action: 'create',
          actorId: null,
          hasPhoto: false,
        },
        {
          name: 'Name Sake',
          tmdbPersonId: 3,
          action: 'skip_same_name',
          actorId: null,
          hasPhoto: false,
        },
        {
          name: 'No Right',
          tmdbPersonId: 4,
          action: 'skip_no_permission',
          actorId: null,
          hasPhoto: true,
        },
      ]);
      // "Action" is on the movie already; "War" has no category of ours.
      expect(review.categories).toEqual({
        add: [{ id: 'c-scifi', name: 'Sci-Fi' }],
        unmatched: ['War'],
      });
      // Only the people who would really be attached are proposed.
      expect(lineOf(review.fields, 'cast').proposed).toEqual([
        'Leonardo DiCaprio',
        'Joseph Gordon-Levitt',
      ]);
    });

    it('tells apart: still automatic, changed by staff, already the same, and nothing on TMDB', async () => {
      haveMovie({
        title: 'Inception (our cut)',
        description: 'An older overview.',
        genre: 'Action',
        language: 'Burmese',
        director: 'Old Director',
        posterUrl: stored('movie', 'tmdb-poster.jpg'),
        coverUrl: stored('movie', 'staff-wide.jpg'),
        categories: [CATEGORIES[0], CATEGORIES[1], CATEGORIES[2]],
        actors: [ACTORS[0]],
        tmdbId: INCEPTION,
        tmdbStatus: TmdbLookupStatus.MATCHED,
        tmdbAuto: {
          v: 1,
          title: 'Inception',
          releaseYear: 2010,
          descriptionHash: descriptionHash('An older overview.'),
          genre: 'Action',
          language: 'English',
          director: 'Old Director',
          posterUrl: stored('movie', 'tmdb-poster.jpg'),
          posterPath: '/poster.jpg',
          categoryIds: ['c-action', 'c-scifi', 'c-adventure'],
          actorIds: ['a-leo'],
        },
      });
      client.movieDetails.mockResolvedValue({
        ok: true,
        data: inception({ usCertifications: [], runtime: null }),
      });
      cast.plan.mockResolvedValue([
        { person: LEO, action: 'reuse', actor: { ...ACTORS[0] }, link: false },
      ]);

      const { fields } = await preview();

      const stateOf = (field: TmdbField) => {
        const { state, defaultOn } = lineOf(fields, field);
        return [state, defaultOn];
      };
      // Staff renamed it.
      expect(stateOf('title')).toEqual(['hand', false]);
      // Still the previous automatic text; TMDB has a newer one.
      expect(stateOf('description')).toEqual(['auto', true]);
      // Still automatic and already what TMDB has.
      expect(stateOf('genre')).toEqual(['same', false]);
      // Staff picked another language.
      expect(stateOf('language')).toEqual(['hand', false]);
      expect(stateOf('director')).toEqual(['auto', true]);
      // TMDB has no rating and no runtime for it.
      expect(stateOf('ageRating')).toEqual(['none', false]);
      expect(stateOf('duration')).toEqual(['none', false]);
      // The very TMDB file the row already shows.
      expect(stateOf('poster')).toEqual(['same', false]);
      // Staff uploaded their own banner.
      expect(stateOf('cover')).toEqual(['hand', false]);
      expect(stateOf('categories')).toEqual(['same', false]);
      expect(stateOf('cast')).toEqual(['same', false]);

      // Pictures: ours re-hosted for this request, TMDB's as a preview address.
      expect(lineOf(fields, 'cover')).toEqual(
        expect.objectContaining({
          current: 'http://request.host/movies/images/movie/staff-wide.jpg',
          proposed: 'https://image.tmdb.org/t/p/w780/backdrop.jpg',
        }),
      );
      expect(lineOf(fields, 'categories').current).toEqual([
        'Action',
        'Sci-Fi',
        'Adventure',
      ]);
    });

    it('someone still to create means the cast is not "already the same"', async () => {
      haveMovie({
        actors: [ACTORS[0]],
        tmdbAuto: {
          v: 1,
          title: 'Inception',
          releaseYear: 2010,
          actorIds: ['a-leo'],
        },
      });

      const { fields } = await preview();

      expect(lineOf(fields, 'cast')).toEqual(
        expect.objectContaining({ state: 'auto', defaultOn: true }),
      );
    });

    it('shows the title as it is now, read again after TMDB answered', async () => {
      haveMovie();
      client.movieDetails.mockImplementation(async () => {
        movieNow().genre = 'Comedy';
        return { ok: true, data: inception() };
      });

      const { fields } = await preview();

      expect(lineOf(fields, 'genre')).toEqual(
        expect.objectContaining({ current: 'Comedy', state: 'hand' }),
      );
    });
  });

  // -------------------------------------------------------------------
  describe('series', () => {
    it('previewSeries has the ten series lines — no runtime, director or age rating', async () => {
      haveSeries();
      cast.plan.mockResolvedValue([
        { person: LEO, action: 'reuse', actor: { ...ACTORS[0] }, link: false },
      ]);

      const review = await service.previewSeries(
        SERIES_ID,
        STRANGER_THINGS,
        STAFF,
      );

      expect(client.tvDetails).toHaveBeenCalledWith(STRANGER_THINGS);
      expect(review.match).toEqual({ title: 'Stranger Things', year: 2016 });
      expect(review.fields.map((line) => line.field)).toEqual([
        ...TMDB_SERIES_FIELDS,
      ]);
      expect(review.fields.map((line) => [line.field, line.state])).toEqual([
        // A hand-made show: what staff typed is theirs.
        ['title', 'same'],
        ['description', 'hand'],
        ['releaseYear', 'same'],
        ['genre', 'hand'],
        ['language', 'same'],
        ['country', 'empty'],
        ['poster', 'empty'],
        ['cover', 'empty'],
        ['categories', 'empty'],
        ['cast', 'empty'],
      ]);
      expect(prisma.series.update).not.toHaveBeenCalled();
      expect(images.fetch).not.toHaveBeenCalled();
    });

    it('applySeries writes the series columns only, stores pictures under images/series, and links the show', async () => {
      const before = copy(haveSeries());

      const { series, report } = await service.applySeries(
        SERIES_ID,
        STRANGER_THINGS,
        ['description', 'country', 'poster', 'cover', 'categories', 'cast'],
        STAFF,
      );

      const data = seriesWrite();
      expect(fieldKeys(data, SERIES_BOOKKEEPING)).toEqual([
        'actors',
        'categories',
        'country',
        'coverUrl',
        'description',
        'posterUrl',
      ]);
      // A series has no lookup status and none of the movie-only columns.
      for (const column of [
        'tmdbStatus',
        'tmdbError',
        'duration',
        'director',
        'ageRating',
        'status',
        'accessType',
        'rating',
        'descriptionMm',
      ]) {
        expect(data).not.toHaveProperty(column);
      }
      expect(series).toEqual(
        expect.objectContaining({
          id: SERIES_ID,
          title: 'Stranger Things',
          description: 'A boy vanishes and a town uncovers a mystery.',
          genre: 'Drama',
          country: 'English',
          posterUrl: stored('series', 'tmdb-st.jpg'),
          coverUrl: stored('series', 'tmdb-st-wide.jpg'),
          status: SeriesStatus.DRAFT,
          tmdbId: STRANGER_THINGS,
          tmdbFetchedAt: expect.any(Date),
        }),
      );
      expect(series.categories.map((c) => c.id)).toEqual([
        'c-scifi',
        'c-mystery',
      ]);
      expect(series.actors.map((a) => a.id)).toEqual(['a-leo', 'a-jgl']);
      expect(report).toEqual({
        filled: [
          'description',
          'country',
          'poster',
          'cover',
          'categories',
          'cast',
        ],
        skipped: [],
        actors: { reused: 1, created: 1, skipped: [] },
        // "Fantasy" was offered too and has no category of ours.
        categories: { added: ['Sci-Fi', 'Mystery'], unmatched: ['Fantasy'] },
      });
      expect(images.fetch).toHaveBeenCalledWith(
        'poster',
        '/st.jpg',
        10 * 1024 * 1024,
      );
      const [sql] = prisma.$queryRaw.mock.calls[0] as [string[]];
      expect(sql.join('?')).toContain('FROM "series"');
      expect(auditRows('series.update')).toEqual([
        {
          action: 'series.update',
          actor: STAFF,
          target: { type: 'series', id: SERIES_ID, label: 'Stranger Things' },
          before: seriesSnapshot(before),
          after: seriesSnapshot(seriesNow()),
          metadata: {
            via: 'tmdb',
            trigger: 'staff',
            tmdbId: STRANGER_THINGS,
            fields: [
              'description',
              'country',
              'poster',
              'cover',
              'categories',
              'cast',
            ],
          },
        },
      ]);
    });

    it('applySeries ignores a movie-only field it is handed', async () => {
      haveSeries();

      const { report } = await service.applySeries(
        SERIES_ID,
        STRANGER_THINGS,
        ['duration', 'director', 'ageRating', 'country'] as TmdbField[],
        STAFF,
      );

      expect(fieldKeys(seriesWrite(), SERIES_BOOKKEEPING)).toEqual(['country']);
      expect(report.filled).toEqual(['country']);
      expect(report.skipped).toEqual([]);
    });

    it('applySeries to another show takes back what the previous match put there and this one lacks', async () => {
      // Linked to the wrong show; staff then typed the language themselves.
      haveSeries({
        description: 'The story of the wrong show.',
        genre: 'Drama',
        language: 'Korean',
        posterUrl: stored('series', 'tmdb-old.jpg'),
        categories: [CATEGORIES[3]],
        actors: [ACTORS[2]],
        tmdbId: 1,
        tmdbAuto: {
          v: 1,
          match: { title: 'Old Show', year: 2015 },
          title: 'Stranger Things',
          releaseYear: 2016,
          descriptionHash: descriptionHash('The story of the wrong show.'),
          genre: 'Drama',
          language: 'English',
          posterUrl: stored('series', 'tmdb-old.jpg'),
          posterPath: '/old.jpg',
          categoryIds: ['c-drama'],
          actorIds: ['a-old'],
        },
      });
      // The right show, as TMDB has it: no story, genre, poster or cast.
      client.tvDetails.mockResolvedValue({
        ok: true,
        data: strangerThings({
          overview: '',
          genres: [],
          posterPath: null,
          cast: [],
        }),
      });

      // The lines with a switch: the empty type word and banner.
      const { series, report } = await service.applySeries(
        SERIES_ID,
        STRANGER_THINGS,
        ['country', 'cover'],
        STAFF,
      );

      expect(fieldKeys(seriesWrite(), SERIES_BOOKKEEPING)).toEqual([
        'actors',
        'categories',
        'country',
        'coverUrl',
        'description',
        'genre',
        'posterUrl',
      ]);
      expect(series).toEqual(
        expect.objectContaining({
          tmdbId: STRANGER_THINGS,
          description: '',
          genre: '',
          posterUrl: null,
          categories: [],
          actors: [],
          // Staff's own word stays; what was asked for is written.
          language: 'Korean',
          country: 'English',
          coverUrl: stored('series', 'tmdb-st-wide.jpg'),
        }),
      );
      expect(seriesNow().tmdbAuto).toEqual({
        v: 1,
        match: { title: 'Stranger Things', year: 2016 },
        title: 'Stranger Things',
        releaseYear: 2016,
        language: 'English',
        country: 'English',
        coverUrl: stored('series', 'tmdb-st-wide.jpg'),
        coverPath: '/st-wide.jpg',
      });
      expect(deletedKeys()).toEqual(['images/series/tmdb-old.jpg']);
      expect(report).toEqual({
        filled: ['country', 'cover'],
        skipped: [
          { field: 'description', reason: 'no_value' },
          { field: 'genre', reason: 'no_value' },
          { field: 'poster', reason: 'no_value' },
          { field: 'categories', reason: 'no_value' },
          { field: 'cast', reason: 'no_value' },
        ],
        actors: { reused: 0, created: 0, skipped: [] },
        categories: { added: [], unmatched: [] },
      });
      expect(cast.attach).not.toHaveBeenCalled();
    });

    it('applySeries: 404 for an unknown series, 503 without a key, 409 while a run holds it', async () => {
      await expect(
        service.applySeries(SERIES_ID, STRANGER_THINGS, ['genre'], STAFF),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.previewSeries(SERIES_ID, STRANGER_THINGS, STAFF),
      ).rejects.toThrow(NotFoundException);

      haveSeries();
      runs.tryStart(`series:${SERIES_ID}`);
      await expect(
        service.applySeries(SERIES_ID, STRANGER_THINGS, ['genre'], STAFF),
      ).rejects.toMatchObject({ code: 'TMDB_BUSY' });
      runs.finish(`series:${SERIES_ID}`);

      client.isEnabled = false;
      await expect(
        service.applySeries(SERIES_ID, STRANGER_THINGS, ['genre'], STAFF),
      ).rejects.toMatchObject({ code: 'TMDB_NOT_CONFIGURED' });
      await expect(
        service.previewSeries(SERIES_ID, STRANGER_THINGS, STAFF),
      ).rejects.toMatchObject({ code: 'TMDB_NOT_CONFIGURED' });
      await expect(
        service.createSeries(STRANGER_THINGS, STAFF),
      ).rejects.toMatchObject({ code: 'TMDB_NOT_CONFIGURED' });
      expect(prisma.series.update).not.toHaveBeenCalled();
      expect(prisma.series.create).not.toHaveBeenCalled();
    });

    describe('createSeries — "Find on TMDB" for a new show', () => {
      const create = () => service.createSeries(STRANGER_THINGS, STAFF);

      it('creates the show as a draft from TMDB, then adds pictures, categories and cast', async () => {
        const { series, report } = await create();

        const { data } = prisma.series.create.mock.calls[0][0] as { data: Row };
        expect(data).toEqual({
          title: 'Stranger Things',
          description: 'A boy vanishes and a town uncovers a mystery.',
          genre: 'Sci-Fi',
          language: 'English',
          country: 'English',
          releaseYear: 2016,
          tmdbId: STRANGER_THINGS,
          tmdbFetchedAt: expect.any(Date),
          tmdbAuto: {
            v: 1,
            match: { title: 'Stranger Things', year: 2016 },
            title: 'Stranger Things',
            releaseYear: 2016,
            descriptionHash: descriptionHash(
              'A boy vanishes and a town uncovers a mystery.',
            ),
            genre: 'Sci-Fi',
            language: 'English',
            country: 'English',
          },
        });
        // Not published, not priced: both are left to the column defaults.
        expect(data).not.toHaveProperty('status');
        expect(data).not.toHaveProperty('accessType');

        expect(series).toEqual(
          expect.objectContaining({
            id: 'series-new',
            status: SeriesStatus.DRAFT,
            title: 'Stranger Things',
            posterUrl: stored('series', 'tmdb-st.jpg'),
            coverUrl: stored('series', 'tmdb-st-wide.jpg'),
            tmdbId: STRANGER_THINGS,
          }),
        );
        expect(series.categories.map((c) => c.id)).toEqual([
          'c-scifi',
          'c-mystery',
        ]);
        expect(series.actors.map((a) => a.id)).toEqual(['a-leo', 'a-jgl']);
        expect(seriesNow('series-new').tmdbAuto).toEqual(
          expect.objectContaining({
            posterPath: '/st.jpg',
            coverPath: '/st-wide.jpg',
            categoryIds: ['c-scifi', 'c-mystery'],
            actorIds: ['a-leo', 'a-jgl'],
          }),
        );
        expect(report).toEqual({
          filled: [...TMDB_SERIES_FIELDS],
          skipped: [],
          actors: { reused: 1, created: 1, skipped: [] },
          categories: { added: ['Sci-Fi', 'Mystery'], unmatched: ['Fantasy'] },
        });
      });

      it('fetches the details first: when TMDB cannot be read nothing is created', async () => {
        client.tvDetails.mockResolvedValue({ ok: false, reason: 'not_found' });

        await expect(create()).rejects.toMatchObject({
          code: 'TMDB_TITLE_NOT_FOUND',
        });

        expect(prisma.series.create).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('409 TMDB_SERIES_EXISTS, naming our series, when one is already linked to that show', async () => {
        haveSeries({ tmdbId: STRANGER_THINGS });

        const error: unknown = await create().then(
          () => null,
          (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(CodedHttpException);
        const coded = error as CodedHttpException;
        expect(coded.getStatus()).toBe(HttpStatus.CONFLICT);
        expect(coded.code).toBe('TMDB_SERIES_EXISTS');
        expect(coded.extra).toEqual({ seriesId: SERIES_ID });
        expect(coded.getResponse()).toEqual(
          expect.objectContaining({
            code: 'TMDB_SERIES_EXISTS',
            seriesId: SERIES_ID,
          }),
        );
        expect(client.tvDetails).not.toHaveBeenCalled();
        expect(prisma.series.create).not.toHaveBeenCalled();
      });

      it('records one series.create with the finished show — and no series.update', async () => {
        await create();

        expect(auditRows('series.create')).toEqual([
          {
            action: 'series.create',
            actor: STAFF,
            target: {
              type: 'series',
              id: 'series-new',
              label: 'Stranger Things',
            },
            after: seriesSnapshot(seriesNow('series-new')),
            metadata: { via: 'tmdb', tmdbId: STRANGER_THINGS },
          },
        ]);
        expect(auditRows('series.update')).toEqual([]);
        expect(audit.record).toHaveBeenCalledTimes(1);
      });

      it('where TMDB gave nothing: empty text, this year, and the report says so', async () => {
        client.tvDetails.mockResolvedValue({
          ok: true,
          data: strangerThings({
            overview: '',
            firstAirDate: '',
            genres: [],
            originalLanguage: null,
            originCountries: [],
            posterPath: null,
            backdropPath: null,
            cast: [],
          }),
        });

        const { series, report } = await create();

        const { data } = prisma.series.create.mock.calls[0][0] as { data: Row };
        expect(data).toEqual(
          expect.objectContaining({
            title: 'Stranger Things',
            description: '',
            genre: '',
            language: '',
            country: null,
            releaseYear: new Date().getFullYear(),
          }),
        );
        // The stand-in year is remembered as automatic, so a Refill can fix it.
        expect(data.tmdbAuto).toEqual({
          v: 1,
          match: { title: 'Stranger Things', year: null },
          title: 'Stranger Things',
          releaseYear: new Date().getFullYear(),
        });
        expect(series.status).toBe(SeriesStatus.DRAFT);
        expect(report.filled).toEqual(['title']);
        expect(report.skipped).toEqual(
          TMDB_SERIES_FIELDS.filter((field) => field !== 'title').map(
            (field) => ({ field, reason: 'no_value' }),
          ),
        );
      });

      it('a picture or cast failure never undoes the show', async () => {
        cast.attach.mockRejectedValue(new Error('database went away'));

        const { series, report } = await create();

        expect(shows.has('series-new')).toBe(true);
        expect(series).toEqual(
          expect.objectContaining({
            id: 'series-new',
            title: 'Stranger Things',
            posterUrl: null,
          }),
        );
        expect(report.filled).toEqual([
          'title',
          'description',
          'releaseYear',
          'genre',
          'language',
          'country',
        ]);
        expect(auditRows('series.create')).toHaveLength(1);
        // The pictures stored before the failure are not left behind.
        expect(deletedKeys().sort()).toEqual([
          'images/series/tmdb-st-wide.jpg',
          'images/series/tmdb-st.jpg',
        ]);
      });

      it('a failed picture is reported and the show still gets the rest', async () => {
        images.fetch.mockResolvedValue({ ok: false, reason: 'unreachable' });

        const { series, report } = await create();

        expect(series.posterUrl).toBeNull();
        expect(series.actors).toHaveLength(2);
        expect(report.skipped).toEqual([
          { field: 'poster', reason: 'image_failed' },
          { field: 'cover', reason: 'image_failed' },
        ]);
      });

      it('a show TMDB has no name for is refused', async () => {
        client.tvDetails.mockResolvedValue({
          ok: true,
          data: strangerThings({ title: '', originalTitle: '' }),
        });

        await expect(create()).rejects.toMatchObject({
          code: 'TMDB_UNREACHABLE',
        });
        expect(prisma.series.create).not.toHaveBeenCalled();
      });

      it('two clicks at once make one show: the second is told it is busy', async () => {
        let answer: (value: unknown) => void = () => undefined;
        client.tvDetails.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = resolve;
          }),
        );

        const first = create();
        await expect(create()).rejects.toMatchObject({ code: 'TMDB_BUSY' });
        answer({ ok: true, data: strangerThings() });
        await first;

        expect(prisma.series.create).toHaveBeenCalledTimes(1);
        // And once it exists, a third click is told so.
        await expect(create()).rejects.toMatchObject({
          code: 'TMDB_SERIES_EXISTS',
        });
      });
    });
  });
});
