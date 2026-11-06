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
import { Role } from '../../generated/prisma/client';
import { IS_AUTH_OPTIONAL_KEY } from '../../common/decorators/optional-auth.decorator';
import { PermissionResolverService } from '../../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../../test/seeded-permission-resolver';
import { LotteryClaimsAdminController } from './lottery-claims-admin.controller';
import { LotteryClaimsAdminService } from './lottery-claims-admin.service';
import { LotteryClaimsController } from './lottery-claims.controller';
import { LotteryClaimsService } from './lottery-claims.service';

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
    req.user = { id: 'caller-1', username: 'caller', role, appRoleId: null };
    return true;
  }
}

const CLAIM_ID = '77777777-7777-4777-8777-777777777777';
const DRAW_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = '/lottery/admin/claims';

/** Every staff route, with a request that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'post';
  path: string;
  body?: Record<string, unknown>;
  permission: 'LOTTERY.VIEW' | 'LOTTERY.CLAIMS_CONFIRM';
}> = [
  { method: 'get', path: ADMIN, permission: 'LOTTERY.VIEW' },
  { method: 'get', path: `${ADMIN}/summary`, permission: 'LOTTERY.VIEW' },
  { method: 'get', path: `${ADMIN}/${CLAIM_ID}`, permission: 'LOTTERY.VIEW' },
  {
    method: 'post',
    path: `${ADMIN}/${CLAIM_ID}/confirm`,
    permission: 'LOTTERY.CLAIMS_CONFIRM',
  },
  {
    method: 'post',
    path: `${ADMIN}/${CLAIM_ID}/reject`,
    body: { reason: 'duplicate_request' },
    permission: 'LOTTERY.CLAIMS_CONFIRM',
  },
  {
    method: 'post',
    path: `${ADMIN}/${CLAIM_ID}/reopen`,
    permission: 'LOTTERY.CLAIMS_CONFIRM',
  },
];

describe('LotteryClaimsController + LotteryClaimsAdminController', () => {
  let app: INestApplication<App>;
  let claims: Record<'drawView' | 'listMine' | 'request', jest.Mock>;
  let adminClaims: Record<
    'list' | 'summary' | 'detail' | 'confirm' | 'reject' | 'reopen',
    jest.Mock
  >;

  beforeAll(async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 25 };
    claims = {
      drawView: jest.fn().mockResolvedValue({ drawNo: 24, status: 'none' }),
      listMine: jest.fn().mockResolvedValue({ ...page, pageSize: 20 }),
      request: jest.fn().mockResolvedValue({ drawNo: 24, status: 'requested' }),
    };
    adminClaims = {
      list: jest.fn().mockResolvedValue(page),
      summary: jest
        .fn()
        .mockResolvedValue({ waiting: { claims: 0, ks: '0.00' } }),
      detail: jest
        .fn()
        .mockResolvedValue({ id: CLAIM_ID, status: 'requested' }),
      confirm: jest.fn().mockResolvedValue({ id: CLAIM_ID, status: 'paid' }),
      reject: jest.fn().mockResolvedValue({ id: CLAIM_ID, status: 'rejected' }),
      reopen: jest
        .fn()
        .mockResolvedValue({ id: CLAIM_ID, status: 'requested' }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LotteryClaimsController, LotteryClaimsAdminController],
      providers: [
        { provide: LotteryClaimsService, useValue: claims },
        { provide: LotteryClaimsAdminService, useValue: adminClaims },
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

  const as = (role: Role) => (test: request.Test) =>
    test.set('x-test-role', role);
  const asAdmin = as(Role.ADMIN);
  const asUser = as(Role.USER);

  describe('customer routes', () => {
    it('are signed-in only: 401 without a token, open to a plain USER, scoped to the caller', async () => {
      await request(app.getHttpServer()).get('/lottery/claims').expect(401);
      await request(app.getHttpServer())
        .get('/lottery/claims/draws/24')
        .expect(401);
      await request(app.getHttpServer())
        .post('/lottery/claims')
        .send({ drawNo: 24 })
        .expect(401);

      await asUser(request(app.getHttpServer()).get('/lottery/claims')).expect(
        200,
      );
      expect(claims.listMine).toHaveBeenCalledWith('caller-1', {
        page: 1,
        pageSize: 20,
      });

      await asUser(
        request(app.getHttpServer()).get('/lottery/claims/draws/24'),
      ).expect(200);
      expect(claims.drawView).toHaveBeenCalledWith('caller-1', 24);
    });

    it('POST /lottery/claims answers 201 with the draw’s claim view, and 400s a bad or missing draw number', async () => {
      const res = await asUser(
        request(app.getHttpServer())
          .post('/lottery/claims')
          .send({ drawNo: 24 }),
      ).expect(201);
      expect(res.body).toEqual({ drawNo: 24, status: 'requested' });
      expect(claims.request).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'caller-1', role: Role.USER }),
        { drawNo: 24 },
      );

      for (const body of [
        {},
        { drawNo: 0 },
        { drawNo: 'abc' },
        { drawNo: 24, ticketNo: 'x' },
      ]) {
        await asUser(
          request(app.getHttpServer()).post('/lottery/claims').send(body),
        ).expect(400);
      }
      expect(claims.request).toHaveBeenCalledTimes(1);
    });

    it('400s a draw number that is not an integer, and caps the list page size', async () => {
      await asUser(
        request(app.getHttpServer()).get('/lottery/claims/draws/abc'),
      ).expect(400);
      await asUser(
        request(app.getHttpServer()).get('/lottery/claims?pageSize=101'),
      ).expect(400);
      expect(claims.drawView).not.toHaveBeenCalled();
      expect(claims.listMine).not.toHaveBeenCalled();
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
      const routesWith = (permission: string) =>
        STAFF_ROUTES.filter((r) => r.permission === permission).map(
          (r) => `${r.method} ${r.path}`,
        );
      expect(routesWith('LOTTERY.VIEW')).toEqual([
        `get ${ADMIN}`,
        `get ${ADMIN}/summary`,
        `get ${ADMIN}/${CLAIM_ID}`,
      ]);
      expect(routesWith('LOTTERY.CLAIMS_CONFIRM')).toEqual([
        `post ${ADMIN}/${CLAIM_ID}/confirm`,
        `post ${ADMIN}/${CLAIM_ID}/reject`,
        `post ${ADMIN}/${CLAIM_ID}/reopen`,
      ]);
    });

    it('never lets a signed-in customer at the list, the tiles, a claim or a decision', async () => {
      for (const route of STAFF_ROUTES) {
        await call(route, Role.USER).expect(403);
      }
      for (const fn of Object.values(adminClaims)) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  describe('staff routing and validation', () => {
    it('lists with the defaults, passes a full query through, and 400s a bad tab, draw or page size', async () => {
      await asAdmin(request(app.getHttpServer()).get(ADMIN)).expect(200);
      expect(adminClaims.list).toHaveBeenCalledWith({
        status: 'requested',
        page: 1,
        pageSize: 25,
      });

      await asAdmin(
        request(app.getHttpServer()).get(
          `${ADMIN}?status=not_requested&drawId=${DRAW_ID}&q=%20mya%20&page=2&pageSize=100`,
        ),
      ).expect(200);
      expect(adminClaims.list).toHaveBeenLastCalledWith({
        status: 'not_requested',
        drawId: DRAW_ID,
        q: 'mya',
        page: 2,
        pageSize: 100,
      });

      for (const query of [
        'status=waiting',
        'drawId=24',
        'pageSize=101',
        'page=0',
        'userId=u',
      ]) {
        await asAdmin(
          request(app.getHttpServer()).get(`${ADMIN}?${query}`),
        ).expect(400);
      }
      expect(adminClaims.list).toHaveBeenCalledTimes(2);
    });

    it('"summary" is a route of its own, not a claim id, for every draw or one', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/summary`),
      ).expect(200);
      expect(adminClaims.summary).toHaveBeenCalledWith(undefined);
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/summary?drawId=${DRAW_ID}`),
      ).expect(200);
      expect(adminClaims.summary).toHaveBeenLastCalledWith(DRAW_ID);
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/summary?drawId=24`),
      ).expect(400);
      expect(adminClaims.detail).not.toHaveBeenCalled();
    });

    it('reads one claim by uuid and 400s anything else', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/${CLAIM_ID}`),
      ).expect(200);
      expect(adminClaims.detail).toHaveBeenCalledWith(CLAIM_ID);
      await asAdmin(
        request(app.getHttpServer()).get(`${ADMIN}/claim-1`),
      ).expect(400);
      expect(adminClaims.detail).toHaveBeenCalledTimes(1);
    });

    it('confirm and reopen answer 200 with the detail and hand the actor to the service', async () => {
      const confirmed = await asAdmin(
        request(app.getHttpServer()).post(`${ADMIN}/${CLAIM_ID}/confirm`),
      ).expect(200);
      expect(confirmed.body).toEqual({ id: CLAIM_ID, status: 'paid' });
      expect(adminClaims.confirm).toHaveBeenCalledWith(
        CLAIM_ID,
        expect.objectContaining({ id: 'caller-1', role: Role.ADMIN }),
      );

      await asAdmin(
        request(app.getHttpServer()).post(`${ADMIN}/${CLAIM_ID}/reopen`),
      ).expect(200);
      expect(adminClaims.reopen).toHaveBeenCalledWith(
        CLAIM_ID,
        expect.objectContaining({ id: 'caller-1' }),
      );

      await asAdmin(
        request(app.getHttpServer()).post(`${ADMIN}/claim-1/confirm`),
      ).expect(400);
      expect(adminClaims.confirm).toHaveBeenCalledTimes(1);
    });

    it('reject validates the reason and requires a note for "other"', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .post(`${ADMIN}/${CLAIM_ID}/reject`)
          .send({ reason: 'other', note: '  Ticket photo does not match ' }),
      ).expect(200);
      expect(adminClaims.reject).toHaveBeenCalledWith(
        CLAIM_ID,
        { reason: 'other', note: 'Ticket photo does not match' },
        expect.objectContaining({ id: 'caller-1' }),
      );

      await asAdmin(
        request(app.getHttpServer())
          .post(`${ADMIN}/${CLAIM_ID}/reject`)
          .send({ reason: 'suspicious_account' }),
      ).expect(200);
      expect(adminClaims.reject).toHaveBeenLastCalledWith(
        CLAIM_ID,
        { reason: 'suspicious_account' },
        expect.anything(),
      );

      for (const body of [
        {},
        { reason: 'fraud' },
        { reason: 'other' },
        { reason: 'other', note: '   ' },
        { reason: 'other', note: 'x'.repeat(301) },
        { reason: 'duplicate_request', refund: true },
      ]) {
        await asAdmin(
          request(app.getHttpServer())
            .post(`${ADMIN}/${CLAIM_ID}/reject`)
            .send(body),
        ).expect(400);
      }
      expect(adminClaims.reject).toHaveBeenCalledTimes(2);
    });
  });
});
