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
import { ClientPlatform, Role } from '../../generated/prisma/client';
import { IS_AUTH_OPTIONAL_KEY } from '../../common/decorators/optional-auth.decorator';
import { PermissionResolverService } from '../../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../../test/seeded-permission-resolver';
import { LotteryActivityController } from './lottery-activity.controller';
import { LotteryActivityService } from './lottery-activity.service';
import { LotteryAnalyticsAdminController } from './lottery-analytics-admin.controller';
import { LotteryAnalyticsService } from './lottery-analytics.service';

/**
 * Stands in for the global JwtAuthGuard (the same stand-in as the draws
 * controller spec): `x-test-role` supplies a role; absent = no token =
 * 401. The real PermissionsGuard then runs against the real seeded
 * permission sets.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const role = req.headers['x-test-role'];
    if (!role) {
      const optional = this.reflector.getAllAndOverride<boolean>(
        IS_AUTH_OPTIONAL_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (optional) return true;
      throw new UnauthorizedException();
    }
    req.user = { id: 'user-1', username: 'thandar', role, appRoleId: null };
    return true;
  }
}

const DRAW_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN = '/lottery/admin/analytics';

type AnalyticsMethod =
  | 'overview'
  | 'activity'
  | 'numbers'
  | 'numbersAcross'
  | 'frequency'
  | 'heatmap'
  | 'beforeClose'
  | 'draws';

/** Every staff read, with the service method it lands on. */
const STAFF_ROUTES: Array<{ path: string; method: AnalyticsMethod }> = [
  { path: `${ADMIN}/overview`, method: 'overview' },
  { path: `${ADMIN}/activity`, method: 'activity' },
  { path: `${ADMIN}/numbers`, method: 'numbers' },
  { path: `${ADMIN}/numbers/across`, method: 'numbersAcross' },
  { path: `${ADMIN}/frequency`, method: 'frequency' },
  { path: `${ADMIN}/heatmap`, method: 'heatmap' },
  { path: `${ADMIN}/before-close`, method: 'beforeClose' },
  { path: `${ADMIN}/draws`, method: 'draws' },
];

describe('Lottery analytics controllers', () => {
  let app: INestApplication<App>;
  let analytics: Record<AnalyticsMethod, jest.Mock>;
  let activity: Record<'record' | 'firstActivityAt', jest.Mock>;

  beforeAll(async () => {
    analytics = {
      overview: jest.fn().mockResolvedValue({ range: {} }),
      activity: jest.fn().mockResolvedValue({ buckets: [] }),
      numbers: jest.fn().mockResolvedValue({ items: [] }),
      numbersAcross: jest.fn().mockResolvedValue({ items: [] }),
      frequency: jest.fn().mockResolvedValue({ bins: [] }),
      heatmap: jest.fn().mockResolvedValue({ cells: [] }),
      beforeClose: jest.fn().mockResolvedValue({ bins: [] }),
      draws: jest.fn().mockResolvedValue({ items: [] }),
    };
    activity = {
      record: jest.fn().mockResolvedValue(undefined),
      firstActivityAt: jest.fn().mockResolvedValue(null),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LotteryAnalyticsAdminController, LotteryActivityController],
      providers: [
        { provide: LotteryAnalyticsService, useValue: analytics },
        { provide: LotteryActivityService, useValue: activity },
        {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, role?: Role): request.Test => {
    const test = request(app.getHttpServer()).get(path);
    return role ? test.set('x-test-role', role) : test;
  };

  describe('GET /lottery/admin/analytics/* — LOTTERY.VIEW reads', () => {
    it.each(STAFF_ROUTES)(
      '$path: 401 without a token, 403 for a customer, 200 for ADMIN',
      async ({ path, method }) => {
        await get(path).expect(401);
        await get(path, Role.USER).expect(403);
        expect(analytics[method]).not.toHaveBeenCalled();

        await get(path, Role.ADMIN).expect(200);
        expect(analytics[method]).toHaveBeenCalledTimes(1);
      },
    );

    it('passes the parsed period / draw / view / paging to the service', async () => {
      await get(
        `${ADMIN}/overview?from=2026-10-16&to=2026-10-22&drawId=${DRAW_ID}`,
        Role.ADMIN,
      ).expect(200);
      expect(analytics.overview).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '2026-10-16',
          to: '2026-10-22',
          drawId: DRAW_ID,
        }),
      );

      await get(`${ADMIN}/activity?view=weekday`, Role.ADMIN).expect(200);
      expect(analytics.activity).toHaveBeenCalledWith(
        expect.objectContaining({ view: 'weekday' }),
      );

      await get(
        `${ADMIN}/numbers?sort=buyers&order=asc&page=2&pageSize=50`,
        Role.ADMIN,
      ).expect(200);
      expect(analytics.numbers).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: 'buyers',
          order: 'asc',
          page: 2,
          pageSize: 50,
        }),
      );

      await get(`${ADMIN}/draws?pageSize=100`, Role.ADMIN).expect(200);
      expect(analytics.draws).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 100 }),
      );
    });

    it('400s a bad view, a page size over the cap, a non-calendar date and a draw id on the across table', async () => {
      await get(`${ADMIN}/activity?view=monthly`, Role.ADMIN).expect(400);
      await get(`${ADMIN}/numbers?pageSize=1001`, Role.ADMIN).expect(400);
      await get(
        `${ADMIN}/overview?from=2026-02-30&to=2026-03-01`,
        Role.ADMIN,
      ).expect(400);
      await get(`${ADMIN}/numbers/across?drawId=${DRAW_ID}`, Role.ADMIN).expect(
        400,
      );
      expect(analytics.activity).not.toHaveBeenCalled();
      expect(analytics.numbers).not.toHaveBeenCalled();
      expect(analytics.overview).not.toHaveBeenCalled();
      expect(analytics.numbersAcross).not.toHaveBeenCalled();
    });
  });

  describe('POST /lottery/activity — the presence ping', () => {
    it('401s without a token', async () => {
      await request(app.getHttpServer())
        .post('/lottery/activity')
        .send({})
        .expect(401);
      expect(activity.record).not.toHaveBeenCalled();
    });

    it('answers 204 with no body for any signed-in user and records the ping for them (platform from the request, UNKNOWN here)', async () => {
      const response = await request(app.getHttpServer())
        .post('/lottery/activity')
        .set('x-test-role', Role.USER)
        .send({})
        .expect(204);

      expect(response.text).toBe('');
      expect(activity.record).toHaveBeenCalledWith(
        'user-1',
        ClientPlatform.UNKNOWN,
        expect.any(Date),
      );
    });

    it('ignores whatever the body carries and still answers 204', async () => {
      await request(app.getHttpServer())
        .post('/lottery/activity')
        .set('x-test-role', Role.ADMIN)
        .send({ drawId: DRAW_ID, platform: 'WEB' })
        .expect(204);

      expect(activity.record).toHaveBeenCalledWith(
        'user-1',
        ClientPlatform.UNKNOWN,
        expect.any(Date),
      );
    });
  });
});
