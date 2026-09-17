import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, type IAuthGuard } from '@nestjs/passport';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MovieStatus, Role } from '../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { VideoDurationService } from '../videos/video-duration.service';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';

const MOVIE_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Stands in for the global JwtAuthGuard: `x-test-role` picks the account kind
 * and the optional `x-test-app-role` puts the caller on a custom AppRole. The
 * real PermissionsGuard then runs unmocked, so these cases prove both halves
 * of F11 — the new gate refuses an edit-only role, and the seeded roles that
 * publish movies today keep publishing them.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    req.user = {
      id: 'admin-1',
      username: 'boss',
      role: req.headers['x-test-role'] ?? Role.SUPER_ADMIN,
      appRoleId: req.headers['x-test-app-role'] ?? null,
    };
    return true;
  }
}

describe('MoviesController — publish/unpublish gate (F11)', () => {
  let app: INestApplication<App>;
  let moviesService: {
    getStatusOrThrow: jest.Mock;
    update: jest.Mock;
    findAll: jest.Mock;
    getFacets: jest.Mock;
    createUploadPlaceholder: jest.Mock;
  };
  let videoDurationService: { backfill: jest.Mock };

  const movieRow = {
    id: MOVIE_ID,
    title: 'A Movie',
    description: '',
    posterUrl: null,
    coverUrl: null,
    thumbnailUrl: null,
    genre: '',
    language: '',
    releaseYear: 2026,
    duration: 100,
    rating: null,
    accessType: 'FREE',
    status: MovieStatus.PUBLISHED,
    seriesId: null,
    seasonNumber: null,
    episodeNumber: null,
    categories: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    moviesService = {
      getStatusOrThrow: jest.fn().mockResolvedValue(MovieStatus.DRAFT),
      update: jest.fn().mockResolvedValue(movieRow),
      findAll: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      getFacets: jest.fn().mockResolvedValue({
        genres: [],
        languages: [],
        countries: [],
        ageRatings: [],
        directors: [],
        years: null,
      }),
      createUploadPlaceholder: jest.fn().mockResolvedValue({
        ...movieRow,
        status: MovieStatus.UPLOADING,
      }),
    };
    videoDurationService = {
      backfill: jest
        .fn()
        .mockResolvedValue({
          scanned: 0,
          updated: 0,
          failed: [],
          remaining: 0,
        }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MoviesController],
      providers: [
        AuthorityService,
        { provide: MoviesService, useValue: moviesService },
        { provide: VideoDurationService, useValue: videoDurationService },
        { provide: MinioService, useValue: { imageUrl: (u: string) => u } },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([
            seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
            seededRoleRow(Role.ADMIN, 'role-admin'),
            seededRoleRow(Role.CONTENT_UPLOADER, 'role-uploader'),
            seededRoleRow(Role.USER, 'role-user'),
            // A plausible custom role: may edit the catalogue, may not decide
            // what the public sees.
            {
              id: 'role-editor',
              key: 'CATALOGUE_EDITOR',
              permissions: ['MOVIES.VIEW', 'MOVIES.EDIT'],
            },
          ]),
        },
        // AuthorityService's other dependency — this route never reaches it.
        { provide: PrismaService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const asEditor = (test: request.Test) =>
    test.set('x-test-role', Role.ADMIN).set('x-test-app-role', 'role-editor');

  it('F11: refuses to publish a movie with only MOVIES.EDIT', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.DRAFT);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ status: MovieStatus.PUBLISHED }),
    ).expect(403);

    expect(moviesService.update).not.toHaveBeenCalled();
  });

  it('F11: refuses to unpublish a movie with only MOVIES.EDIT', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ status: MovieStatus.ARCHIVED }),
    ).expect(403);

    expect(moviesService.update).not.toHaveBeenCalled();
  });

  it('F11: still allows an ordinary field edit with only MOVIES.EDIT', async () => {
    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ title: 'Renamed' }),
    ).expect(200);

    expect(moviesService.update).toHaveBeenCalled();
    // No status in the payload — the gate must not even look the movie up.
    expect(moviesService.getStatusOrThrow).not.toHaveBeenCalled();
  });

  /**
   * F-002: through the REAL ValidationPipe a partial PUT must reach the
   * service without a resurrected `accessType` — CreateMovieDto used to carry
   * `= SUBSCRIPTION`, which PartialType copied into every UpdateMovieDto.
   * `toEqual` ignores own `undefined` props (ES2023 class fields), which is
   * exactly the shape an empty body must produce.
   */
  it('F-002: a status-only PUT reaches the service without an accessType', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.DRAFT);

    await request(app.getHttpServer())
      .put(`/movies/${MOVIE_ID}`)
      .set('x-test-role', Role.SUPER_ADMIN)
      .send({ status: MovieStatus.PUBLISHED })
      .expect(200);

    const dto = moviesService.update.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(dto.accessType).toBeUndefined();
    expect(dto).not.toHaveProperty('accessType');
    expect(dto).toEqual({ status: MovieStatus.PUBLISHED });
  });

  it('F-002: an empty PUT body reaches the service as an empty dto', async () => {
    await request(app.getHttpServer())
      .put(`/movies/${MOVIE_ID}`)
      .set('x-test-role', Role.SUPER_ADMIN)
      .send({})
      .expect(200);

    expect(moviesService.update.mock.calls[0][1]).toEqual({});
  });

  it('F11: still allows editing a PUBLISHED movie that stays published', async () => {
    moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

    await asEditor(
      request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .send({ title: 'Renamed', status: MovieStatus.PUBLISHED }),
    ).expect(200);

    expect(moviesService.update).toHaveBeenCalled();
  });

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still publishes movies — the seeds grant PUBLISH to every role with EDIT',
    async (role) => {
      moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.DRAFT);

      await request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .set('x-test-role', role)
        .send({ status: MovieStatus.PUBLISHED })
        .expect(200);

      expect(moviesService.update).toHaveBeenCalled();
    },
  );

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still unpublishes movies',
    async (role) => {
      moviesService.getStatusOrThrow.mockResolvedValue(MovieStatus.PUBLISHED);

      await request(app.getHttpServer())
        .put(`/movies/${MOVIE_ID}`)
        .set('x-test-role', role)
        .send({ status: MovieStatus.DRAFT })
        .expect(200);

      expect(moviesService.update).toHaveBeenCalled();
    },
  );

  /**
   * The canonical filter wire format through the REAL global ValidationPipe
   * settings (whitelist + forbidNonWhitelisted + transform): CSV and
   * repeated-param arrays both land as clean string[], numbers convert, bad
   * values 400 before the service is ever reached.
   */
  describe('GET /movies — canonical filter params', () => {
    const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

    it('parses every canonical param off one deep link', async () => {
      await request(app.getHttpServer())
        .get('/movies')
        .query({
          search: 'dota',
          genres: 'Action,Drama',
          languages: 'Burmese',
          actorIds: ACTOR_ID,
          directors: 'Some Director',
          countries: 'Myanmar',
          ageRatings: 'PG13,R',
          yearFrom: '2000',
          yearTo: '2020',
          ratingMin: '5.5',
          ratingMax: '9',
          durationMin: '91',
          durationMax: '120',
          sort: 'mostViewed',
          accessType: 'FREE',
          genre: 'Legacy',
          page: '2',
          limit: '30',
        })
        .expect(200);

      expect(moviesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'dota',
          genres: ['Action', 'Drama'],
          languages: ['Burmese'],
          actorIds: [ACTOR_ID],
          directors: ['Some Director'],
          countries: ['Myanmar'],
          ageRatings: ['PG13', 'R'],
          yearFrom: 2000,
          yearTo: 2020,
          ratingMin: 5.5,
          ratingMax: 9,
          durationMin: 91,
          durationMax: 120,
          sort: 'mostViewed',
          accessType: 'FREE',
          genre: 'Legacy',
          page: 2,
          limit: 30,
        }),
        Role.SUPER_ADMIN,
        'admin-1',
      );
    });

    it('accepts repeated params as the same array', async () => {
      await request(app.getHttpServer())
        .get('/movies?genres=Action&genres=Drama')
        .expect(200);

      expect(moviesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ genres: ['Action', 'Drama'] }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('rejects a non-UUID actor id', async () => {
      await request(app.getHttpServer())
        .get('/movies')
        .query({ actorIds: 'not-a-uuid' })
        .expect(400);

      expect(moviesService.findAll).not.toHaveBeenCalled();
    });

    it('rejects an unknown age rating and an unknown sort', async () => {
      await request(app.getHttpServer())
        .get('/movies')
        .query({ ageRatings: 'PG-13' }) // display form, not the enum member
        .expect(400);
      await request(app.getHttpServer())
        .get('/movies')
        .query({ sort: 'mostPopular' })
        .expect(400);
    });

    it('still caps limit at 100', async () => {
      await request(app.getHttpServer())
        .get('/movies')
        .query({ limit: '101' })
        .expect(400);
    });
  });

  it('GET /movies/facets routes to the facets handler, not the :id param route', async () => {
    const res = await request(app.getHttpServer())
      .get('/movies/facets')
      .expect(200);

    expect(moviesService.getFacets).toHaveBeenCalled();
    expect(res.body).toEqual({
      genres: [],
      languages: [],
      countries: [],
      ageRatings: [],
      directors: [],
      years: null,
    });
  });

  describe('POST /movies/upload-placeholder — probed runtime', () => {
    it('accepts a probed duration and hands it to the service as whole minutes', async () => {
      await request(app.getHttpServer())
        .post('/movies/upload-placeholder')
        .send({ title: 'Bulk Title', duration: 91 })
        .expect(201);

      expect(moviesService.createUploadPlaceholder).toHaveBeenCalledWith(
        'Bulk Title',
        undefined,
        { duration: 91 },
        expect.objectContaining({ id: 'admin-1' }),
      );
    });

    it('still accepts a title-only body — an older admin build keeps working and the row is born unknown', async () => {
      await request(app.getHttpServer())
        .post('/movies/upload-placeholder')
        .send({ title: 'Bulk Title' })
        .expect(201);

      expect(moviesService.createUploadPlaceholder).toHaveBeenCalledWith(
        'Bulk Title',
        undefined,
        { duration: undefined },
        expect.objectContaining({ id: 'admin-1' }),
      );
    });

    it.each([
      [0, '0 is the unknown sentinel, never a measured value'],
      [-5, 'negative'],
      [6001, 'over the 100 h sanity bound'],
      [90.5, 'not whole minutes'],
    ])(
      'rejects duration %p (%s) with 400 before the service runs',
      async (duration) => {
        await request(app.getHttpServer())
          .post('/movies/upload-placeholder')
          .send({ title: 'Bulk Title', duration })
          .expect(400);

        expect(moviesService.createUploadPlaceholder).not.toHaveBeenCalled();
      },
    );
  });

  describe('POST /movies/durations/backfill', () => {
    it('runs the backfill with the 100 default for a role holding MOVIES.EDIT and returns plain numbers', async () => {
      videoDurationService.backfill.mockResolvedValue({
        scanned: 6,
        updated: 6,
        failed: [],
        remaining: 0,
      });

      const res = await asEditor(
        request(app.getHttpServer())
          .post('/movies/durations/backfill')
          .send({}),
      ).expect(200);

      expect(videoDurationService.backfill).toHaveBeenCalledWith(
        100,
        expect.objectContaining({ id: 'admin-1' }),
      );
      expect(res.body).toEqual({
        scanned: 6,
        updated: 6,
        failed: [],
        remaining: 0,
      });
    });

    it('passes an explicit limit through and rejects one over the 100 cap', async () => {
      await asEditor(
        request(app.getHttpServer())
          .post('/movies/durations/backfill')
          .send({ limit: 25 }),
      ).expect(200);
      expect(videoDurationService.backfill).toHaveBeenCalledWith(
        25,
        expect.objectContaining({ id: 'admin-1' }),
      );

      await asEditor(
        request(app.getHttpServer())
          .post('/movies/durations/backfill')
          .send({ limit: 101 }),
      ).expect(400);
      expect(videoDurationService.backfill).toHaveBeenCalledTimes(1);
    });

    it('is not a movie id — "durations" never falls through to a :id route, and USER is refused', async () => {
      await request(app.getHttpServer())
        .post('/movies/durations/backfill')
        .set('x-test-role', Role.USER)
        .send({})
        .expect(403);

      expect(videoDurationService.backfill).not.toHaveBeenCalled();
    });
  });
});

/**
 * The guest read paths through the REAL JwtAuthGuard. Only the passport
 * step underneath it is stubbed (AuthGuard() is memoized, so the spy lands
 * on the exact prototype JwtAuthGuard extends): a request with no
 * Authorization header must never reach it and must scope the service to
 * Role.USER; one with a header must go through it and keep the staff view.
 */
describe('MoviesController — guest catalogue (@OptionalAuth)', () => {
  let app: INestApplication<App>;
  let moviesService: {
    findAll: jest.Mock;
    findByIdOrThrow: jest.Mock;
    getFacets: jest.Mock;
    getMostPurchased: jest.Mock;
    getPurchasesForUser: jest.Mock;
  };
  let passportCanActivate: jest.SpyInstance;

  const admin = {
    id: 'admin-1',
    username: 'boss',
    role: Role.ADMIN,
    appRoleId: null,
  };

  beforeEach(async () => {
    passportCanActivate = jest
      .spyOn(AuthGuard('jwt').prototype as IAuthGuard, 'canActivate')
      .mockImplementation((context: ExecutionContext) => {
        const req = context
          .switchToHttp()
          .getRequest<{ user?: Record<string, unknown> }>();
        req.user = admin;
        return true;
      });

    moviesService = {
      findAll: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      findByIdOrThrow: jest.fn().mockResolvedValue({
        id: MOVIE_ID,
        title: 'A Movie',
        description: '',
        posterUrl: null,
        coverUrl: null,
        thumbnailUrl: null,
        genre: '',
        language: '',
        releaseYear: 2026,
        duration: 100,
        rating: 0,
        accessType: 'FREE',
        status: MovieStatus.PUBLISHED,
        seriesId: null,
        seasonNumber: null,
        episodeNumber: null,
        categories: [],
        actors: [],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }),
      getFacets: jest.fn().mockResolvedValue({
        genres: [],
        languages: [],
        countries: [],
        ageRatings: [],
        directors: [],
        years: null,
      }),
      getMostPurchased: jest.fn().mockResolvedValue([]),
      getPurchasesForUser: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MoviesController],
      providers: [
        { provide: MoviesService, useValue: moviesService },
        { provide: VideoDurationService, useValue: {} },
        { provide: MinioService, useValue: { imageUrl: (u: string) => u } },
        // None of the routes under test carry PermissionsGuard, but the
        // controller's other routes do, so its dependencies must resolve.
        { provide: AuthorityService, useValue: {} },
        { provide: PermissionResolverService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    passportCanActivate.mockRestore();
    await app.close();
  });

  it('GET /movies without a token: 200, scoped to Role.USER with no viewer id, passport untouched', async () => {
    await request(app.getHttpServer()).get('/movies').expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(moviesService.findAll).toHaveBeenCalledWith(
      expect.anything(),
      Role.USER,
      undefined,
    );
  });

  it('GET /movies/:id without a token: looked up as Role.USER', async () => {
    await request(app.getHttpServer()).get(`/movies/${MOVIE_ID}`).expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(moviesService.findByIdOrThrow).toHaveBeenCalledWith(
      MOVIE_ID,
      Role.USER,
    );
  });

  it('GET /movies/facets and /movies/most-purchased are open to guests', async () => {
    await request(app.getHttpServer()).get('/movies/facets').expect(200);
    await request(app.getHttpServer())
      .get('/movies/most-purchased')
      .expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(moviesService.getFacets).toHaveBeenCalled();
    expect(moviesService.getMostPurchased).toHaveBeenCalled();
  });

  it('GET /movies with a token: goes through passport and keeps the staff view', async () => {
    await request(app.getHttpServer())
      .get('/movies')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);

    expect(passportCanActivate).toHaveBeenCalledTimes(1);
    expect(moviesService.findAll).toHaveBeenCalledWith(
      expect.anything(),
      Role.ADMIN,
      'admin-1',
    );
  });

  it('GET /movies with a bad token: still a 401 so the client refreshes', async () => {
    passportCanActivate.mockImplementation(() => {
      throw new UnauthorizedException();
    });

    await request(app.getHttpServer())
      .get('/movies')
      .set('Authorization', 'Bearer expired')
      .expect(401);

    expect(moviesService.findAll).not.toHaveBeenCalled();
  });

  it('GET /movies/me/purchases stays protected: no token is a 401', async () => {
    passportCanActivate.mockImplementation(() => {
      throw new UnauthorizedException();
    });

    await request(app.getHttpServer()).get('/movies/me/purchases').expect(401);

    expect(passportCanActivate).toHaveBeenCalledTimes(1);
    expect(moviesService.getPurchasesForUser).not.toHaveBeenCalled();
  });
});
