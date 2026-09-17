import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from './audit-actions';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Stands in for the global JwtAuthGuard: the test supplies a role via
 * `x-test-role` (absent = unauthenticated = 401). The real PermissionsGuard
 * then runs unmocked against the real seeded permission sets, so these
 * cases prove AUDIT.VIEW reaches nobody but SUPER_ADMIN on day one.
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
    req.user = { id: 'admin-1', username: 'boss', role, appRoleId: null };
    return true;
  }
}

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

describe('AuditController', () => {
  let app: INestApplication<App>;
  let service: { findAll: jest.Mock; findOne: jest.Mock; record: jest.Mock };

  const entry = {
    id: ENTRY_ID,
    createdAt: '2026-09-09T12:00:00.000Z',
    category: 'CONTENT',
    action: 'movie.update',
    actorId: 'admin-1',
    actorUsername: 'boss',
    actorDisplayName: 'The Boss',
    actorRole: 'ADMIN',
    actorAppRoleId: null,
    actorAppRoleName: null,
    targetType: 'movie',
    targetId: 'm1',
    targetLabel: 'Alpha',
    changes: [{ field: 'title', from: 'Alpha', to: 'Alpha II' }],
    before: { title: 'Alpha' },
    after: { title: 'Alpha II' },
    metadata: null,
    ip: '10.0.0.7',
    userAgent: 'Mozilla/5.0',
    platform: 'WEB',
    actor: {
      id: 'admin-1',
      username: 'boss',
      displayName: 'The Boss',
      role: 'ADMIN',
      avatar: null,
    },
  };

  beforeEach(async () => {
    service = {
      findAll: jest
        .fn()
        .mockResolvedValue({ items: [entry], total: 1, page: 1, limit: 20 }),
      findOne: jest.fn().mockResolvedValue(entry),
      record: jest.fn().mockResolvedValue(undefined),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: AuditService, useValue: service },
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

  afterEach(async () => {
    await app.close();
  });

  const asSuperAdmin = (test: request.Test) =>
    test.set('x-test-role', Role.SUPER_ADMIN);

  describe('authorization', () => {
    it('rejects unauthenticated callers', async () => {
      await request(app.getHttpServer()).get('/audit').expect(401);
      await request(app.getHttpServer()).get('/audit/catalogue').expect(401);
      await request(app.getHttpServer()).get(`/audit/${ENTRY_ID}`).expect(401);
    });

    it.each([Role.ADMIN, Role.CONTENT_UPLOADER, Role.USER])(
      'refuses %s on every route — AUDIT.VIEW is seeded to nobody but SUPER_ADMIN',
      async (role) => {
        await request(app.getHttpServer())
          .get('/audit')
          .set('x-test-role', role)
          .expect(403);
        await request(app.getHttpServer())
          .get('/audit/catalogue')
          .set('x-test-role', role)
          .expect(403);
        await request(app.getHttpServer())
          .get(`/audit/${ENTRY_ID}`)
          .set('x-test-role', role)
          .expect(403);
        expect(service.findAll).not.toHaveBeenCalled();
        expect(service.findOne).not.toHaveBeenCalled();
      },
    );

    it('allows SUPER_ADMIN', async () => {
      await asSuperAdmin(request(app.getHttpServer()).get('/audit')).expect(
        200,
      );
    });
  });

  describe('GET /audit', () => {
    it('returns { items, total, page, limit } with the parsed query', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).get('/audit').query({
          page: 2,
          limit: 25,
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-30T00:00:00.000Z',
          category: 'CONTENT',
          action: 'movie.update',
          targetType: 'movie',
          targetId: 'm1',
          actorId: ENTRY_ID,
          search: 'alpha',
        }),
      ).expect(200);

      expect(response.body).toEqual({
        items: [entry],
        total: 1,
        page: 1,
        limit: 20,
      });
      expect(service.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 25,
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-30T00:00:00.000Z',
          category: 'CONTENT',
          action: 'movie.update',
          targetType: 'movie',
          targetId: 'm1',
          actorId: ENTRY_ID,
          search: 'alpha',
        }),
      );
    });

    it.each([
      ['an action outside the catalogue', { action: 'movie.read' }],
      ['an unknown target type', { targetType: 'episode' }],
      ['an unknown category', { category: 'NOPE' }],
      ['a malformed date', { from: 'yesterday' }],
      ['a non-uuid actorId', { actorId: 'admin-1' }],
      ['a search over 200 chars', { search: 'x'.repeat(201) }],
      ['a limit over 100', { limit: 101 }],
      ['an unknown filter key', { actorUsername: 'boss' }],
    ])('400s on %s', async (_label, query) => {
      await asSuperAdmin(
        request(app.getHttpServer()).get('/audit').query(query),
      ).expect(400);
      expect(service.findAll).not.toHaveBeenCalled();
    });
  });

  describe('GET /audit/catalogue', () => {
    it('serves the catalogue and is not treated as an id', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).get('/audit/catalogue'),
      ).expect(200);

      expect(response.body.categories).toEqual([
        'CONTENT',
        'USERS',
        'FINANCE',
        'STAFF',
        'SYSTEM',
      ]);
      expect(response.body.actions).toHaveLength(AUDIT_ACTIONS.length);
      expect(response.body.actions).toContainEqual({
        key: 'deposit.approve',
        category: 'FINANCE',
        targetType: 'deposit',
      });
      expect(response.body.targetTypes).toEqual([...AUDIT_TARGET_TYPES]);
      expect(service.findOne).not.toHaveBeenCalled();
    });
  });

  describe('GET /audit/:id', () => {
    it('returns one row whole — ip and userAgent included', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).get(`/audit/${ENTRY_ID}`),
      ).expect(200);
      expect(response.body).toEqual(entry);
      expect(service.findOne).toHaveBeenCalledWith(ENTRY_ID);
    });

    it('404s when the service finds nothing', async () => {
      service.findOne.mockRejectedValue(new NotFoundException());
      await asSuperAdmin(
        request(app.getHttpServer()).get(`/audit/${ENTRY_ID}`),
      ).expect(404);
    });

    it('400s on a non-uuid id', async () => {
      await asSuperAdmin(
        request(app.getHttpServer()).get('/audit/not-a-uuid'),
      ).expect(400);
      expect(service.findOne).not.toHaveBeenCalled();
    });
  });
});
