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
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { WithdrawalsController } from '../withdrawals/withdrawals.controller';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

/** `x-test-role` picks the seeded system role; absent = 401. */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();
    req.user = { id: 'staff-1', username: 'staff', role, appRoleId: null };
    return true;
  }
}

/**
 * H-24: GET /deposits/stats and /withdrawals/stats are real routes — not
 * swallowed by ':id' (whose ParseUUIDPipe would answer 400) — behind the
 * list's own VIEW permission, and they accept the list's filters,
 * including the new `search`, through the production ValidationPipe.
 */
describe.each(['deposits', 'withdrawals'] as const)(
  'GET /%s/stats',
  (resource) => {
    let app: INestApplication<App>;
    let stats: jest.Mock;
    let findOne: jest.Mock;
    let list: jest.Mock;

    beforeEach(async () => {
      stats = jest.fn().mockResolvedValue({ ok: true });
      findOne = jest.fn();
      list = jest.fn().mockResolvedValue({ items: [] });
      const service = {
        getAdminStats: stats,
        findOneAdmin: findOne,
        findAllAdmin: list,
      };

      const moduleFixture: TestingModule = await Test.createTestingModule({
        controllers: [DepositsController, WithdrawalsController],
        providers: [
          { provide: DepositsService, useValue: service },
          { provide: WithdrawalsService, useValue: service },
          {
            provide: PermissionResolverService,
            useValue: createSeededPermissionResolver(),
          },
          { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      // The same pipe options as the global one in app.module.ts.
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

    it('answers the seeded Admin with the service totals, filters passed through', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${resource}/stats`)
        .query({
          search: 'blake',
          verification: 'needs_review',
          dateFrom: '2026-09-01T00:00:00.000Z',
          page: 3,
        })
        .set('x-test-role', Role.ADMIN)
        .expect(200);

      expect(res.body).toEqual({ ok: true });
      expect(findOne).not.toHaveBeenCalled();
      expect(stats).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'blake',
          verification: 'needs_review',
          dateFrom: '2026-09-01T00:00:00.000Z',
        }),
      );
    });

    it('accepts `search` on the list route too', async () => {
      await request(app.getHttpServer())
        .get(`/${resource}`)
        .query({ search: 'blake', page: 2, limit: 50 })
        .set('x-test-role', Role.ADMIN)
        .expect(200);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'blake', page: 2, limit: 50 }),
      );
    });

    it('refuses a role without the VIEW permission', async () => {
      await request(app.getHttpServer())
        .get(`/${resource}/stats`)
        .set('x-test-role', Role.CONTENT_UPLOADER)
        .expect(403);
      expect(stats).not.toHaveBeenCalled();
    });

    it('rejects an over-long search', async () => {
      await request(app.getHttpServer())
        .get(`/${resource}/stats`)
        .query({ search: 'x'.repeat(101) })
        .set('x-test-role', Role.ADMIN)
        .expect(400);
    });
  },
);
