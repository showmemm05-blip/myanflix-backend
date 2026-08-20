import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { PeakUsersController } from './peak-users.controller';
import { PeakUsersService } from './peak-users.service';

/**
 * Stands in for the global JwtAuthGuard with the same contract: @Public
 * routes pass untouched, everything else requires the test to supply a role
 * via the `x-test-role` header (absent header = unauthenticated = 401).
 * The real PermissionsGuard then runs unmocked on the admin routes.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();

    req.user = { id: 'admin-1', username: 'boss', role, appRoleId: null };
    return true;
  }
}

describe('PeakUsersController', () => {
  let app: INestApplication<App>;
  let service: {
    getPublicTotal: jest.Mock;
    getAdminView: jest.Mock;
    setAdditional: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      getPublicTotal: jest.fn().mockResolvedValue({ peakUsers: 1037 }),
      getAdminView: jest.fn().mockResolvedValue({
        actualPeak: 137,
        actualPeakAt: '2026-08-01T12:00:00.000Z',
        additionalPeak: 900,
        displayedPeak: 1037,
      }),
      setAdditional: jest.fn().mockResolvedValue({
        actualPeak: 137,
        actualPeakAt: '2026-08-01T12:00:00.000Z',
        additionalPeak: 500,
        displayedPeak: 637,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PeakUsersController],
      providers: [
        { provide: PeakUsersService, useValue: service },
        {
          // The real PermissionsGuard, resolving against the real seeded
          // system-role permission sets — so these assertions keep proving
          // that e.g. the seeded ADMIN role has no PEAK_USERS.* permission.
          provide: PermissionResolverService,
          useValue: createSeededPermissionResolver(),
        },
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

  describe('GET /peak-users (public)', () => {
    it('responds without any authentication and returns only the combined total', async () => {
      const response = await request(app.getHttpServer())
        .get('/peak-users')
        .expect(200);

      expect(response.body).toEqual({ peakUsers: 1037 });
    });
  });

  describe('GET /peak-users/admin', () => {
    it('rejects unauthenticated requests', async () => {
      await request(app.getHttpServer()).get('/peak-users/admin').expect(401);
      expect(service.getAdminView).not.toHaveBeenCalled();
    });

    it('rejects roles without PEAK_USERS.VIEW (ADMIN, USER)', async () => {
      await request(app.getHttpServer())
        .get('/peak-users/admin')
        .set('x-test-role', 'ADMIN')
        .expect(403);
      await request(app.getHttpServer())
        .get('/peak-users/admin')
        .set('x-test-role', 'USER')
        .expect(403);
      expect(service.getAdminView).not.toHaveBeenCalled();
    });

    it('returns the split for SUPER_ADMIN', async () => {
      const response = await request(app.getHttpServer())
        .get('/peak-users/admin')
        .set('x-test-role', 'SUPER_ADMIN')
        .expect(200);

      expect(response.body).toEqual({
        actualPeak: 137,
        actualPeakAt: '2026-08-01T12:00:00.000Z',
        additionalPeak: 900,
        displayedPeak: 1037,
      });
    });
  });

  describe('PATCH /peak-users/additional', () => {
    it('rejects unauthenticated requests', async () => {
      await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .send({ additionalPeak: 500 })
        .expect(401);
      expect(service.setAdditional).not.toHaveBeenCalled();
    });

    it('rejects roles without PEAK_USERS.MANAGE', async () => {
      await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .set('x-test-role', 'ADMIN')
        .send({ additionalPeak: 500 })
        .expect(403);
      expect(service.setAdditional).not.toHaveBeenCalled();
    });

    it('updates via the service with the acting admin id for SUPER_ADMIN', async () => {
      const response = await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ additionalPeak: 500 })
        .expect(200);

      expect(service.setAdditional).toHaveBeenCalledWith(
        { additionalPeak: 500 },
        'admin-1',
      );
      expect(response.body.displayedPeak).toBe(637);
    });

    it('accepts 0 (reset)', async () => {
      await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ additionalPeak: 0 })
        .expect(200);

      expect(service.setAdditional).toHaveBeenCalledWith(
        { additionalPeak: 0 },
        'admin-1',
      );
    });

    it('rejects negative values', async () => {
      await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ additionalPeak: -1 })
        .expect(400);
      expect(service.setAdditional).not.toHaveBeenCalled();
    });

    it('rejects non-integer values', async () => {
      await request(app.getHttpServer())
        .patch('/peak-users/additional')
        .set('x-test-role', 'SUPER_ADMIN')
        .send({ additionalPeak: 1.5 })
        .expect(400);
      expect(service.setAdditional).not.toHaveBeenCalled();
    });
  });
});
