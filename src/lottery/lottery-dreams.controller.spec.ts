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
import { XLSX_MIME_TYPE } from './dream-sheet';
import { LotteryDreamsAdminController } from './lottery-dreams-admin.controller';
import { LotteryDreamsController } from './lottery-dreams.controller';
import { LotteryDreamsService } from './lottery-dreams.service';

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

const DREAM_ID = '11111111-1111-4111-8111-111111111111';
const OWN_IMAGE = 'http://192.168.1.5:9000/movies/images/lottery/abc.webp';
const CSV = Buffer.from('book,number,name_en\n1000,27,Snake\n');

/** Every staff route, with a request that passes validation. */
const STAFF_ROUTES: Array<{
  method: 'get' | 'patch' | 'post';
  path: string;
  body?: Record<string, unknown>;
  file?: boolean;
  permission: 'LOTTERY.VIEW' | 'LOTTERY.DREAMS_MANAGE';
}> = [
  { method: 'get', path: '/lottery/admin/dreams', permission: 'LOTTERY.VIEW' },
  {
    method: 'get',
    path: '/lottery/admin/dreams/export?book=1000',
    permission: 'LOTTERY.VIEW',
  },
  {
    method: 'patch',
    path: `/lottery/admin/dreams/${DREAM_ID}`,
    body: { nameEn: 'Snake' },
    permission: 'LOTTERY.DREAMS_MANAGE',
  },
  {
    method: 'post',
    path: '/lottery/admin/dreams/import',
    file: true,
    permission: 'LOTTERY.DREAMS_MANAGE',
  },
];

/** Collects a binary body supertest would otherwise discard. */
const binaryParser = (
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('LotteryDreams controllers', () => {
  let app: INestApplication<App>;
  let dreams: Record<
    'listPublic' | 'findPublic' | 'listAdmin' | 'update' | 'import' | 'export',
    jest.Mock
  >;

  beforeAll(async () => {
    dreams = {
      listPublic: jest.fn().mockResolvedValue({ items: [] }),
      findPublic: jest.fn().mockResolvedValue({ id: DREAM_ID }),
      listAdmin: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 }),
      update: jest.fn().mockResolvedValue({ id: DREAM_ID }),
      import: jest
        .fn()
        .mockResolvedValue({ total: 1, updated: 1, unchanged: 0, errors: [] }),
      export: jest.fn().mockResolvedValue(Buffer.from('PK\u0003\u0004xlsx')),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [LotteryDreamsController, LotteryDreamsAdminController],
      providers: [
        { provide: LotteryDreamsService, useValue: dreams },
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
    if (route.file) test = test.attach('file', CSV, 'dreams.csv');
    return test;
  };

  const asAdmin = (test: request.Test) => test.set('x-test-role', Role.ADMIN);

  describe('public dream reads', () => {
    it('lists one book for a guest', async () => {
      await request(app.getHttpServer())
        .get('/lottery/dreams?book=100&q=%20sn%20')
        .expect(200);
      expect(dreams.listPublic).toHaveBeenCalledWith(
        expect.objectContaining({ book: '100', q: 'sn' }),
      );
    });

    it('answers a signed-in user the same way', async () => {
      await request(app.getHttpServer())
        .get('/lottery/dreams?book=1000')
        .set('x-test-role', Role.USER)
        .expect(200);
      expect(dreams.listPublic).toHaveBeenCalledTimes(1);
    });

    it('400s a missing or unknown book and an unknown field', async () => {
      await request(app.getHttpServer()).get('/lottery/dreams').expect(400);
      await request(app.getHttpServer())
        .get('/lottery/dreams?book=10')
        .expect(400);
      await request(app.getHttpServer())
        .get('/lottery/dreams?book=100&filter=inactive')
        .expect(400);
      expect(dreams.listPublic).not.toHaveBeenCalled();
    });

    it('reads one dream by book and number for a guest', async () => {
      await request(app.getHttpServer())
        .get('/lottery/dreams/1000/27')
        .expect(200);
      expect(dreams.findPublic).toHaveBeenCalledWith('1000', '27');
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
      expect(
        STAFF_ROUTES.filter((r) => r.permission === 'LOTTERY.VIEW').map(
          (r) => `${r.method} ${r.path}`,
        ),
      ).toEqual([
        'get /lottery/admin/dreams',
        'get /lottery/admin/dreams/export?book=1000',
      ]);
    });
  });

  describe('routing and validation', () => {
    it('passes the list query through with its defaults', async () => {
      await asAdmin(
        request(app.getHttpServer()).get(
          '/lottery/admin/dreams?book=100&filter=missing_name&q=sn',
        ),
      ).expect(200);
      expect(dreams.listAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          book: '100',
          filter: 'missing_name',
          q: 'sn',
          page: 1,
          pageSize: 50,
        }),
      );
    });

    it('400s a page size over 100, an unknown filter and an unknown field', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/dreams?pageSize=101'),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/dreams?filter=named'),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/dreams?limit=10'),
      ).expect(400);
      expect(dreams.listAdmin).not.toHaveBeenCalled();
    });

    it('sends the export as an .xlsx download', async () => {
      const res = await asAdmin(
        request(app.getHttpServer()).get(
          '/lottery/admin/dreams/export?book=100',
        ),
      )
        .buffer()
        .parse(binaryParser)
        .expect(200);

      expect(dreams.export).toHaveBeenCalledWith('100');
      expect(res.headers['content-type']).toContain(XLSX_MIME_TYPE);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="dreams-100.xlsx"',
      );
      expect((res.body as Buffer).toString()).toBe('PK\u0003\u0004xlsx');
    });

    it('400s an export without a book', async () => {
      await asAdmin(
        request(app.getHttpServer()).get('/lottery/admin/dreams/export'),
      ).expect(400);
      expect(dreams.export).not.toHaveBeenCalled();
    });

    it('trims the patch, turns a blank into null and names the acting staff member', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .patch(`/lottery/admin/dreams/${DREAM_ID}`)
          .send({
            nameEn: ' Snake ',
            nameMy: '',
            pictureUrl: OWN_IMAGE,
            isActive: 'false',
          }),
      ).expect(200);
      expect(dreams.update).toHaveBeenCalledWith(
        DREAM_ID,
        {
          nameEn: 'Snake',
          nameMy: null,
          pictureUrl: OWN_IMAGE,
          isActive: false,
        },
        expect.objectContaining({ id: 'staff-1', role: Role.ADMIN }),
      );
    });

    it('400s a non-UUID id, an off-site picture, a null switch and an unknown field', async () => {
      const patch = (id: string, body: Record<string, unknown>) =>
        asAdmin(
          request(app.getHttpServer())
            .patch(`/lottery/admin/dreams/${id}`)
            .send(body),
        );
      await patch('not-a-uuid', { nameEn: 'x' }).expect(400);
      await patch(DREAM_ID, {
        pictureUrl: 'https://evil.example/beacon.gif',
      }).expect(400);
      await patch(DREAM_ID, { isActive: null }).expect(400);
      await patch(DREAM_ID, { number: '028' }).expect(400);
      expect(dreams.update).not.toHaveBeenCalled();
    });

    it('hands the spreadsheet, its name and the dry-run flag to the service', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/dreams/import?dryRun=true')
          .attach('file', CSV, 'names.csv'),
      ).expect(201);
      expect(dreams.import).toHaveBeenCalledWith(
        CSV,
        'names.csv',
        true,
        expect.objectContaining({ id: 'staff-1' }),
      );

      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/dreams/import')
          .attach('file', CSV, 'names.csv'),
      ).expect(201);
      expect(dreams.import).toHaveBeenLastCalledWith(
        CSV,
        'names.csv',
        false,
        expect.anything(),
      );
    });

    it('413s a file over the import cap before the service sees it', async () => {
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/dreams/import')
          .attach('file', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), 'big.csv'),
      ).expect(413);
      expect(dreams.import).not.toHaveBeenCalled();
    });

    it('400s an import with no file or a dryRun that is not a boolean', async () => {
      await asAdmin(
        request(app.getHttpServer()).post('/lottery/admin/dreams/import'),
      ).expect(400);
      await asAdmin(
        request(app.getHttpServer())
          .post('/lottery/admin/dreams/import?dryRun=maybe')
          .attach('file', CSV, 'names.csv'),
      ).expect(400);
      expect(dreams.import).not.toHaveBeenCalled();
    });
  });
});
