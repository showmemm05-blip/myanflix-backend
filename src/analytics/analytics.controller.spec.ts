import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { FinanceController } from '../finance/finance.controller';
import { FinanceService } from '../finance/finance.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Stands in for the global JwtAuthGuard: `x-test-role` picks the seeded
 * system role (absent = 401). The real PermissionsGuard runs against the
 * real seeds, so these cases prove what each built-in role sees on the
 * dashboard (H-26): the seeded Admin holds DASHBOARD.VIEW but not
 * FINANCE.VIEW, and must still get the non-money stats.
 */
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

const OVERVIEW = {
  totalViews: 12,
  averageCompletionRate: 0.5,
  averageWatchDurationSeconds: 300,
  popularMovies: [],
  userRegistrations: { last7Days: 1, last30Days: 3 },
  revenue: null,
  totalMovies: 4,
  totalUsers: 9,
  activeUsers: 8,
};

describe('AnalyticsController — dashboard stats by permission', () => {
  let app: INestApplication<App>;
  let analytics: { getOverview: jest.Mock; getUserGrowthTrend: jest.Mock };
  let finance: { getDashboard: jest.Mock; getRevenueTrend: jest.Mock };

  beforeEach(async () => {
    analytics = {
      getOverview: jest.fn().mockResolvedValue(OVERVIEW),
      getUserGrowthTrend: jest.fn().mockResolvedValue([]),
    };
    finance = {
      getDashboard: jest.fn().mockResolvedValue({}),
      getRevenueTrend: jest.fn().mockResolvedValue({}),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController, FinanceController],
      providers: [
        { provide: AnalyticsService, useValue: analytics },
        { provide: FinanceService, useValue: finance },
        {
          provide: PermissionResolverService,
          useValue: createSeededPermissionResolver(),
        },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the seeded Admin the overview without the revenue figure', async () => {
    await request(app.getHttpServer())
      .get('/analytics/overview')
      .set('x-test-role', Role.ADMIN)
      .expect(200);
    expect(analytics.getOverview).toHaveBeenCalledWith({
      includeRevenue: false,
    });
  });

  it('includes revenue for a caller holding FINANCE.VIEW', async () => {
    await request(app.getHttpServer())
      .get('/analytics/overview')
      .set('x-test-role', Role.SUPER_ADMIN)
      .expect(200);
    expect(analytics.getOverview).toHaveBeenCalledWith({
      includeRevenue: true,
    });
  });

  it('serves the seeded Admin the user-growth chart', async () => {
    await request(app.getHttpServer())
      .get('/analytics/user-growth')
      .set('x-test-role', Role.ADMIN)
      .expect(200);
    expect(analytics.getUserGrowthTrend).toHaveBeenCalled();
  });

  it.each([Role.CONTENT_UPLOADER, Role.USER])(
    'refuses %s — no DASHBOARD.VIEW is seeded to it',
    async (role) => {
      for (const path of ['/analytics/overview', '/analytics/user-growth']) {
        await request(app.getHttpServer())
          .get(path)
          .set('x-test-role', role)
          .expect(403);
      }
      expect(analytics.getOverview).not.toHaveBeenCalled();
      expect(analytics.getUserGrowthTrend).not.toHaveBeenCalled();
    },
  );

  it('keeps the money endpoints FINANCE.VIEW-only (the Admin is refused)', async () => {
    for (const path of ['/finance/dashboard', '/finance/revenue-trend']) {
      await request(app.getHttpServer())
        .get(path)
        .set('x-test-role', Role.ADMIN)
        .expect(403);
    }
    expect(finance.getDashboard).not.toHaveBeenCalled();
    expect(finance.getRevenueTrend).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers', async () => {
    await request(app.getHttpServer()).get('/analytics/overview').expect(401);
  });
});
