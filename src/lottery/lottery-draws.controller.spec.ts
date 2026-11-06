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
import { Role } from '../generated/prisma/client';
import { IS_AUTH_OPTIONAL_KEY } from '../common/decorators/optional-auth.decorator';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { LotteryDrawsAdminController } from './lottery-draws-admin.controller';
import { LotteryDrawsAdminService } from './lottery-draws-admin.service';
import { LotteryDrawsController } from './lottery-draws.controller';
import { LotteryDrawsService } from './lottery-draws.service';
import { LotterySettingsAdminController } from './lottery-settings-admin.controller';
import { LotterySettingsService } from './lottery-settings.service';

/**
 * Stands in for the global JwtAuthGuard, @OptionalAuth included (the same
 * stand-in as the dreams controller spec): `x-test-role` supplies a role;
 * absent = no token = 401, except on an @OptionalAuth route, which passes
 * as a guest with no `req.user`. The real PermissionsGuard then runs
 * against the real seeded permission sets.
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
    req.user = { id: 'staff-1', username: 'boss', role, appRoleId: null };
    return true;
  }
}

const DRAW_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN = `/lottery/admin/draws/${DRAW_ID}`;

/** Every staff route, with a request that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'patch' | 'post' | 'put';
  path: string;
  body?: Record<string, unknown>;
  permission:
    'LOTTERY.VIEW' | 'LOTTERY.DRAWS_MANAGE' | 'LOTTERY.SETTINGS_MANAGE';
}> = [
  {
    method: 'get',
    path: '/lottery/admin/settings',
    permission: 'LOTTERY.VIEW',
  },
  {
    method: 'patch',
    path: '/lottery/admin/settings',
    body: { ticketPrice: 1500 },
    permission: 'LOTTERY.SETTINGS_MANAGE',
  },
  { method: 'get', path: '/lottery/admin/draws', permission: 'LOTTERY.VIEW' },
  {
    method: 'post',
    path: '/lottery/admin/draws',
    body: { thaiDrawDate: '2026-11-01' },
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  { method: 'get', path: ADMIN, permission: 'LOTTERY.VIEW' },
  {
    method: 'patch',
    path: ADMIN,
    body: { maxPerNumber: 5 },
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  { method: 'post', path: `${ADMIN}/open`, permission: 'LOTTERY.DRAWS_MANAGE' },
  {
    method: 'post',
    path: `${ADMIN}/pause`,
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  {
    method: 'post',
    path: `${ADMIN}/close`,
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  {
    method: 'post',
    path: `${ADMIN}/reopen`,
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  {
    method: 'put',
    path: `${ADMIN}/off-sale`,
    body: { numbers: ['123456'] },
    permission: 'LOTTERY.DRAWS_MANAGE',
  },
  { method: 'get', path: `${ADMIN}/tickets`, permission: 'LOTTERY.VIEW' },
];

describe('LotteryDraws controllers', () => {
  let app: INestApplication<App>;
  let draws: Record<
    'current' | 'listPublic' | 'findPublic' | 'availability',
    jest.Mock
  >;
  let adminDraws: Record<
    | 'list'
    | 'create'
    | 'findOne'
    | 'update'
    | 'open'
    | 'pause'
    | 'close'
    | 'reopen'
    | 'setOffSale'
    | 'listTickets',
    jest.Mock
  >;
  let settings: Record<'get' | 'update', jest.Mock>;

  beforeAll(async () => {
    const draw = { id: DRAW_ID, drawNo: 24 };
    draws = {
      current: jest.fn().mockResolvedValue({ draw, serverNow: 'now' }),
      listPublic: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      findPublic: jest.fn().mockResolvedValue(draw),
      availability: jest.fn().mockResolvedValue({ items: [] }),
    };
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    adminDraws = {
      list: jest.fn().mockResolvedValue(page),
      create: jest.fn().mockResolvedValue(draw),
      findOne: jest.fn().mockResolvedValue(draw),
      update: jest.fn().mockResolvedValue(draw),
      open: jest.fn().mockResolvedValue(draw),
      pause: jest.fn().mockResolvedValue(draw),
      close: jest.fn().mockResolvedValue(draw),
      reopen: jest.fn().mockResolvedValue(draw),
      setOffSale: jest.fn().mockResolvedValue(draw),
      listTickets: jest.fn().mockResolvedValue(page),
    };
    settings = {
      get: jest.fn().mockResolvedValue({ ticketPrice: 1000 }),
      update: jest.fn().mockResolvedValue({ ticketPrice: 1500 }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        LotteryDrawsController,
        LotteryDrawsAdminController,
        LotterySettingsAdminController,
      ],
      providers: [
        { provide: LotteryDrawsService, useValue: draws },
        { provide: LotteryDrawsAdminService, useValue: adminDraws },
        { provide: LotterySettingsService, useValue: settings },
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

  describe('public draw reads', () => {
    it('serves the current draw, the list and one draw to a guest', async () => {
      await request(app.getHttpServer())
        .get('/lottery/draws/current')
        .expect(200);
      expect(draws.current).toHaveBeenCalledTimes(1);
      expect(draws.findPublic).not.toHaveBeenCalled();

      await request(app.getHttpServer())
        .get('/lottery/draws?page=2&pageSize=5')
        .expect(200);
      expect(draws.listPublic).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 5 }),
      );

      await request(app.getHttpServer()).get('/lottery/draws/24').expect(200);
      expect(draws.findPublic).toHaveBeenCalledWith(24);
    });

    it('400s a non-numeric draw number and a page size over 100', async () => {
      await request(app.getHttpServer()).get('/lottery/draws/abc').expect(400);
      await request(app.getHttpServer())
        .get('/lottery/draws?pageSize=101')
        .expect(400);
      expect(draws.findPublic).not.toHaveBeenCalled();
      expect(draws.listPublic).not.toHaveBeenCalled();
    });

    it('checks availability for a guest (no user) and for a signed-in customer (their user), answering 200', async () => {
      await request(app.getHttpServer())
        .post('/lottery/draws/24/availability')
        .send({ numbers: ['123456'] })
        .expect(200);
      expect(draws.availability).toHaveBeenCalledWith(
        24,
        ['123456'],
        undefined,
      );

      await request(app.getHttpServer())
        .post('/lottery/draws/24/availability')
        .set('x-test-role', Role.USER)
        .send({ numbers: ['123456', '000001'] })
        .expect(200);
      expect(draws.availability).toHaveBeenLastCalledWith(
        24,
        ['123456', '000001'],
        expect.objectContaining({ id: 'staff-1', role: Role.USER }),
      );
    });

    it('400s an availability check with no numbers, a bad number, 51 numbers or an unknown field', async () => {
      const post = () =>
        request(app.getHttpServer()).post('/lottery/draws/24/availability');
      await post().send({}).expect(400);
      await post()
        .send({ numbers: ['12345'] })
        .expect(400);
      await post()
        .send({
          numbers: Array.from({ length: 51 }, (_, i) =>
            String(i).padStart(6, '0'),
          ),
        })
        .expect(400);
      await post()
        .send({ numbers: ['123456'], drawNo: 24 })
        .expect(400);
      expect(draws.availability).not.toHaveBeenCalled();
    });
  });

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
      // A drift between this table and the decorators would make the 403
      // matrix above prove the wrong thing.
      const routesWith = (permission: string) =>
        STAFF_ROUTES.filter((r) => r.permission === permission).map(
          (r) => `${r.method} ${r.path}`,
        );
      expect(routesWith('LOTTERY.VIEW')).toEqual([
        'get /lottery/admin/settings',
        'get /lottery/admin/draws',
        `get ${ADMIN}`,
        `get ${ADMIN}/tickets`,
      ]);
      expect(routesWith('LOTTERY.SETTINGS_MANAGE')).toEqual([
        'patch /lottery/admin/settings',
      ]);
      expect(routesWith('LOTTERY.DRAWS_MANAGE')).toHaveLength(7);
    });
  });

  describe('routing and validation', () => {
    it('passes the admin list filters through with their defaults', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/draws?status=open'),
      ).expect(200);
      expect(adminDraws.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'open', page: 1, pageSize: 20 }),
      );
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/draws?status=selling'),
      ).expect(400);
    });

    it('creates with the actor, and answers 201', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/draws')
          .send({ thaiDrawDate: '2026-11-01', drawNo: 25 }),
      ).expect(201);
      expect(adminDraws.create).toHaveBeenCalledWith(
        expect.objectContaining({ thaiDrawDate: '2026-11-01', drawNo: 25 }),
        expect.objectContaining({ id: 'staff-1', role: Role.ADMIN }),
      );
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/draws')
          .send({ thaiDrawDate: '2026-02-30' }),
      ).expect(400);
    });

    it('answers the status changes with 200 and the id, and 400s a non-uuid id', async () => {
      await asAdmin(request(app.getHttpServer()).post(`${ADMIN}/pause`)).expect(
        200,
      );
      expect(adminDraws.pause).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({ id: 'staff-1' }),
      );
      await asAdmin(
        request(app.getHttpServer()).post(`${ADMIN}/reopen`),
      ).expect(200);
      expect(adminDraws.reopen).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({ id: 'staff-1' }),
      );
      await asAdmin(
        request(app.getHttpServer()).post('/lottery/admin/draws/24/open'),
      ).expect(400);
      expect(adminDraws.open).not.toHaveBeenCalled();
    });

    it('replaces the off-sale list, refusing a repeated number', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .put(`${ADMIN}/off-sale`)
          .send({ numbers: [] }),
      ).expect(200);
      expect(adminDraws.setOffSale).toHaveBeenCalledWith(
        DRAW_ID,
        { numbers: [] },
        expect.anything(),
      );
      await asAdmin(
        request(app.getHttpServer())
          .put(`${ADMIN}/off-sale`)
          .send({ numbers: ['123456', '123456'] }),
      ).expect(400);
    });

    it('pages the ticket list up to 200 and trims the search', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(
          `${ADMIN}/tickets?q=%20LP-%20&pageSize=200`,
        ),
      ).expect(200);
      expect(adminDraws.listTickets).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({ q: 'LP-', page: 1, pageSize: 200 }),
      );
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/tickets?pageSize=201`),
      ).expect(400);
    });

    it('patches the settings with the actor and 400s an out-of-range value', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .patch('/lottery/admin/settings')
          .send({ maxPerNumber: 25, exchangeRate: '80.5' }),
      ).expect(200);
      expect(settings.update).toHaveBeenCalledWith(
        { maxPerNumber: 25, exchangeRate: 80.5 },
        expect.objectContaining({ id: 'staff-1' }),
      );
      await asAdmin(
        request(app.getHttpServer())
          .patch('/lottery/admin/settings')
          .send({ maxPerNumber: 101 }),
      ).expect(400);
    });

    it('passes a frame from images/lottery_frame/ through, clears on null, and 400s a picture or an off-site image as the frame', async () => {
      const frame = 'http://192.168.1.5:9000/movies/images/lottery_frame/f.png';
      await asAdmin(
        request(app.getHttpServer())
          .patch('/lottery/admin/settings')
          .send({ frameUrl: frame }),
      ).expect(200);
      expect(settings.update).toHaveBeenLastCalledWith(
        { frameUrl: frame },
        expect.objectContaining({ id: 'staff-1' }),
      );
      await asAdmin(
        request(app.getHttpServer())
          .patch('/lottery/admin/settings')
          .send({ frameUrl: null }),
      ).expect(200);
      expect(settings.update).toHaveBeenLastCalledWith(
        { frameUrl: null },
        expect.anything(),
      );
      for (const frameUrl of [
        'http://192.168.1.5:9000/movies/images/lottery/picture.png',
        'https://evil.example/frame.png',
      ]) {
        await asAdmin(
          request(app.getHttpServer())
            .patch('/lottery/admin/settings')
            .send({ frameUrl }),
        ).expect(400);
      }
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/draws')
          .send({ thaiDrawDate: '2026-11-01', frameUrl: frame }),
      ).expect(201);
      expect(adminDraws.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ frameUrl: frame }),
        expect.anything(),
      );
      await asAdmin(
        request(app.getHttpServer())
          .patch(`${ADMIN}`)
          .send({ frameUrl: 'https://evil.example/frame.png' }),
      ).expect(400);
    });
  });
});
