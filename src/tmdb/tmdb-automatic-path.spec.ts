import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import {
  AccessType,
  MovieStatus,
  Role,
  TmdbLookupStatus,
} from '../generated/prisma/client';
import { ImageStoreService } from '../images/image-store.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { TmdbCastService } from './tmdb-cast.service';
import type { TmdbFetch, TmdbFetchResponse } from './tmdb-fetch';
import { TmdbFillService } from './tmdb-fill.service';
import {
  TMDB_IMAGE_FETCHER_OPTIONS,
  TmdbImageFetcher,
} from './tmdb-image.fetcher';
import { TmdbLookupService } from './tmdb-lookup.service';
import { TmdbRunRegistry } from './tmdb-runs';
import { TMDB_CLIENT_OPTIONS, TmdbClient } from './tmdb.client';

/**
 * The automatic path end to end — a finished folder upload, the search,
 * the one-clear-match rule, the details, the pictures and the cast — with
 * the REAL client, image fetcher, cast, fill and lookup services wired the
 * way TmdbModule wires them. Only the outside world is faked: `fetch` (so
 * nothing reaches TMDB), the database (a few tables in memory) and the
 * object storage. The unit specs prove each rule; this one proves the
 * pieces fit.
 */

type Row = Record<string, any>;

const STAFF = {
  id: 'staff-1',
  username: 'uploader',
  role: Role.CONTENT_UPLOADER,
  appRoleId: null,
} as unknown as AuthenticatedUser;

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
/** Made up: it opens nothing. */
const READ_TOKEN = 'made-up-read-access-token';
const WHEN = new Date('2026-11-06T09:00:00Z');

const SEARCH_PAGE = {
  page: 1,
  results: [
    {
      id: 27205,
      title: 'Inception',
      original_title: 'Inception',
      release_date: '2010-07-15',
      overview: 'A thief.',
      poster_path: '/poster.jpg',
      original_language: 'en',
    },
    {
      id: 64956,
      title: 'Inception: The Cobol Job',
      original_title: 'Inception: The Cobol Job',
      release_date: '2010-12-07',
      overview: 'A prequel.',
      poster_path: null,
      original_language: 'en',
    },
  ],
};

const DETAILS = {
  id: 27205,
  title: 'Inception',
  original_title: 'Inception',
  overview: 'A thief who steals corporate secrets through dreams.',
  release_date: '2010-07-15',
  runtime: 148,
  genres: [
    { id: 28, name: 'Action' },
    { id: 878, name: 'Science Fiction' },
  ],
  original_language: 'en',
  production_countries: [{ iso_3166_1: 'US', name: 'United States' }],
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  credits: {
    cast: [
      {
        id: 6193,
        name: 'Leonardo DiCaprio',
        character: 'Cobb',
        order: 0,
        profile_path: '/leo.jpg',
      },
      {
        id: 24045,
        name: 'Joseph Gordon-Levitt',
        character: 'Arthur',
        order: 1,
        profile_path: '/jgl.jpg',
      },
      {
        id: 999,
        name: 'An Extra',
        character: 'Passenger (uncredited)',
        order: 2,
        profile_path: null,
      },
    ],
    crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director' }],
  },
  release_dates: {
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [{ certification: 'PG-13', type: 3 }],
      },
    ],
  },
};

function jsonResponse(status: number, body: unknown): TmdbFetchResponse {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    status,
    headers: { get: () => null },
    body: null,
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      ),
  };
}

const pictureResponse = (): TmdbFetchResponse => ({
  status: 200,
  headers: { get: () => null },
  body: null,
  arrayBuffer: () => Promise.resolve(new Uint8Array(64).fill(7).buffer),
});

describe('the automatic TMDB path, end to end (fake fetch)', () => {
  let lookup: TmdbLookupService;
  let movies: Map<string, Row>;
  let actors: Row[];
  let categories: Row[];
  let requested: URL[];
  let headersSeen: Array<Record<string, string>>;
  let audit: { record: jest.Mock };
  let imageStore: { save: jest.Mock };
  let logLines: () => string;
  /** What TMDB's API answers; replaced per test. */
  let api: (url: URL) => TmdbFetchResponse | Error;

  const movieNow = () => movies.get(MOVIE_ID) as Row;

  /** Builds the module the way TmdbModule does, with `key` as TMDB_API_KEY. */
  async function boot(key: string | undefined): Promise<void> {
    const fetchImpl: TmdbFetch = async (input, init) => {
      const url = new URL(input);
      requested.push(url);
      headersSeen.push(init.headers);
      if (url.host === 'image.tmdb.org') return pictureResponse();
      const answer = api(url);
      if (answer instanceof Error) throw answer;
      return answer;
    };

    const clone = <T>(value: T): T => {
      if (value instanceof Date) return new Date(value.getTime()) as T;
      if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, clone(v)]),
        ) as T;
      }
      return value;
    };
    const statusMatches = (row: Row, wanted: unknown) =>
      wanted === undefined ||
      (typeof wanted === 'string'
        ? row.tmdbStatus === wanted
        : (wanted as { in: string[] }).in.includes(row.tmdbStatus));

    const prisma = {
      movie: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const row = movies.get(where.id);
          return row ? clone(row) : null;
        }),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hit = [...movies.values()].filter(
              (row) =>
                (where.id === undefined || row.id === where.id) &&
                statusMatches(row, where.tmdbStatus),
            );
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
          },
        ),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Row }) => {
            const row = movies.get(where.id);
            if (!row) throw new Error('Record to update not found');
            for (const [key, value] of Object.entries(data)) {
              if (key === 'categories' || key === 'actors') {
                const source = key === 'categories' ? categories : actors;
                row[key] = (value as { set: Array<{ id: string }> }).set.map(
                  ({ id }) => source.find((entry) => entry.id === id),
                );
              } else {
                row[key] = value;
              }
            }
            return clone(row);
          },
        ),
      },
      category: {
        findMany: jest.fn(async (args?: Row) => {
          const ids = args?.where?.id?.in as string[] | undefined;
          return clone(
            ids ? categories.filter((c) => ids.includes(c.id)) : categories,
          );
        }),
      },
      actor: {
        findMany: jest.fn(async (args?: Row) => {
          const ids = args?.where?.id?.in as string[] | undefined;
          return clone(ids ? actors.filter((a) => ids.includes(a.id)) : actors);
        }),
        findUnique: jest.fn(async ({ where }: { where: Row }) => {
          const found = actors.find((a) =>
            where.tmdbPersonId !== undefined
              ? a.tmdbPersonId === where.tmdbPersonId
              : a.name === where.name,
          );
          return found ? clone(found) : null;
        }),
        create: jest.fn(async ({ data }: { data: Row }) => {
          const row = {
            id: `a-new-${actors.length + 1}`,
            imageUrl: null,
            createdAt: WHEN,
            updatedAt: WHEN,
            ...data,
          };
          actors.push(row);
          return clone(row);
        }),
        updateMany: jest.fn(
          async ({ where, data }: { where: Row; data: Row }) => {
            const hit = actors.filter(
              (a) =>
                a.id === where.id &&
                (where.tmdbPersonId === undefined ||
                  a.tmdbPersonId === where.tmdbPersonId) &&
                (where.OR === undefined || !a.imageUrl),
            );
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
          },
        ),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
    };

    let saved = 0;
    imageStore = {
      save: jest.fn(
        async (purpose: string) =>
          `http://cache.local/movies/images/${purpose}/tmdb-${++saved}.jpg`,
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TmdbClient,
        TmdbImageFetcher,
        TmdbRunRegistry,
        TmdbCastService,
        TmdbFillService,
        TmdbLookupService,
        { provide: TMDB_CLIENT_OPTIONS, useValue: { fetchImpl } },
        { provide: TMDB_IMAGE_FETCHER_OPTIONS, useValue: { fetchImpl } },
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) => (name === 'TMDB_API_KEY' ? key : undefined),
          },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: ImageStoreService, useValue: imageStore },
        {
          provide: MinioService,
          useValue: {
            keyFromPublicUrl: (url: string) => url.split('/movies/')[1] ?? null,
            imageUrl: (url: string | null) => url,
            deleteObject: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: audit },
        {
          provide: PermissionResolverService,
          useValue: { can: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile();
    lookup = module.get(TmdbLookupService);
  }

  beforeEach(() => {
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(),
    ];
    logLines = () =>
      spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map(String).join(' '))
        .join('\n');
    requested = [];
    headersSeen = [];
    categories = [
      { id: 'c-action', name: 'Action', description: null },
      { id: 'c-scifi', name: 'Sci Fi', description: null },
    ];
    actors = [
      {
        id: 'a-leo',
        name: 'Leonardo Dicaprio',
        imageUrl: 'http://cache.local/movies/images/actor/staff-leo.jpg',
        tmdbPersonId: null,
        createdAt: WHEN,
        updatedAt: WHEN,
      },
    ];
    // What POST /movies/upload-placeholder and a finished finalize leave.
    movies = new Map([
      [
        MOVIE_ID,
        {
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
          duration: 151,
          rating: 0,
          accessType: AccessType.SUBSCRIPTION,
          status: MovieStatus.READY_TO_PUBLISH,
          seriesId: null,
          seasonNumber: null,
          episodeNumber: null,
          sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
          tmdbId: null,
          tmdbStatus: TmdbLookupStatus.NONE,
          tmdbError: null,
          tmdbFetchedAt: null,
          tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
          createdAt: WHEN,
          updatedAt: WHEN,
          categories: [],
          actors: [],
          videos: [],
        },
      ],
    ]);
    api = (url) => {
      if (url.pathname === '/3/search/movie') {
        return jsonResponse(200, SEARCH_PAGE);
      }
      if (url.pathname === '/3/movie/27205') return jsonResponse(200, DETAILS);
      return jsonResponse(404, { status_message: 'not found' });
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('one clear match: the movie is filled by itself and waits in Ready to publish', async () => {
    await boot(READ_TOKEN);

    await lookup.afterUpload(MOVIE_ID, STAFF);

    const movie = movieNow();
    expect(movie).toEqual(
      expect.objectContaining({
        title: 'Inception',
        description: 'A thief who steals corporate secrets through dreams.',
        releaseYear: 2010,
        genre: 'Action',
        language: 'English',
        country: 'English',
        director: 'Christopher Nolan',
        ageRating: 'PG13',
        posterUrl: expect.stringContaining('/images/movie/tmdb-'),
        coverUrl: expect.stringContaining('/images/movie/tmdb-'),
        tmdbId: 27205,
        tmdbStatus: TmdbLookupStatus.MATCHED,
        tmdbError: null,
        // Measured from the real video at finalize: TMDB's 148 does not replace it.
        duration: 151,
        // Nothing publishes by itself.
        status: MovieStatus.READY_TO_PUBLISH,
        accessType: AccessType.SUBSCRIPTION,
        descriptionMm: null,
      }),
    );
    expect(movie.categories.map((c: Row) => c.name)).toEqual([
      'Action',
      'Sci Fi',
    ]);
    // The actor we had is reused (found by name) and linked; the one we did
    // not have is created; the uncredited extra is left out.
    expect(movie.actors.map((a: Row) => a.name)).toEqual([
      'Leonardo Dicaprio',
      'Joseph Gordon-Levitt',
    ]);
    expect(actors).toEqual([
      expect.objectContaining({
        id: 'a-leo',
        name: 'Leonardo Dicaprio',
        tmdbPersonId: 6193,
        // His photo was staff's: kept.
        imageUrl: 'http://cache.local/movies/images/actor/staff-leo.jpg',
      }),
      expect.objectContaining({
        name: 'Joseph Gordon-Levitt',
        tmdbPersonId: 24045,
        imageUrl: expect.stringContaining('/images/actor/tmdb-'),
      }),
    ]);
  });

  it("talks to TMDB's two hosts only, with the token in a header and never in a URL or a log", async () => {
    await boot(READ_TOKEN);

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(requested.map((url) => `${url.host}${url.pathname}`)).toEqual([
      // A1: the name with the year filter — one exact hit, so no A2 / A3.
      'api.themoviedb.org/3/search/movie',
      'api.themoviedb.org/3/movie/27205',
      // Poster, backdrop and the one missing photo, in any order.
      expect.stringMatching(/^image\.tmdb\.org\/t\/p\//),
      expect.stringMatching(/^image\.tmdb\.org\/t\/p\//),
      expect.stringMatching(/^image\.tmdb\.org\/t\/p\//),
    ]);
    expect(
      requested
        .filter((url) => url.host === 'image.tmdb.org')
        .map((url) => url.pathname)
        .sort(),
    ).toEqual([
      '/t/p/h632/jgl.jpg',
      '/t/p/original/backdrop.jpg',
      '/t/p/original/poster.jpg',
    ]);
    expect(requested[0].searchParams.get('query')).toBe('Inception');
    expect(requested[0].searchParams.get('year')).toBe('2010');
    for (const url of requested) {
      expect(url.protocol).toBe('https:');
      expect(url.toString()).not.toContain(READ_TOKEN);
    }
    // The token goes to the API, never to the image host.
    requested.forEach((url, index) => {
      const sent = headersSeen[index].authorization;
      expect(sent).toBe(
        url.host === 'api.themoviedb.org' ? `Bearer ${READ_TOKEN}` : undefined,
      );
    });
    expect(logLines()).toContain('MATCHED');
    expect(logLines()).not.toContain(READ_TOKEN);
  });

  it("stores every picture through the image store as a TMDB picture, and audits the fill in the uploader's name", async () => {
    await boot(READ_TOKEN);

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(
      imageStore.save.mock.calls
        .map(([purpose, filename, , user, options]) => [
          purpose,
          filename,
          user,
          options,
        ])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      [
        'movie',
        'backdrop.jpg',
        STAFF,
        { source: 'tmdb', sourceRef: '/backdrop.jpg' },
      ],
      ['actor', 'jgl.jpg', STAFF, { source: 'tmdb', sourceRef: '/jgl.jpg' }],
      [
        'movie',
        'poster.jpg',
        STAFF,
        { source: 'tmdb', sourceRef: '/poster.jpg' },
      ],
    ]);
    const rows = audit.record.mock.calls.map(([row]) => row as Row);
    expect(rows.map((row) => row.action).sort()).toEqual([
      'actor.create',
      'actor.update',
      'movie.update',
    ]);
    expect(rows.every((row) => row.actor === STAFF)).toBe(true);
    expect(rows.find((row) => row.action === 'movie.update')?.metadata).toEqual(
      {
        via: 'tmdb',
        trigger: 'upload',
        tmdbId: 27205,
        fields: [
          'title',
          'description',
          'releaseYear',
          'genre',
          'language',
          'country',
          'director',
          'ageRating',
          'poster',
          'cover',
          'categories',
          'cast',
        ],
      },
    );
  });

  it.each([undefined, '', '  '])(
    'TMDB_API_KEY %p: the feature is off — nothing is fetched and the movie is exactly as uploaded',
    async (key) => {
      await boot(key);
      const before = JSON.stringify(movieNow());

      await lookup.afterUpload(MOVIE_ID, STAFF);

      expect(requested).toEqual([]);
      expect(JSON.stringify(movieNow())).toBe(before);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('a v3 key travels as the api_key parameter of the API calls, and never to the image host', async () => {
    const v3Key = 'abcdef0123456789abcdef0123456789';
    await boot(v3Key);

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.MATCHED);
    for (const url of requested) {
      expect(url.searchParams.get('api_key')).toBe(
        url.host === 'api.themoviedb.org' ? v3Key : null,
      );
    }
    expect(headersSeen.every((headers) => !headers.authorization)).toBe(true);
    expect(logLines()).not.toContain(v3Key);
  });

  it('TMDB is down: FAILED / unreachable, and the upload is untouched', async () => {
    await boot(READ_TOKEN);
    api = () =>
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      });

    await expect(lookup.afterUpload(MOVIE_ID, STAFF)).resolves.toBeUndefined();

    expect(movieNow()).toEqual(
      expect.objectContaining({
        tmdbStatus: TmdbLookupStatus.FAILED,
        tmdbError: 'unreachable',
        status: MovieStatus.READY_TO_PUBLISH,
        description: '',
        tmdbId: null,
      }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('TMDB refuses the key: FAILED / key_rejected', async () => {
    await boot(READ_TOKEN);
    api = () => jsonResponse(401, { status_message: 'Invalid API key' });

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(movieNow()).toEqual(
      expect.objectContaining({
        tmdbStatus: TmdbLookupStatus.FAILED,
        tmdbError: 'key_rejected',
      }),
    );
  });

  it('two films of that name and year: NEEDS_PICK — no details are fetched and nothing is filled', async () => {
    await boot(READ_TOKEN);
    api = (url) =>
      url.pathname === '/3/search/movie'
        ? jsonResponse(200, {
            results: [
              SEARCH_PAGE.results[0],
              { ...SEARCH_PAGE.results[0], id: 2, release_date: '2011-01-01' },
            ],
          })
        : jsonResponse(500, {});

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(movieNow()).toEqual(
      expect.objectContaining({
        tmdbStatus: TmdbLookupStatus.NEEDS_PICK,
        tmdbError: null,
        description: '',
        tmdbId: null,
      }),
    );
    expect(requested.map((url) => url.pathname)).toEqual(['/3/search/movie']);
  });

  it('nothing on TMDB: NOT_FOUND after the three searches', async () => {
    await boot(READ_TOKEN);
    api = () => jsonResponse(200, { page: 1, results: [] });

    await lookup.afterUpload(MOVIE_ID, STAFF);

    expect(movieNow().tmdbStatus).toBe(TmdbLookupStatus.NOT_FOUND);
    expect(
      requested.map((url) => [
        url.searchParams.get('query'),
        url.searchParams.get('year'),
      ]),
    ).toEqual([
      ['Inception', '2010'],
      ['Inception', null],
      ['Inception 2010', null],
    ]);
  });
});
