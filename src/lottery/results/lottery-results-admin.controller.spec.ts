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
import { sheetInputs } from '../../../test/lottery-fixtures';
import { LotterySettingsAdminController } from '../lottery-settings-admin.controller';
import { LotterySettingsService } from '../lottery-settings.service';
import { LotteryResultsAdminController } from './lottery-results-admin.controller';
import { LotteryResultsService } from './lottery-results.service';

/** The same stand-in for the global JwtAuthGuard as the draws controller spec. */
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
const RESULTS = `/lottery/admin/draws/${DRAW_ID}/results`;

/** A body that passes validation: the full sheet from the fixtures. */
const sheetBody = () => ({
  groups: sheetInputs().map((group) => ({
    key: group.key,
    baht: group.baht,
    numbers: [...group.numbers],
  })),
});

/** Every staff route, with a request that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'put' | 'post';
  path: string;
  body?: Record<string, unknown>;
  permission: 'LOTTERY.VIEW' | 'LOTTERY.RESULTS_PUBLISH';
}> = [
  { method: 'get', path: RESULTS, permission: 'LOTTERY.VIEW' },
  {
    method: 'put',
    path: RESULTS,
    body: sheetBody(),
    permission: 'LOTTERY.RESULTS_PUBLISH',
  },
  {
    method: 'post',
    path: `${RESULTS}/fetch`,
    permission: 'LOTTERY.RESULTS_PUBLISH',
  },
  {
    method: 'get',
    path: '/lottery/admin/settings/results-test',
    permission: 'LOTTERY.RESULTS_PUBLISH',
  },
];

describe('LotteryResultsAdminController', () => {
  let app: INestApplication<App>;
  let results: Record<'get' | 'enter' | 'fetchNow' | 'testSource', jest.Mock>;
  let settings: Record<'get' | 'update', jest.Mock>;

  beforeAll(async () => {
    const view = { drawId: DRAW_ID, status: 'pending', groups: [] };
    results = {
      get: jest.fn().mockResolvedValue(view),
      enter: jest.fn().mockResolvedValue({ ...view, status: 'fetched' }),
      fetchNow: jest.fn().mockResolvedValue({ ...view, status: 'fetched' }),
      testSource: jest.fn().mockResolvedValue({ ok: true }),
    };
    settings = {
      get: jest.fn().mockResolvedValue({ resultsUrl: null }),
      update: jest.fn().mockResolvedValue({ resultsUrl: 'https://x' }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [
        LotteryResultsAdminController,
        LotterySettingsAdminController,
      ],
      providers: [
        { provide: LotteryResultsService, useValue: results },
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
      expect(routesWith('LOTTERY.VIEW')).toEqual([`get ${RESULTS}`]);
      expect(routesWith('LOTTERY.RESULTS_PUBLISH')).toEqual([
        `put ${RESULTS}`,
        `post ${RESULTS}/fetch`,
        'get /lottery/admin/settings/results-test',
      ]);
    });
  });

  describe('routing and validation', () => {
    it("reads a draw's results by id and 400s a non-uuid id", async () => {
      await asAdmin(request(app.getHttpServer()).get(RESULTS)).expect(200);
      expect(results.get).toHaveBeenCalledWith(DRAW_ID);
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/draws/24/results'),
      ).expect(400);
    });

    it('enters a sheet with the actor, trimming the numbers and reading a numeric string as Baht; answers 200', async () => {
      const body = sheetBody();
      body.groups[8] = {
        key: 'back2',
        baht: '2000' as never,
        numbers: [' 56 '],
      };
      await asAdmin(
        request(app.getHttpServer())
          .put(RESULTS)
          .send({ ...body, note: ' x ' }),
      ).expect(200);
      expect(results.enter).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({
          note: 'x',
          groups: expect.arrayContaining([
            expect.objectContaining({
              key: 'back2',
              baht: 2000,
              numbers: ['56'],
            }),
          ]),
        }),
        expect.objectContaining({ id: 'staff-1', role: Role.ADMIN }),
      );
    });

    it('400s a sheet with eight groups, an unknown key, a letter in a number, a negative prize, an unknown field or a long note', async () => {
      const put = () => asAdmin(request(app.getHttpServer()).put(RESULTS));
      const eight = sheetBody();
      eight.groups.pop();
      await put().send(eight).expect(400);

      const badKey = sheetBody();
      badKey.groups[0].key = 'sixth' as never;
      await put().send(badKey).expect(400);

      const letter = sheetBody();
      letter.groups[8].numbers = ['5a'];
      await put().send(letter).expect(400);

      const negative = sheetBody();
      negative.groups[0].baht = -1;
      await put().send(negative).expect(400);

      const extra = sheetBody();
      (extra.groups[0] as Record<string, unknown>).name = 'First';
      await put().send(extra).expect(400);

      await put()
        .send({ ...sheetBody(), note: 'x'.repeat(501) })
        .expect(400);

      await put().send({}).expect(400);
      expect(results.enter).not.toHaveBeenCalled();
    });

    it('fetches now with the actor and answers 200', async () => {
      await asAdmin(
        request(app.getHttpServer()).post(`${RESULTS}/fetch`),
      ).expect(200);
      expect(results.fetchNow).toHaveBeenCalledWith(
        DRAW_ID,
        expect.objectContaining({ id: 'staff-1' }),
      );
    });

    it('tests the source', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(
          '/lottery/admin/settings/results-test',
        ),
      ).expect(200);
      expect(results.testSource).toHaveBeenCalledTimes(1);
      expect(settings.get).not.toHaveBeenCalled();
    });

    it('patches the results URL on the settings: http(s) only, null clears', async () => {
      const patch = () =>
        asAdmin(request(app.getHttpServer()).patch('/lottery/admin/settings'));
      await patch()
        .send({ resultsUrl: ' https://lotto.example/{date} ' })
        .expect(200);
      expect(settings.update).toHaveBeenCalledWith(
        { resultsUrl: 'https://lotto.example/{date}' },
        expect.anything(),
      );
      await patch().send({ resultsUrl: null }).expect(200);
      expect(settings.update).toHaveBeenLastCalledWith(
        { resultsUrl: null },
        expect.anything(),
      );
      await patch().send({ resultsUrl: '' }).expect(200);
      expect(settings.update).toHaveBeenLastCalledWith(
        { resultsUrl: null },
        expect.anything(),
      );
      await patch().send({ resultsUrl: 'ftp://lotto.example' }).expect(400);
      await patch().send({ resultsUrl: 'lotto.example' }).expect(400);
      await patch().send({ resultsUrl: 'https://a b' }).expect(400);
      await patch()
        .send({ resultsUrl: `https://x/${'a'.repeat(1000)}` })
        .expect(400);
    });
  });
});
