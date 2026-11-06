import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../../generated/prisma/client';
import { IS_AUTH_OPTIONAL_KEY } from '../../common/decorators/optional-auth.decorator';
import { PermissionResolverService } from '../../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../../test/seeded-permission-resolver';
import { LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { LotteryPublicResultsService } from './lottery-public-results.service';
import { LotteryPublishAdminController } from './lottery-publish-admin.controller';
import { LotteryPublishService } from './lottery-publish.service';
import { LotteryResultsController } from './lottery-results.controller';

/** The same stand-in for the global JwtAuthGuard as the other lottery controller specs. */
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
    req.user = { id: 'staff-1', username: 'boss', role, appRoleId: null };
    return true;
  }
}

const DRAW_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN = `/lottery/admin/draws/${DRAW_ID}`;

/** Every staff route, with a request that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'post';
  path: string;
  body?: Record<string, unknown>;
  permission: 'LOTTERY.VIEW' | 'LOTTERY.RESULTS_PUBLISH';
}> = [
  {
    method: 'get',
    path: `${ADMIN}/publish-preview`,
    permission: 'LOTTERY.VIEW',
  },
  {
    method: 'post',
    path: `${ADMIN}/publish`,
    body: { exchangeRate: 75.5 },
    permission: 'LOTTERY.RESULTS_PUBLISH',
  },
  { method: 'get', path: `${ADMIN}/winners`, permission: 'LOTTERY.VIEW' },
];

describe('LotteryPublishAdminController + LotteryResultsController', () => {
  let app: INestApplication<App>;
  let publish: Record<'preview' | 'publish' | 'listWinners', jest.Mock>;
  let results: Record<'list' | 'findByDrawNo' | 'winners', jest.Mock>;

  beforeAll(async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    publish = {
      preview: jest.fn().mockResolvedValue({ rate: 75, winners: 0 }),
      publish: jest
        .fn()
        .mockResolvedValue({ id: DRAW_ID, status: 'published' }),
      listWinners: jest.fn().mockResolvedValue(page),
    };
    results = {
      list: jest.fn().mockResolvedValue(page),
      findByDrawNo: jest.fn().mockResolvedValue({ drawNo: 24, groups: [] }),
      winners: jest.fn().mockResolvedValue({ items: [] }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LotteryPublishAdminController, LotteryResultsController],
      providers: [
        { provide: LotteryPublishService, useValue: publish },
        { provide: LotteryPublicResultsService, useValue: results },
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

  const call = (
    route: (typeof STAFF_ROUTES)[number],
    role?: Role,
  ): request.Test => {
    let test = request(app.getHttpServer())[route.method](route.path);
    if (role) test = test.set('x-test-role', role);
    if (route.body) test = test.send(route.body);
    return test;
  };

  const asAdmin = (test: request.Test) => test.set('x-test-role', Role.ADMIN);

  describe('staff routes', () => {
    it.each(STAFF_ROUTES)(
      '$method $path is 401 without a token',
      async (route) => {
        await call(route).expect(401);
      },
    );

    it.each(
      STAFF_ROUTES.flatMap((route) =>
        [Role.USER, Role.CONTENT_UPLOADER].map((role) => ({ ...route, role })),
      ),
    )('$method $path refuses $role with 403', async (route) => {
      await call(route, route.role).expect(403);
    });

    it.each(
      STAFF_ROUTES.flatMap((route) =>
        [Role.ADMIN, Role.SUPER_ADMIN].map((role) => ({ ...route, role })),
      ),
    )('$method $path admits $role', async (route) => {
      const res = await call(route, route.role);
      expect(res.status).toBeLessThan(300);
    });

    it('declares exactly the permission each route needs', () => {
      const routesWith = (permission: string) =>
        STAFF_ROUTES.filter((r) => r.permission === permission).map(
          (r) => `${r.method} ${r.path}`,
        );
      expect(routesWith('LOTTERY.VIEW')).toEqual([
        `get ${ADMIN}/publish-preview`,
        `get ${ADMIN}/winners`,
      ]);
      expect(routesWith('LOTTERY.RESULTS_PUBLISH')).toEqual([
        `post ${ADMIN}/publish`,
      ]);
    });

    it('never lets a signed-in customer at the preview, the publish or the winners table', async () => {
      for (const route of STAFF_ROUTES) {
        await call(route, Role.USER).expect(403);
      }
      expect(publish.preview).not.toHaveBeenCalled();
      expect(publish.publish).not.toHaveBeenCalled();
      expect(publish.listWinners).not.toHaveBeenCalled();
    });
  });

  describe('staff routing and validation', () => {
    it('previews with no rate, with a what-if rate, and 400s a bad one or a non-uuid id', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/publish-preview`),
      ).expect(200);
      expect(publish.preview).toHaveBeenCalledWith(DRAW_ID, undefined);

      await asAdmin(
        request(app.getHttpServer()).get(
          `${ADMIN}/publish-preview?exchangeRate=80.1234`,
        ),
      ).expect(200);
      expect(publish.preview).toHaveBeenLastCalledWith(DRAW_ID, 80.1234);

      for (const bad of ['abc', '0', '-1', '80.12345', '']) {
        await asAdmin(
          request(app.getHttpServer()).get(
            `${ADMIN}/publish-preview?exchangeRate=${bad}`,
          ),
        ).expect(400);
      }
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/publish-preview?page=1`),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer()).get(
          '/lottery/admin/draws/24/publish-preview',
        ),
      ).expect(400);
      expect(publish.preview).toHaveBeenCalledTimes(2);
    });

    it('publishes with the actor and the rate (a numeric string read as a number), or with no body; answers 200', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .post(`${ADMIN}/publish`)
          .send({ exchangeRate: '75.5' }),
      ).expect(200);
      expect(publish.publish).toHaveBeenCalledWith(
        DRAW_ID,
        { exchangeRate: 75.5 },
        expect.objectContaining({ id: 'staff-1', role: Role.ADMIN }),
      );

      await asAdmin(
        request(app.getHttpServer()).post(`${ADMIN}/publish`),
      ).expect(200);
      expect(publish.publish).toHaveBeenLastCalledWith(
        DRAW_ID,
        {},
        expect.objectContaining({ id: 'staff-1' }),
      );
    });

    it('400s a zero, negative, five-decimal or oversized rate, an unknown field, and a non-uuid id', async () => {
      const post = () =>
        asAdmin(request(app.getHttpServer()).post(`${ADMIN}/publish`));
      await post().send({ exchangeRate: 0 }).expect(400);
      await post().send({ exchangeRate: -75 }).expect(400);
      await post().send({ exchangeRate: 75.12345 }).expect(400);
      await post().send({ exchangeRate: 100_000_000 }).expect(400);
      await post().send({ exchangeRate: 'abc' }).expect(400);
      await post().send({ rate: 75 }).expect(400);
      await asAdmin(
        request(app.getHttpServer()).post('/lottery/admin/draws/24/publish'),
      ).expect(400);
      expect(publish.publish).not.toHaveBeenCalled();
    });

    it('lists winners with the search trimmed and the page read, defaulting to page 1 of 20; 400s a page size over 200', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(
          `${ADMIN}/winners?q=%20mya%20&page=2&pageSize=25`,
        ),
      ).expect(200);
      expect(publish.listWinners).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({ q: 'mya', page: 2, pageSize: 25 }),
      );

      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/winners`),
      ).expect(200);
      expect(publish.listWinners).toHaveBeenLastCalledWith(
        DRAW_ID,
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );

      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/winners?pageSize=201`),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/winners?page=0`),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/winners?status=won`),
      ).expect(400);
      expect(publish.listWinners).toHaveBeenCalledTimes(2);
    });
  });

  describe('public results reads', () => {
    it('serves the results list, one draw’s sheet and its winners to a guest and to a signed-in customer', async () => {
      await request(app.getHttpServer()).get('/lottery/results').expect(200);
      expect(results.list).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 20 }),
      );

      await request(app.getHttpServer())
        .get('/lottery/results?page=2&pageSize=10')
        .set('x-test-role', Role.USER)
        .expect(200);
      expect(results.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );

      await request(app.getHttpServer())
        .get('/lottery/draws/24/results')
        .expect(200);
      expect(results.findByDrawNo).toHaveBeenCalledWith(24);

      await request(app.getHttpServer())
        .get('/lottery/draws/24/winners')
        .expect(200);
      expect(results.winners).toHaveBeenCalledWith(24, 20);

      await request(app.getHttpServer())
        .get('/lottery/draws/24/winners?limit=50')
        .set('x-test-role', Role.USER)
        .expect(200);
      expect(results.winners).toHaveBeenLastCalledWith(24, 50);
    });

    it('400s a non-numeric draw number, a page size over 100, a limit over 50 or under 1, and an unknown field', async () => {
      const get = (path: string) => request(app.getHttpServer()).get(path);
      await get('/lottery/draws/abc/results').expect(400);
      await get('/lottery/draws/abc/winners').expect(400);
      await get('/lottery/results?pageSize=101').expect(400);
      await get('/lottery/draws/24/winners?limit=51').expect(400);
      await get('/lottery/draws/24/winners?limit=0').expect(400);
      await get('/lottery/draws/24/winners?limit=abc').expect(400);
      await get('/lottery/draws/24/winners?page=1').expect(400);
      expect(results.findByDrawNo).not.toHaveBeenCalled();
      expect(results.winners).not.toHaveBeenCalled();
      expect(results.list).not.toHaveBeenCalled();
    });

    it('passes the service’s "not published" 404 and its code through to a guest', async () => {
      const notPublished = () =>
        lotteryError(
          HttpStatus.NOT_FOUND,
          LOTTERY_ERRORS.RESULTS_NOT_PUBLISHED,
          'The results of this draw are not published yet',
          { drawNo: 24 },
        );
      results.findByDrawNo.mockRejectedValueOnce(notPublished());
      const res = await request(app.getHttpServer())
        .get('/lottery/draws/24/results')
        .expect(404);
      expect(res.body).toMatchObject({
        code: LOTTERY_ERRORS.RESULTS_NOT_PUBLISHED,
        drawNo: 24,
      });

      results.winners.mockRejectedValueOnce(notPublished());
      await request(app.getHttpServer())
        .get('/lottery/draws/24/winners')
        .expect(404);
    });
  });
});
