import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AccessType,
  MovieStatus,
  Role,
  UserStatus,
} from '../src/generated/prisma/client';
import type { AuthenticatedUser } from '../src/auth/types/authenticated-user.type';

/**
 * Staff audit log — the read API and its guards against the real
 * `myanflix_test` database (see e2e-setup.ts).
 *
 * The audit ROW is produced the way it is in production: an ADMIN edits a
 * movie's title through PUT /movies/:id, and MoviesService.update records
 * `movie.update` with the before/after snapshots.
 */
describe('Audit log (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let superAdminId: string;
  let adminId: string;
  let superAdminToken: string;
  let adminToken: string;
  let movieId: string;
  let adminActor: AuthenticatedUser;

  /** ISO timestamp taken just before the audited edit — for from/to filters. */
  let editedAt: Date;

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // ValidationPipe/AllExceptionsFilter/ResponseInterceptor are registered
    // globally by AppModule (APP_PIPE/APP_FILTER/APP_INTERCEPTOR) — do not
    // re-register them here.
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);
    const superAdmin = await prisma.user.create({
      data: {
        username: `audit_super_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    const admin = await prisma.user.create({
      data: {
        username: `audit_admin_${suffix}`,
        displayName: 'Audit Admin',
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    superAdminId = superAdmin.id;
    adminId = admin.id;
    superAdminToken = await signToken(superAdmin.id);
    adminToken = await signToken(admin.id);
    adminActor = {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      appRoleId: admin.appRoleId,
    };

    const movie = await prisma.movie.create({
      data: {
        title: `Audit Movie ${suffix}`,
        description: 'Created by the audit e2e suite',
        genre: 'Drama',
        language: 'en',
        releaseYear: 2024,
        duration: 100,
        // Pinned explicitly so the title is the only change the PUT below can
        // carry in its diff. (CreateMovieDto no longer has an `accessType`
        // class default that UpdateMovieDto could inherit — F-002 — so the
        // value itself is arbitrary; SUBSCRIPTION matches the schema default.)
        accessType: AccessType.SUBSCRIPTION,
        status: MovieStatus.DRAFT,
      },
    });
    movieId = movie.id;

    editedAt = new Date();

    await request(app.getHttpServer())
      .put(`/api/movies/${movieId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: `${movie.title} (edited)` })
      .expect(200);
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite touched.
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: [superAdminId, adminId] } },
          { targetType: 'movie', targetId: movieId },
        ],
      },
    });
    await prisma.movie.deleteMany({ where: { id: movieId } });
    await prisma.user.deleteMany({
      where: { id: { in: [superAdminId, adminId] } },
    });
    await app.close();
  });

  const listAsSuperAdmin = (query: Record<string, string | number> = {}) =>
    request(app.getHttpServer())
      .get('/api/audit')
      .query(query)
      .set('Authorization', `Bearer ${superAdminToken}`);

  describe('guards', () => {
    it('401s without a token', async () => {
      await request(app.getHttpServer()).get('/api/audit').expect(401);
      await request(app.getHttpServer())
        .get('/api/audit/catalogue')
        .expect(401);
    });

    it('403s an ADMIN — AUDIT.VIEW is not seeded to that role', async () => {
      await request(app.getHttpServer())
        .get('/api/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/audit/catalogue')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });
  });

  describe('GET /audit', () => {
    it('lists the movie.update row with its diff and actor snapshot for SUPER_ADMIN', async () => {
      const res = await listAsSuperAdmin({ targetId: movieId }).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ total: 1, page: 1, limit: 20 });
      const [row] = res.body.data.items;
      expect(row).toMatchObject({
        category: 'CONTENT',
        action: 'movie.update',
        actorId: adminId,
        actorUsername: adminActor.username,
        actorDisplayName: 'Audit Admin',
        actorRole: 'ADMIN',
        targetType: 'movie',
        targetId: movieId,
        changes: [
          {
            field: 'title',
            from: expect.stringMatching(/^Audit Movie /),
            to: expect.stringMatching(/\(edited\)$/),
          },
        ],
        platform: 'UNKNOWN',
      });
      expect(row.targetLabel).toMatch(/\(edited\)$/);
      // Full movieSnapshot() on both sides; only the title differs.
      expect(row.before).toMatchObject({
        title: row.changes[0].from,
        status: 'DRAFT',
        genre: 'Drama',
        categories: [],
        actors: [],
      });
      expect(row.after).toMatchObject({
        title: row.changes[0].to,
        status: 'DRAFT',
        genre: 'Drama',
        categories: [],
        actors: [],
      });
      expect(row.actor).toMatchObject({
        id: adminId,
        username: adminActor.username,
        displayName: 'Audit Admin',
        role: 'ADMIN',
      });
    });

    it('filters by action, targetId and actorId', async () => {
      const byAction = await listAsSuperAdmin({
        action: 'movie.update',
        targetId: movieId,
      }).expect(200);
      expect(byAction.body.data.total).toBe(1);

      const otherAction = await listAsSuperAdmin({
        action: 'movie.delete',
        targetId: movieId,
      }).expect(200);
      expect(otherAction.body.data.total).toBe(0);

      const byActor = await listAsSuperAdmin({
        actorId: adminId,
        targetType: 'movie',
      }).expect(200);
      expect(byActor.body.data.total).toBe(1);

      const byOtherActor = await listAsSuperAdmin({
        actorId: superAdminId,
        targetId: movieId,
      }).expect(200);
      expect(byOtherActor.body.data.total).toBe(0);
    });

    it('filters by from/to', async () => {
      const inside = await listAsSuperAdmin({
        targetId: movieId,
        from: new Date(editedAt.getTime() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      }).expect(200);
      expect(inside.body.data.total).toBe(1);

      const before = await listAsSuperAdmin({
        targetId: movieId,
        to: new Date(editedAt.getTime() - 60_000).toISOString(),
      }).expect(200);
      expect(before.body.data.total).toBe(0);

      const after = await listAsSuperAdmin({
        targetId: movieId,
        from: new Date(Date.now() + 60_000).toISOString(),
      }).expect(200);
      expect(after.body.data.total).toBe(0);
    });

    it('searches targetLabel / actorUsername case-insensitively', async () => {
      const res = await listAsSuperAdmin({
        search: adminActor.username.toUpperCase(),
      }).expect(200);
      expect(res.body.data.total).toBeGreaterThanOrEqual(1);
      expect(
        res.body.data.items.every(
          (item: { actorUsername: string }) =>
            item.actorUsername === adminActor.username,
        ),
      ).toBe(true);
    });

    it('400s on an action outside the catalogue', async () => {
      await listAsSuperAdmin({ action: 'movie.read' }).expect(400);
    });
  });

  describe('GET /audit/:id and /audit/catalogue', () => {
    it('returns one row whole, and 404s for an unknown id', async () => {
      const list = await listAsSuperAdmin({ targetId: movieId }).expect(200);
      const id = list.body.data.items[0].id as string;

      const one = await request(app.getHttpServer())
        .get(`/api/audit/${id}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);
      expect(one.body.data).toMatchObject({ id, action: 'movie.update' });

      await request(app.getHttpServer())
        .get(`/api/audit/${randomUUID()}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .get(`/api/audit/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });

    it('serves the catalogue', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/audit/catalogue')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);
      expect(res.body.data.categories).toContain('CONTENT');
      expect(res.body.data.actions).toContainEqual({
        key: 'movie.update',
        category: 'CONTENT',
        targetType: 'movie',
      });
      expect(res.body.data.targetTypes).toContain('movie');
    });
  });

  describe('write rules', () => {
    it('never records an action performed by a plain USER', async () => {
      const suffix = randomUUID().slice(0, 8);
      const user = await prisma.user.create({
        data: {
          username: `audit_user_${suffix}`,
          password: 'unused-in-these-tests',
          role: Role.USER,
          status: UserStatus.ACTIVE,
        },
      });
      try {
        await app.get(AuditService).record({
          action: 'comment.delete',
          actor: {
            id: user.id,
            username: user.username,
            role: user.role,
            appRoleId: null,
          },
          target: { type: 'comment', id: randomUUID() },
        });
        const rows = await prisma.auditLog.count({
          where: { actorId: user.id },
        });
        expect(rows).toBe(0);
      } finally {
        await prisma.user.delete({ where: { id: user.id } });
      }
    });

    it('keeps the actor snapshot after the staff account is deleted', async () => {
      const suffix = randomUUID().slice(0, 8);
      const temp = await prisma.user.create({
        data: {
          username: `audit_temp_${suffix}`,
          password: 'unused-in-these-tests',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      await app.get(AuditService).record({
        action: 'category.create',
        actor: {
          id: temp.id,
          username: temp.username,
          role: temp.role,
          appRoleId: null,
        },
        target: { type: 'category', id: randomUUID(), label: 'Temp' },
        after: { name: 'Temp' },
      });
      await prisma.user.delete({ where: { id: temp.id } });

      const res = await listAsSuperAdmin({
        search: temp.username,
        action: 'category.create',
      }).expect(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0]).toMatchObject({
        actorId: null,
        actorUsername: temp.username,
        actorRole: 'ADMIN',
        actor: null,
      });

      await prisma.auditLog.deleteMany({
        where: { actorUsername: temp.username },
      });
    });
  });
});
