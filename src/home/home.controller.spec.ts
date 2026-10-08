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
import { HomeController } from './home.controller';
import { HomePromosService } from './home-promos.service';
import { HomeShowcaseService } from './home-showcase.service';

/**
 * Stands in for the global JwtAuthGuard, @OptionalAuth included: the test
 * supplies a role via `x-test-role`; absent = no token = 401, except on an
 * @OptionalAuth route, which passes as a guest with no `req.user`. The real
 * PermissionsGuard then runs against the real seeded permission sets.
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

const PROMO_ID = '11111111-1111-4111-8111-111111111111';

const VALID_CREATE = {
  kind: 'HERO',
  titleEn: 'Go Premium',
  titleMm: 'Premium ယူပါ',
  ctaTarget: 'SUBSCRIBE',
  ctaLabelEn: 'Subscribe',
  ctaLabelMm: 'စာရင်းသွင်းပါ',
};

/** Every staff route with a body that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  permission: 'HOME.VIEW' | 'HOME.MANAGE';
}> = [
  { method: 'get', path: '/home/promos', permission: 'HOME.VIEW' },
  { method: 'get', path: `/home/promos/${PROMO_ID}`, permission: 'HOME.VIEW' },
  {
    method: 'post',
    path: '/home/promos',
    body: VALID_CREATE,
    permission: 'HOME.MANAGE',
  },
  {
    method: 'patch',
    path: '/home/promos/reorder',
    body: { kind: 'HERO', ids: [PROMO_ID] },
    permission: 'HOME.MANAGE',
  },
  {
    method: 'patch',
    path: `/home/promos/${PROMO_ID}`,
    body: { titleEn: 'x' },
    permission: 'HOME.MANAGE',
  },
  {
    method: 'delete',
    path: `/home/promos/${PROMO_ID}`,
    permission: 'HOME.MANAGE',
  },
  { method: 'get', path: '/home/settings', permission: 'HOME.VIEW' },
  {
    method: 'put',
    path: '/home/settings',
    body: { gamesTeaserEnabled: true },
    permission: 'HOME.MANAGE',
  },
];

describe('HomeController', () => {
  let app: INestApplication<App>;
  let showcase: { getShowcase: jest.Mock };
  let promos: Record<
    | 'list'
    | 'findOne'
    | 'create'
    | 'update'
    | 'remove'
    | 'reorder'
    | 'getSettings'
    | 'updateSettings',
    jest.Mock
  >;

  // One app for the whole file (it is ~50 HTTP cases); only the mocks'
  // call records are reset between cases.
  beforeAll(async () => {
    showcase = {
      getShowcase: jest.fn().mockResolvedValue({
        hero: [],
        spotlight: null,
        comingSoon: [],
        settings: {},
      }),
    };
    promos = {
      list: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ id: PROMO_ID }),
      create: jest.fn().mockResolvedValue({ id: PROMO_ID }),
      update: jest.fn().mockResolvedValue({ id: PROMO_ID }),
      remove: jest.fn().mockResolvedValue(undefined),
      reorder: jest.fn().mockResolvedValue([]),
      getSettings: jest.fn().mockResolvedValue({}),
      updateSettings: jest.fn().mockResolvedValue({}),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HomeController],
      providers: [
        { provide: HomeShowcaseService, useValue: showcase },
        { provide: HomePromosService, useValue: promos },
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

  describe('GET /home/showcase (public)', () => {
    it('answers a guest, telling the service nobody is signed in', async () => {
      await request(app.getHttpServer()).get('/home/showcase').expect(200);
      expect(showcase.getShowcase).toHaveBeenCalledWith(false);
    });

    it.each([Role.USER, Role.ADMIN])(
      'answers a signed-in %s as signed in (books may show)',
      async (role) => {
        await request(app.getHttpServer())
          .get('/home/showcase')
          .set('x-test-role', role)
          .expect(200);
        expect(showcase.getShowcase).toHaveBeenCalledWith(true);
      },
    );
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
      expect(
        STAFF_ROUTES.filter((r) => r.permission === 'HOME.VIEW').map(
          (r) => `${r.method} ${r.path}`,
        ),
      ).toEqual([
        'get /home/promos',
        `get /home/promos/${PROMO_ID}`,
        'get /home/settings',
      ]);
    });
  });

  describe('routing and validation', () => {
    const asAdmin = (test: request.Test) => test.set('x-test-role', Role.ADMIN);

    it('passes the kind filter and the acting staff member through', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/home/promos?kind=COMING_SOON'),
      ).expect(200);
      expect(promos.list).toHaveBeenCalledWith('COMING_SOON');

      await asAdmin(
        request(app.getHttpServer()).post('/home/promos').send(VALID_CREATE),
      ).expect(201);
      expect(promos.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'HERO', titleEn: 'Go Premium' }),
        expect.objectContaining({ id: 'staff-1', role: Role.ADMIN }),
      );
    });

    it('routes /home/promos/reorder to reorder, not to the :id update', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .patch('/home/promos/reorder')
          .send({ kind: 'HERO', ids: [PROMO_ID] }),
      ).expect(200);
      expect(promos.reorder).toHaveBeenCalled();
      expect(promos.update).not.toHaveBeenCalled();
    });

    it('DELETE answers 204 with no body', async () => {
      const res = await asAdmin(
        request(app.getHttpServer()).delete(`/home/promos/${PROMO_ID}`),
      ).expect(204);
      expect(res.text).toBe('');
      expect(promos.remove).toHaveBeenCalledWith(
        PROMO_ID,
        expect.objectContaining({ id: 'staff-1' }),
      );
    });

    it('400s a non-UUID id, an unknown field and a bad body before the service runs', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/home/promos/not-a-uuid'),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer())
          .post('/home/promos')
          .send({ ...VALID_CREATE, createdById: 'someone-else' }),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer())
          .put('/home/settings')
          .send({ gamesTeaserEnabled: true, webUrl: 'javascript:alert(1)' }),
      ).expect(400);
      expect(promos.findOne).not.toHaveBeenCalled();
      expect(promos.create).not.toHaveBeenCalled();
      expect(promos.updateSettings).not.toHaveBeenCalled();
    });
  });
});
