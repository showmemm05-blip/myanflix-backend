import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import {
  AccessType,
  MovieStatus,
  Role,
  SeriesStatus,
  TmdbLookupStatus,
} from '../generated/prisma/client';
import { PERMISSIONS_KEY } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { TmdbFillService } from './tmdb-fill.service';
import { TmdbLookupService } from './tmdb-lookup.service';
import { TmdbSearchService } from './tmdb-search.service';
import { TmdbStateService } from './tmdb-state.service';
import { TmdbStatusService } from './tmdb-status.service';
import { TmdbController } from './tmdb.controller';

const STAFF = {
  id: 'staff-1',
  username: 'uploader',
  role: Role.CONTENT_UPLOADER,
  appRoleId: null,
} as unknown as AuthenticatedUser;

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const WHEN = new Date('2026-11-06T09:00:00Z');

const report = {
  filled: ['description'],
  skipped: [],
  actors: { reused: 0, created: 0, skipped: [] },
  categories: { added: [], unmatched: [] },
};

/** A stored movie as the fill hands it back: every column, staff-only ones included. */
const storedMovie = () => ({
  id: MOVIE_ID,
  title: 'Inception',
  description: 'A thief.',
  descriptionMm: null,
  posterUrl: 'http://cache.local/movies/images/movie/tmdb-poster.jpg',
  coverUrl: null,
  thumbnailUrl: null,
  genre: 'Action',
  language: 'English',
  country: 'English',
  director: 'Christopher Nolan',
  ageRating: 'PG13',
  releaseYear: 2010,
  duration: 148,
  rating: 0,
  accessType: AccessType.SUBSCRIPTION,
  status: MovieStatus.READY_TO_PUBLISH,
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  sourceName: 'Inception.2010.1080p.BluRay',
  tmdbId: 27205,
  tmdbStatus: TmdbLookupStatus.MATCHED,
  tmdbError: null,
  tmdbFetchedAt: WHEN,
  tmdbAuto: { v: 1, title: 'Inception' },
  createdAt: WHEN,
  updatedAt: WHEN,
  categories: [{ id: 'c-1', name: 'Action', description: null }],
  actors: [
    {
      id: 'a-1',
      name: 'Leonardo DiCaprio',
      imageUrl: 'http://cache.local/movies/images/actor/tmdb-leo.jpg',
      tmdbPersonId: 6193,
      createdAt: WHEN,
      updatedAt: WHEN,
    },
  ],
  videos: [],
});

const storedSeries = () => ({
  id: SERIES_ID,
  title: 'Stranger Things',
  description: 'A boy vanishes.',
  descriptionMm: null,
  posterUrl: 'http://cache.local/movies/images/series/tmdb-st.jpg',
  coverUrl: null,
  genre: 'Sci-Fi',
  language: 'English',
  country: 'English',
  releaseYear: 2016,
  rating: 0,
  accessType: AccessType.SUBSCRIPTION,
  status: SeriesStatus.DRAFT,
  tmdbId: 66732,
  tmdbFetchedAt: WHEN,
  tmdbAuto: { v: 1, title: 'Stranger Things' },
  createdAt: WHEN,
  updatedAt: WHEN,
  categories: [],
  actors: [
    {
      id: 'a-1',
      name: 'Winona Ryder',
      imageUrl: null,
      tmdbPersonId: 1920,
      createdAt: WHEN,
      updatedAt: WHEN,
    },
  ],
});

describe('TmdbController', () => {
  let controller: TmdbController;
  let status: { get: jest.Mock };
  let search: { searchMovies: jest.Mock; searchTv: jest.Mock };
  let state: { movieStates: jest.Mock; seriesState: jest.Mock };
  let lookup: { requestLookup: jest.Mock };
  let fill: Record<
    | 'previewMovie'
    | 'applyMovie'
    | 'previewSeries'
    | 'applySeries'
    | 'createSeries',
    jest.Mock
  >;

  beforeEach(async () => {
    status = {
      get: jest.fn().mockResolvedValue({
        configured: false,
        state: 'off',
        checkedAt: null,
      }),
    };
    search = {
      searchMovies: jest.fn().mockResolvedValue({ results: [] }),
      searchTv: jest.fn().mockResolvedValue({ results: [] }),
    };
    state = {
      movieStates: jest.fn().mockResolvedValue({ items: [] }),
      seriesState: jest.fn().mockResolvedValue({ seriesId: SERIES_ID }),
    };
    lookup = {
      requestLookup: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    };
    fill = {
      previewMovie: jest.fn().mockResolvedValue({ tmdbId: 27205 }),
      applyMovie: jest.fn().mockResolvedValue({ movie: storedMovie(), report }),
      previewSeries: jest.fn().mockResolvedValue({ tmdbId: 66732 }),
      applySeries: jest
        .fn()
        .mockResolvedValue({ series: storedSeries(), report }),
      createSeries: jest
        .fn()
        .mockResolvedValue({ series: storedSeries(), report }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TmdbController],
      providers: [
        { provide: TmdbStatusService, useValue: status },
        { provide: TmdbSearchService, useValue: search },
        { provide: TmdbStateService, useValue: state },
        { provide: TmdbLookupService, useValue: lookup },
        { provide: TmdbFillService, useValue: fill },
        {
          provide: MinioService,
          useValue: {
            // Stored URLs are re-hosted for the request that reads them.
            imageUrl: (url: string | null) =>
              url ? url.replace('cache.local', 'request.host') : url,
          },
        },
      ],
    })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(TmdbController);
  });

  describe('the eleven routes and what each one requires (PLAN 5.3)', () => {
    const methodName = (method: RequestMethod) => RequestMethod[method];

    /** [handler, METHOD /tmdb/path, permissions — ALL required, HTTP code]. */
    const ROUTES: Array<[keyof TmdbController, string, string[], number]> = [
      ['getStatus', 'GET /tmdb/status', ['MOVIES.VIEW'], 200],
      ['searchMovies', 'GET /tmdb/search/movie', ['MOVIES.EDIT'], 200],
      ['searchTv', 'GET /tmdb/search/tv', ['SERIES.EDIT'], 200],
      ['movieStates', 'GET /tmdb/movies/state', ['MOVIES.VIEW'], 200],
      [
        'lookupMovie',
        'POST /tmdb/movies/:id/lookup',
        ['MOVIES.EDIT', 'MEDIA.UPLOAD'],
        202,
      ],
      ['previewMovie', 'POST /tmdb/movies/:id/preview', ['MOVIES.EDIT'], 200],
      [
        'applyMovie',
        'POST /tmdb/movies/:id/apply',
        ['MOVIES.EDIT', 'MEDIA.UPLOAD'],
        200,
      ],
      ['seriesState', 'GET /tmdb/series/:id/state', ['SERIES.VIEW'], 200],
      [
        'createSeries',
        'POST /tmdb/series',
        ['SERIES.CREATE', 'MEDIA.UPLOAD'],
        201,
      ],
      ['previewSeries', 'POST /tmdb/series/:id/preview', ['SERIES.EDIT'], 200],
      [
        'applySeries',
        'POST /tmdb/series/:id/apply',
        ['SERIES.EDIT', 'MEDIA.UPLOAD'],
        200,
      ],
    ];

    it.each(ROUTES)(
      '%s is %s, behind %j, answering %i',
      (handlerName, route, permissions, httpCode) => {
        const handler = TmdbController.prototype[handlerName] as object;
        const method = Reflect.getMetadata(
          METHOD_METADATA,
          handler,
        ) as RequestMethod;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const prefix = Reflect.getMetadata(
          PATH_METADATA,
          TmdbController,
        ) as string;

        expect(`${methodName(method)} /${prefix}/${path}`).toBe(route);
        expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(
          permissions,
        );
        // Nest answers 200 to a GET and 201 to a POST unless told otherwise.
        const told = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as
          number | undefined;
        const answered =
          told ?? (method === RequestMethod.POST ? 201 : HttpStatus.OK);
        expect(answered).toBe(httpCode);
      },
    );

    it('has exactly these eleven handlers, every one with a permission', () => {
      const handlers = Object.getOwnPropertyNames(
        TmdbController.prototype,
      ).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.hasMetadata(
            PATH_METADATA,
            TmdbController.prototype[name as keyof TmdbController] as object,
          ),
      );

      expect(handlers.sort()).toEqual(ROUTES.map(([name]) => name).sort());
      for (const name of handlers) {
        const required = Reflect.getMetadata(
          PERMISSIONS_KEY,
          TmdbController.prototype[name as keyof TmdbController],
        ) as string[];
        expect(required.length).toBeGreaterThan(0);
      }
    });

    it('the permission guard sits on the whole class', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, TmdbController)).toEqual([
        PermissionsGuard,
      ]);
    });

    it('every route that stores pictures also asks for MEDIA.UPLOAD; a read or a review never does', () => {
      const storing = [
        'lookupMovie',
        'applyMovie',
        'createSeries',
        'applySeries',
      ];
      for (const [name, , permissions] of ROUTES) {
        expect(permissions.includes('MEDIA.UPLOAD')).toBe(
          storing.includes(name),
        );
      }
    });
  });

  it('status: answers without a key, and passes "Check again" on', async () => {
    await expect(controller.getStatus({})).resolves.toEqual({
      configured: false,
      state: 'off',
      checkedAt: null,
    });
    expect(status.get).toHaveBeenLastCalledWith(false);

    await controller.getStatus({ fresh: true });
    expect(status.get).toHaveBeenLastCalledWith(true);
    await controller.getStatus({ fresh: false });
    expect(status.get).toHaveBeenLastCalledWith(false);
  });

  it('search: a missing year is "any year"', async () => {
    await controller.searchMovies({ query: 'Inception', year: 2010 });
    await controller.searchMovies({ query: 'Inception' });
    await controller.searchTv({ query: 'Dark', year: 2017 });
    await controller.searchTv({ query: 'Dark' });

    expect(search.searchMovies.mock.calls).toEqual([
      ['Inception', 2010],
      ['Inception', null],
    ]);
    expect(search.searchTv.mock.calls).toEqual([
      ['Dark', 2017],
      ['Dark', null],
    ]);
  });

  it('states: hands the ids to the state service', async () => {
    await expect(controller.movieStates({ ids: [MOVIE_ID] })).resolves.toEqual({
      items: [],
    });
    expect(state.movieStates).toHaveBeenCalledWith([MOVIE_ID]);

    await controller.seriesState(SERIES_ID);
    expect(state.seriesState).toHaveBeenCalledWith(SERIES_ID);
  });

  it("lookup: starts it in the caller's name and answers PENDING", async () => {
    await expect(controller.lookupMovie(MOVIE_ID, STAFF)).resolves.toEqual({
      status: 'PENDING',
    });
    expect(lookup.requestLookup).toHaveBeenCalledWith(MOVIE_ID, STAFF);
  });

  it('preview: passes the TMDB id and the caller, and answers the review as it is', async () => {
    await expect(
      controller.previewMovie(MOVIE_ID, { tmdbId: 27205 }, STAFF),
    ).resolves.toEqual({ tmdbId: 27205 });
    expect(fill.previewMovie).toHaveBeenCalledWith(MOVIE_ID, 27205, STAFF);

    await expect(
      controller.previewSeries(SERIES_ID, { tmdbId: 66732 }, STAFF),
    ).resolves.toEqual({ tmdbId: 66732 });
    expect(fill.previewSeries).toHaveBeenCalledWith(SERIES_ID, 66732, STAFF);
  });

  describe('apply (movie)', () => {
    it('answers the movie in the shape every movie route uses — without the staff-only columns', async () => {
      const answer = await controller.applyMovie(
        MOVIE_ID,
        { tmdbId: 27205, fields: ['description', 'poster'] },
        STAFF,
      );

      expect(fill.applyMovie).toHaveBeenCalledWith(
        MOVIE_ID,
        27205,
        ['description', 'poster'],
        STAFF,
      );
      expect(answer.report).toBe(report);
      expect(answer.movie).toEqual(
        expect.objectContaining({
          id: MOVIE_ID,
          title: 'Inception',
          description: 'A thief.',
          descriptionMm: null,
          // Re-hosted for this request.
          posterUrl: 'http://request.host/movies/images/movie/tmdb-poster.jpg',
          actors: [
            {
              id: 'a-1',
              name: 'Leonardo DiCaprio',
              imageUrl: 'http://request.host/movies/images/actor/tmdb-leo.jpg',
            },
          ],
        }),
      );
      for (const column of [
        'sourceName',
        'tmdbId',
        'tmdbStatus',
        'tmdbError',
        'tmdbFetchedAt',
        'tmdbAuto',
      ]) {
        expect(answer.movie).not.toHaveProperty(column);
      }
      expect(JSON.stringify(answer)).not.toContain('tmdbPersonId');
    });
  });

  describe('apply and create (series)', () => {
    it.each([
      [
        'applySeries',
        () =>
          controller.applySeries(
            SERIES_ID,
            { tmdbId: 66732, fields: ['genre'] },
            STAFF,
          ),
      ],
      ['createSeries', () => controller.createSeries({ tmdbId: 66732 }, STAFF)],
    ])(
      '%s answers the usual series shape — without the TMDB columns',
      async (_name, call) => {
        const answer = await call();

        expect(answer.report).toBe(report);
        expect(answer.series).toEqual(
          expect.objectContaining({
            id: SERIES_ID,
            title: 'Stranger Things',
            status: SeriesStatus.DRAFT,
            posterUrl: 'http://request.host/movies/images/series/tmdb-st.jpg',
            actors: [{ id: 'a-1', name: 'Winona Ryder', imageUrl: null }],
          }),
        );
        for (const column of ['tmdbId', 'tmdbFetchedAt', 'tmdbAuto']) {
          expect(answer.series).not.toHaveProperty(column);
        }
        expect(JSON.stringify(answer)).not.toContain('tmdbPersonId');
      },
    );

    it('passes the entry, the fields and the caller to the fill', async () => {
      await controller.applySeries(
        SERIES_ID,
        { tmdbId: 66732, fields: ['genre', 'cast'] },
        STAFF,
      );
      await controller.createSeries({ tmdbId: 66732 }, STAFF);

      expect(fill.applySeries).toHaveBeenCalledWith(
        SERIES_ID,
        66732,
        ['genre', 'cast'],
        STAFF,
      );
      expect(fill.createSeries).toHaveBeenCalledWith(66732, STAFF);
    });
  });

  it('lets a refusal of a service through as it is', async () => {
    const refusal = new Error('TMDB_BUSY');
    fill.applyMovie.mockRejectedValue(refusal);
    fill.createSeries.mockRejectedValue(refusal);

    await expect(
      controller.applyMovie(MOVIE_ID, { tmdbId: 1, fields: [] }, STAFF),
    ).rejects.toBe(refusal);
    await expect(controller.createSeries({ tmdbId: 1 }, STAFF)).rejects.toBe(
      refusal,
    );
  });
});
