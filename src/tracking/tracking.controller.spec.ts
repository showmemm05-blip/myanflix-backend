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
import {
  ClientPlatform,
  CommentStatus,
  FeedbackStatus,
  Role,
} from '../generated/prisma/client';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import type { Permission } from '../roles/permission-catalogue';
import {
  createRoleAwarePermissionResolver,
  seededRoleRow,
} from '../../test/seeded-permission-resolver';
import { TrackingController } from './tracking.controller';
import { TrackingReadService } from './tracking-read.service';

const UUID = '11111111-1111-4111-8111-111111111111';

/**
 * Stands in for the global JwtAuthGuard with the same contract as the rest of
 * the suite's controller specs: `x-test-role` names the caller's account kind
 * and `x-test-app-role` (optional) names a custom AppRole id, so the real
 * PermissionsGuard below runs unmocked against a realistic subject.
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

    req.user = {
      id: 'staff-1',
      username: 'operator',
      role,
      appRoleId: req.headers['x-test-app-role'] ?? null,
    };
    return true;
  }
}

/** Every route in the controller, with the permissions it must demand. */
const ROUTES: {
  name: string;
  method: 'get' | 'patch';
  path: string;
  requires: Permission[];
  body?: Record<string, unknown>;
  handler: keyof TrackingReadService;
}[] = [
  {
    name: 'GET /tracking/comments',
    method: 'get',
    path: '/tracking/comments',
    requires: ['TRACKING.VIEW'],
    handler: 'comments',
  },
  {
    name: 'PATCH /tracking/comments/:id',
    method: 'patch',
    path: `/tracking/comments/${UUID}`,
    requires: ['TRACKING.VIEW', 'TRACKING.COMMENTS_MODERATE'],
    body: { status: CommentStatus.HIDDEN },
    handler: 'moderateComment',
  },
  {
    name: 'GET /tracking/feedback',
    method: 'get',
    path: '/tracking/feedback',
    requires: ['TRACKING.VIEW'],
    handler: 'feedback',
  },
  {
    name: 'PATCH /tracking/feedback/:id',
    method: 'patch',
    path: `/tracking/feedback/${UUID}`,
    requires: ['TRACKING.VIEW', 'TRACKING.FEEDBACK_MANAGE'],
    body: { status: FeedbackStatus.RESOLVED },
    handler: 'updateFeedbackStatus',
  },
  {
    name: 'GET /tracking/active-users',
    method: 'get',
    path: '/tracking/active-users',
    requires: ['TRACKING.VIEW'],
    handler: 'activeUsers',
  },
  {
    name: 'GET /tracking/watch-time',
    method: 'get',
    path: '/tracking/watch-time',
    requires: ['TRACKING.VIEW'],
    handler: 'watchTime',
  },
  {
    name: 'GET /tracking/searches',
    method: 'get',
    path: '/tracking/searches',
    requires: ['TRACKING.VIEW'],
    handler: 'topSearches',
  },
  {
    name: 'GET /tracking/searches/recent',
    method: 'get',
    path: '/tracking/searches/recent',
    requires: ['TRACKING.VIEW'],
    handler: 'recentSearches',
  },
  {
    name: 'GET /tracking/sessions',
    method: 'get',
    path: '/tracking/sessions',
    requires: ['TRACKING.VIEW'],
    handler: 'sessions',
  },
  {
    name: 'GET /tracking/sessions/:userId',
    method: 'get',
    path: `/tracking/sessions/${UUID}`,
    requires: ['TRACKING.VIEW'],
    handler: 'userSessions',
  },
];

const EMPTY_PAGE = { items: [], total: 0, page: 1, limit: 20 };

describe('TrackingController', () => {
  let app: INestApplication<App>;
  let service: Record<keyof TrackingReadService, jest.Mock>;

  const call = (
    route: (typeof ROUTES)[number],
    role: string,
    appRoleId?: string,
  ) => {
    const agent =
      route.method === 'get'
        ? request(app.getHttpServer()).get(route.path)
        : request(app.getHttpServer()).patch(route.path).send(route.body ?? {});
    const withRole = agent.set('x-test-role', role);
    return appRoleId ? withRole.set('x-test-app-role', appRoleId) : withRole;
  };

  beforeEach(async () => {
    service = {
      comments: jest.fn().mockResolvedValue(EMPTY_PAGE),
      moderateComment: jest
        .fn()
        .mockResolvedValue({ id: UUID, status: CommentStatus.HIDDEN }),
      feedback: jest.fn().mockResolvedValue(EMPTY_PAGE),
      updateFeedbackStatus: jest.fn().mockResolvedValue({ id: UUID }),
      activeUsers: jest
        .fn()
        .mockResolvedValue({
          ...EMPTY_PAGE,
          summary: { total: 0, web: 0, mobile: 0 },
        }),
      watchTime: jest.fn().mockResolvedValue({
        byHour: [],
        byWeekday: [],
        heatmap: [],
        peak: null,
        totals: { web: 0, mobile: 0, unknown: 0, total: 0, heartbeats: 0 },
      }),
      topSearches: jest.fn().mockResolvedValue(EMPTY_PAGE),
      recentSearches: jest.fn().mockResolvedValue(EMPTY_PAGE),
      sessions: jest.fn().mockResolvedValue(EMPTY_PAGE),
      userSessions: jest.fn().mockResolvedValue(EMPTY_PAGE),
    } as unknown as Record<keyof TrackingReadService, jest.Mock>;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        { provide: TrackingReadService, useValue: service },
        {
          // The real PermissionsGuard runs against these — the seeded system
          // roles plus two custom roles that carve TRACKING up the way a real
          // operator would.
          provide: PermissionResolverService,
          useValue: createRoleAwarePermissionResolver([
            seededRoleRow(Role.SUPER_ADMIN),
            seededRoleRow(Role.ADMIN),
            seededRoleRow(Role.CONTENT_UPLOADER),
            seededRoleRow(Role.USER),
            {
              id: 'role-read-only',
              key: 'TRACKING_READ_ONLY',
              permissions: ['TRACKING.VIEW'],
            },
            {
              id: 'role-no-tracking',
              key: 'SUPPORT',
              permissions: ['USERS.VIEW'],
            },
          ]),
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

  describe('every route is gated', () => {
    it.each(ROUTES)('$name rejects an unauthenticated caller', async (route) => {
      const agent =
        route.method === 'get'
          ? request(app.getHttpServer()).get(route.path)
          : request(app.getHttpServer())
              .patch(route.path)
              .send(route.body ?? {});
      await agent.expect(401);
      expect(service[route.handler]).not.toHaveBeenCalled();
    });

    it.each(ROUTES)(
      '$name rejects a signed-in USER (no TRACKING permission)',
      async (route) => {
        await call(route, Role.USER).expect(403);
        expect(service[route.handler]).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTES)('$name rejects CONTENT_UPLOADER', async (route) => {
      await call(route, Role.CONTENT_UPLOADER).expect(403);
      expect(service[route.handler]).not.toHaveBeenCalled();
    });

    it.each(ROUTES)(
      '$name rejects a custom role with no TRACKING permission at all',
      async (route) => {
        await call(route, Role.ADMIN, 'role-no-tracking').expect(403);
        expect(service[route.handler]).not.toHaveBeenCalled();
      },
    );

    it.each(ROUTES)('$name admits the seeded ADMIN role', async (route) => {
      await call(route, Role.ADMIN, 'app-role-ADMIN').expect(200);
      expect(service[route.handler]).toHaveBeenCalled();
    });

    it.each(ROUTES)('$name admits SUPER_ADMIN', async (route) => {
      await call(route, Role.SUPER_ADMIN, 'app-role-SUPER_ADMIN').expect(200);
      expect(service[route.handler]).toHaveBeenCalled();
    });
  });

  describe('TRACKING.VIEW alone is read-only', () => {
    const readRoutes = ROUTES.filter((route) => route.requires.length === 1);
    const writeRoutes = ROUTES.filter((route) => route.requires.length > 1);

    it.each(readRoutes)(
      '$name is reachable with only TRACKING.VIEW',
      async (route) => {
        await call(route, Role.ADMIN, 'role-read-only').expect(200);
        expect(service[route.handler]).toHaveBeenCalled();
      },
    );

    it.each(writeRoutes)(
      '$name is refused with only TRACKING.VIEW',
      async (route) => {
        await call(route, Role.ADMIN, 'role-read-only').expect(403);
        expect(service[route.handler]).not.toHaveBeenCalled();
      },
    );

    it('covers both moderation routes in the write set', () => {
      expect(writeRoutes.map((route) => route.name)).toEqual([
        'PATCH /tracking/comments/:id',
        'PATCH /tracking/feedback/:id',
      ]);
    });
  });

  describe('handler wiring', () => {
    it('passes the authenticated caller into every PII-bearing read', async () => {
      await call(ROUTES[0], Role.SUPER_ADMIN).expect(200);

      expect(service.comments).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'staff-1', role: Role.SUPER_ADMIN }),
        expect.any(Object),
      );
    });

    it('stamps the feedback PATCH with the acting caller, not a body field', async () => {
      await request(app.getHttpServer())
        .patch(`/tracking/feedback/${UUID}`)
        .set('x-test-role', Role.SUPER_ADMIN)
        .send({ status: FeedbackStatus.RESOLVED, adminNote: '  noted  ' })
        .expect(200);

      expect(service.updateFeedbackStatus).toHaveBeenCalledWith(
        UUID,
        { status: FeedbackStatus.RESOLVED, adminNote: 'noted' },
        expect.objectContaining({ id: 'staff-1' }),
      );
    });

    it('does not hand the un-paginated watch-time route a caller it would ignore', async () => {
      await call(ROUTES[5], Role.SUPER_ADMIN).expect(200);

      expect(service.watchTime).toHaveBeenCalledWith(expect.any(Object));
      expect(service.watchTime.mock.calls[0]).toHaveLength(1);
    });
  });

  describe('query validation', () => {
    it('accepts the shared date/platform filters', async () => {
      await request(app.getHttpServer())
        .get('/tracking/comments')
        .set('x-test-role', Role.SUPER_ADMIN)
        .query({
          from: '2026-08-01',
          to: '2026-08-20',
          platform: ClientPlatform.MOBILE,
          page: 2,
          limit: 50,
        })
        .expect(200);

      expect(service.comments).toHaveBeenCalledWith(expect.any(Object), {
        from: '2026-08-01',
        to: '2026-08-20',
        platform: ClientPlatform.MOBILE,
        page: 2,
        limit: 50,
      });
    });

    it('rejects an unknown platform', async () => {
      await request(app.getHttpServer())
        .get('/tracking/comments')
        .set('x-test-role', Role.SUPER_ADMIN)
        .query({ platform: 'DESKTOP' })
        .expect(400);
      expect(service.comments).not.toHaveBeenCalled();
    });

    it('rejects a limit above the house maximum of 100', async () => {
      await request(app.getHttpServer())
        .get('/tracking/comments')
        .set('x-test-role', Role.SUPER_ADMIN)
        .query({ limit: 500 })
        .expect(400);
      expect(service.comments).not.toHaveBeenCalled();
    });

    it('rejects pagination on the watch-time report, which has none', async () => {
      await request(app.getHttpServer())
        .get('/tracking/watch-time')
        .set('x-test-role', Role.SUPER_ADMIN)
        .query({ page: 2 })
        .expect(400);
      expect(service.watchTime).not.toHaveBeenCalled();
    });

    it('rejects a non-uuid id on the moderation routes', async () => {
      await request(app.getHttpServer())
        .patch('/tracking/comments/not-a-uuid')
        .set('x-test-role', Role.SUPER_ADMIN)
        .send({ status: CommentStatus.HIDDEN })
        .expect(400);
      expect(service.moderateComment).not.toHaveBeenCalled();
    });

    it('requires a status on the feedback PATCH', async () => {
      await request(app.getHttpServer())
        .patch(`/tracking/feedback/${UUID}`)
        .set('x-test-role', Role.SUPER_ADMIN)
        .send({ adminNote: 'just a note' })
        .expect(400);
      expect(service.updateFeedbackStatus).not.toHaveBeenCalled();
    });

    it('rejects an unknown feedback status', async () => {
      await request(app.getHttpServer())
        .patch(`/tracking/feedback/${UUID}`)
        .set('x-test-role', Role.SUPER_ADMIN)
        .send({ status: 'ARCHIVED' })
        .expect(400);
      expect(service.updateFeedbackStatus).not.toHaveBeenCalled();
    });

    it('routes /tracking/searches/recent to the raw log, not the :userId-style catch-all', async () => {
      await request(app.getHttpServer())
        .get('/tracking/searches/recent')
        .set('x-test-role', Role.SUPER_ADMIN)
        .expect(200);

      expect(service.recentSearches).toHaveBeenCalled();
      expect(service.topSearches).not.toHaveBeenCalled();
    });
  });
});
