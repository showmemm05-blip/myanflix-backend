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
  let seriesService: { updateStatus: jest.Mock };

  beforeEach(async () => {
    seriesService = {
      updateStatus: jest.fn().mockResolvedValue({ id: SERIES_ID }),
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
});
