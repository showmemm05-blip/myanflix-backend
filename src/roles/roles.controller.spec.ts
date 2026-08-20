import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Role } from '../generated/prisma/client';
import { PermissionResolverService } from './permission-resolver.service';
import { createSeededPermissionResolver } from '../../test/seeded-permission-resolver';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * Stands in for the global JwtAuthGuard: the test supplies a role via
 * `x-test-role` (absent = unauthenticated = 401). The real PermissionsGuard
 * then runs unmocked against the real seeded permission sets, so these cases
 * also prove the new /roles surface is SUPER_ADMIN-only on day one.
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

const ROLE_ID = '11111111-1111-4111-8111-111111111111';

/** What FakeJwtAuthGuard attaches — the actor the service now receives. */
const SUPER_ADMIN_ACTOR = {
  id: 'admin-1',
  username: 'boss',
  role: Role.SUPER_ADMIN,
  appRoleId: null,
};

describe('RolesController', () => {
  let app: INestApplication<App>;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    getCatalogue: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    replacePermissions: jest.Mock;
    remove: jest.Mock;
  };

  const roleShape = {
    id: ROLE_ID,
    key: 'MOVIE_MANAGER',
    name: 'Movie Manager',
    description: 'Movies only',
    isSystem: false,
    isProtected: false,
    permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
    userCount: 0,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue({ items: [roleShape] }),
      findOne: jest.fn().mockResolvedValue(roleShape),
      getCatalogue: jest.fn().mockReturnValue({
        modules: [
          {
            key: 'MOVIES',
            label: 'Movies',
            actions: [
              { key: 'VIEW', label: 'View', permission: 'MOVIES.VIEW' },
            ],
          },
        ],
        permissions: ['MOVIES.VIEW'],
      }),
      create: jest.fn().mockResolvedValue(roleShape),
      update: jest.fn().mockResolvedValue(roleShape),
      replacePermissions: jest.fn().mockResolvedValue(roleShape),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [
        { provide: RolesService, useValue: service },
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

  describe('authorization', () => {
    it('rejects unauthenticated callers', async () => {
      await request(app.getHttpServer()).get('/roles').expect(401);
    });

    it.each([Role.ADMIN, Role.CONTENT_UPLOADER, Role.USER])(
      'refuses %s — no ROLES.* permission is seeded to it',
      async (role) => {
        await request(app.getHttpServer())
          .get('/roles')
          .set('x-test-role', role)
          .expect(403);
        expect(service.findAll).not.toHaveBeenCalled();
      },
    );

    it('allows SUPER_ADMIN', async () => {
      await request(app.getHttpServer())
        .get('/roles')
        .set('x-test-role', Role.SUPER_ADMIN)
        .expect(200);
    });

    it.each([
      ['post', '/roles'],
      ['patch', `/roles/${ROLE_ID}`],
      ['put', `/roles/${ROLE_ID}/permissions`],
      ['delete', `/roles/${ROLE_ID}`],
    ])('refuses ADMIN on %s %s', async (method, path) => {
      await (
        request(app.getHttpServer())[
          method as 'post' | 'patch' | 'put' | 'delete'
        ](path) as request.Test
      )
        .set('x-test-role', Role.ADMIN)
        .send({ name: 'X', permissions: [] })
        .expect(403);
    });
  });

  describe('wire shapes', () => {
    const asSuperAdmin = (test: request.Test) =>
      test.set('x-test-role', Role.SUPER_ADMIN);

    it('GET /roles returns { items: [role] }', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).get('/roles'),
      ).expect(200);

      expect(response.body).toEqual({ items: [roleShape] });
    });

    it('GET /roles/catalogue returns { modules, permissions } and is not treated as an id', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).get('/roles/catalogue'),
      ).expect(200);

      expect(response.body.modules[0].actions[0]).toEqual({
        key: 'VIEW',
        label: 'View',
        permission: 'MOVIES.VIEW',
      });
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('POST /roles creates from { name, description, permissions }', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer())
          .post('/roles')
          .send({
            name: 'Movie Manager',
            description: 'Movies only',
            permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
          }),
      ).expect(201);

      // The actor rides along so the service can apply the grant ceiling (P1).
      expect(service.create).toHaveBeenCalledWith(
        {
          name: 'Movie Manager',
          description: 'Movies only',
          permissions: ['MOVIES.VIEW', 'MOVIES.CREATE'],
        },
        SUPER_ADMIN_ACTOR,
      );
      expect(response.body).toEqual(roleShape);
    });

    it('POST /roles rejects an unknown permission string', async () => {
      await asSuperAdmin(
        request(app.getHttpServer())
          .post('/roles')
          .send({ name: 'Bad Role', permissions: ['MOVIES.ARCHIVE'] }),
      ).expect(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('PATCH /roles/:id renames from { name, description }', async () => {
      await asSuperAdmin(
        request(app.getHttpServer())
          .patch(`/roles/${ROLE_ID}`)
          .send({ name: 'Film Manager' }),
      ).expect(200);

      expect(service.update).toHaveBeenCalledWith(ROLE_ID, {
        name: 'Film Manager',
      });
    });

    it('PUT /roles/:id/permissions replaces the whole set', async () => {
      await asSuperAdmin(
        request(app.getHttpServer())
          .put(`/roles/${ROLE_ID}/permissions`)
          .send({ permissions: ['MOVIES.VIEW'] }),
      ).expect(200);

      expect(service.replacePermissions).toHaveBeenCalledWith(
        ROLE_ID,
        ['MOVIES.VIEW'],
        SUPER_ADMIN_ACTOR,
      );
    });

    it('PUT /roles/:id/permissions accepts an empty set (revoke everything)', async () => {
      await asSuperAdmin(
        request(app.getHttpServer())
          .put(`/roles/${ROLE_ID}/permissions`)
          .send({ permissions: [] }),
      ).expect(200);

      expect(service.replacePermissions).toHaveBeenCalledWith(
        ROLE_ID,
        [],
        SUPER_ADMIN_ACTOR,
      );
    });

    it('DELETE /roles/:id responds 204 with no body', async () => {
      const response = await asSuperAdmin(
        request(app.getHttpServer()).delete(`/roles/${ROLE_ID}`),
      ).expect(204);

      expect(response.body).toEqual({});
      expect(service.remove).toHaveBeenCalledWith(ROLE_ID);
    });

    it('rejects a non-UUID role id', async () => {
      await asSuperAdmin(
        request(app.getHttpServer()).delete('/roles/not-a-uuid'),
      ).expect(400);
    });
  });
});
