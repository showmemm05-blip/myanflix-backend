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
import { Role, SeriesStatus } from '../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorityService } from '../roles/authority.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

const SERIES_ID = '33333333-3333-4333-8333-333333333333';

/** Same stand-in as the movies gate spec — see the note there. */
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

describe('SeriesController — publish/unpublish gate (F11)', () => {
  let app: INestApplication<App>;
  let seriesService: {
    updateStatus: jest.Mock;
    update: jest.Mock;
    findAll: jest.Mock;
    getFacets: jest.Mock;
  };

  beforeEach(async () => {
    seriesService = {
      updateStatus: jest.fn().mockResolvedValue({ id: SERIES_ID }),
      update: jest.fn().mockResolvedValue({ id: SERIES_ID }),
      findAll: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      getFacets: jest
        .fn()
        .mockResolvedValue({ genres: [], languages: [], years: null }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SeriesController],
      providers: [
        AuthorityService,
        { provide: SeriesService, useValue: seriesService },
        { provide: MinioService, useValue: { imageUrl: (u: string) => u } },
        {
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([
            seededRoleRow(Role.SUPER_ADMIN, 'role-super'),
            seededRoleRow(Role.ADMIN, 'role-admin'),
            seededRoleRow(Role.CONTENT_UPLOADER, 'role-uploader'),
            seededRoleRow(Role.USER, 'role-user'),
            // Holds the permission the route's decorator names, but not the
            // one the unpublish direction actually needs.
            {
              id: 'role-publisher',
              key: 'SERIES_PUBLISHER',
              permissions: ['SERIES.VIEW', 'SERIES.EDIT', 'SERIES.PUBLISH'],
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

  const asPublisher = (test: request.Test) =>
    test
      .set('x-test-role', Role.ADMIN)
      .set('x-test-app-role', 'role-publisher');

  it.each([SeriesStatus.DRAFT, SeriesStatus.UNPUBLISHED])(
    'F11: refuses to move a series to %s without SERIES.UNPUBLISH',
    async (status) => {
      await asPublisher(
        request(app.getHttpServer())
          .patch(`/series/${SERIES_ID}/status`)
          .send({ status }),
      ).expect(403);

      expect(seriesService.updateStatus).not.toHaveBeenCalled();
    },
  );

  it('F11: still allows publishing with SERIES.PUBLISH', async () => {
    await asPublisher(
      request(app.getHttpServer())
        .patch(`/series/${SERIES_ID}/status`)
        .send({ status: SeriesStatus.PUBLISHED }),
    ).expect(200);

    expect(seriesService.updateStatus).toHaveBeenCalledWith(
      SERIES_ID,
      SeriesStatus.PUBLISHED,
      expect.objectContaining({ id: 'admin-1' }),
    );
  });

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still unpublishes series — the seeds grant UNPUBLISH to every role with EDIT',
    async (role) => {
      await request(app.getHttpServer())
        .patch(`/series/${SERIES_ID}/status`)
        .set('x-test-role', role)
        .send({ status: SeriesStatus.UNPUBLISHED })
        .expect(200);

      expect(seriesService.updateStatus).toHaveBeenCalled();
    },
  );

  it.each([Role.ADMIN, Role.CONTENT_UPLOADER])(
    'F11: %s still publishes series',
    async (role) => {
      await request(app.getHttpServer())
        .patch(`/series/${SERIES_ID}/status`)
        .set('x-test-role', role)
        .send({ status: SeriesStatus.PUBLISHED })
        .expect(200);

      expect(seriesService.updateStatus).toHaveBeenCalled();
    },
  );

  /**
   * F-002: through the REAL ValidationPipe a partial PUT must reach the
   * service without a resurrected `accessType` — CreateSeriesDto used to carry
   * `= SUBSCRIPTION`, which PartialType copied into every UpdateSeriesDto.
   */
  it('F-002: a description-only PUT reaches the service without an accessType', async () => {
    await request(app.getHttpServer())
      .put(`/series/${SERIES_ID}`)
      .set('x-test-role', Role.SUPER_ADMIN)
      .send({ description: 'x' })
      .expect(200);

    const dto = seriesService.update.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(dto.accessType).toBeUndefined();
    expect(dto).not.toHaveProperty('accessType');
    expect(dto).toEqual({ description: 'x' });
  });

  /**
   * The canonical filter wire format through the REAL global ValidationPipe
   * (whitelist + forbidNonWhitelisted + transform) — proves the DTO accepts
   * both CSV and repeated-param arrays and hands the service clean values.
   */
  describe('GET /series — canonical filter params', () => {
    it('parses CSV arrays, numeric ranges and the sort enum', async () => {
      await request(app.getHttpServer())
        .get('/series')
        .query({
          search: 'thrones',
          genres: 'Drama,Action',
          languages: 'Burmese',
          yearFrom: '2000',
          yearTo: '2020',
          sort: 'newest',
        })
        .expect(200);

      expect(seriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'thrones',
          genres: ['Drama', 'Action'],
          languages: ['Burmese'],
          yearFrom: 2000,
          yearTo: 2020,
          sort: 'newest',
        }),
        Role.SUPER_ADMIN,
      );
    });

    it('accepts a repeated param as the same array', async () => {
      await request(app.getHttpServer())
        .get('/series?genres=Drama&genres=Action')
        .expect(200);

      expect(seriesService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ genres: ['Drama', 'Action'] }),
        expect.anything(),
      );
    });

    it('rejects a sort value outside the series subset', async () => {
      await request(app.getHttpServer())
        .get('/series')
        .query({ sort: 'mostViewed' })
        .expect(400);

      expect(seriesService.findAll).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range year', async () => {
      await request(app.getHttpServer())
        .get('/series')
        .query({ yearFrom: '1500' })
        .expect(400);
    });
  });

  it('GET /series/facets routes to the facets handler, not the :id param route', async () => {
    const res = await request(app.getHttpServer())
      .get('/series/facets')
      .expect(200);

    expect(seriesService.getFacets).toHaveBeenCalled();
    expect(res.body).toEqual({ genres: [], languages: [], years: null });
  });
});

/**
 * The guest read paths through the REAL JwtAuthGuard — see the matching
 * block in the movies controller spec for why only passport is stubbed.
 */
describe('SeriesController — guest catalogue (@OptionalAuth)', () => {
  let app: INestApplication<App>;
  let seriesService: {
    findAll: jest.Mock;
    getFacets: jest.Mock;
    getForViewer: jest.Mock;
    getEpisodes: jest.Mock;
    getPlayerEpisodes: jest.Mock;
    getSeasons: jest.Mock;
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

    seriesService = {
      findAll: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      getFacets: jest
        .fn()
        .mockResolvedValue({ genres: [], languages: [], years: null }),
      getForViewer: jest.fn().mockResolvedValue({ id: SERIES_ID }),
      getEpisodes: jest.fn().mockResolvedValue([]),
      getPlayerEpisodes: jest.fn().mockResolvedValue({ seasons: [] }),
      getSeasons: jest.fn().mockResolvedValue([]),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SeriesController],
      providers: [
        { provide: SeriesService, useValue: seriesService },
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

  it('GET /series without a token: 200, scoped to Role.USER, passport untouched', async () => {
    await request(app.getHttpServer()).get('/series').expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(seriesService.findAll).toHaveBeenCalledWith(
      expect.anything(),
      Role.USER,
    );
  });

  it('GET /series/facets is open to guests', async () => {
    await request(app.getHttpServer()).get('/series/facets').expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(seriesService.getFacets).toHaveBeenCalled();
  });

  it('GET /series/:id without a token: viewed as Role.USER with no viewer id', async () => {
    await request(app.getHttpServer()).get(`/series/${SERIES_ID}`).expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(seriesService.getForViewer).toHaveBeenCalledWith(
      SERIES_ID,
      undefined,
      Role.USER,
    );
  });

  it('GET /series/:id/episodes without a token: listed as Role.USER', async () => {
    await request(app.getHttpServer())
      .get(`/series/${SERIES_ID}/episodes`)
      .query({ seasonNumber: '2' })
      .expect(200);

    expect(passportCanActivate).not.toHaveBeenCalled();
    expect(seriesService.getEpisodes).toHaveBeenCalledWith(
      SERIES_ID,
      Role.USER,
      2,
    );
  });

  it('GET /series with a token: goes through passport and keeps the staff view', async () => {
    await request(app.getHttpServer())
      .get('/series')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);

    expect(passportCanActivate).toHaveBeenCalledTimes(1);
    expect(seriesService.findAll).toHaveBeenCalledWith(
      expect.anything(),
      Role.ADMIN,
    );
  });

  it.each([
    ['player-episodes', 'getPlayerEpisodes'],
    ['seasons', 'getSeasons'],
  ] as const)(
    'GET /series/:id/%s stays protected: no token is a 401',
    async (path, method) => {
      passportCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });

      await request(app.getHttpServer())
        .get(`/series/${SERIES_ID}/${path}`)
        .expect(401);

      expect(passportCanActivate).toHaveBeenCalledTimes(1);
      expect(seriesService[method]).not.toHaveBeenCalled();
    },
  );
});
