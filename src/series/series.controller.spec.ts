import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role, SeriesStatus } from '../generated/prisma/client';
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
    findAll: jest.Mock;
    getFacets: jest.Mock;
  };

  beforeEach(async () => {
    seriesService = {
      updateStatus: jest.fn().mockResolvedValue({ id: SERIES_ID }),
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
