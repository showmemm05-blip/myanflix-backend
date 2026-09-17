import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role, UserStatus } from '../src/generated/prisma/client';

/**
 * F-001 — PATCH /users/:id/status against the real `myanflix_test` database
 * (see e2e-setup.ts). The route used to skip every staff-status guard; a
 * custom role holding nothing but USERS.VIEW + USERS.SUSPEND could suspend a
 * Super Admin or itself.
 *
 * Only 403/200 are asserted here. The two 409 lockout guards cannot fire for
 * an active Super Admin actor (the actor always counts as a remaining one)
 * and would depend on the global count of Super Admins in a shared database;
 * they are pinned by the unit specs with a mocked count instead.
 */
describe('PATCH /users/:id/status guards (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let customRoleId: string;
  let superAdminId: string;
  let limitedId: string;
  let subscriberId: string;
  let superAdminToken: string;
  let limitedToken: string;

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
    // globally by AppModule — do not re-register them here.
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);

    // The escalation shape from the report: a custom role with the customer
    // suspend permission and nothing else.
    const customRole = await prisma.appRole.create({
      data: {
        key: `USER_SUPPORT_${suffix.toUpperCase()}`,
        name: `User Support ${suffix}`,
        isSystem: false,
        isProtected: false,
        permissions: {
          create: [
            { permission: 'USERS.VIEW' },
            { permission: 'USERS.SUSPEND' },
          ],
        },
      },
    });
    customRoleId = customRole.id;

    const superAdmin = await prisma.user.create({
      data: {
        username: `status_super_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    const limited = await prisma.user.create({
      data: {
        username: `status_support_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        appRoleId: customRole.id,
        status: UserStatus.ACTIVE,
      },
    });
    const subscriber = await prisma.user.create({
      data: {
        username: `status_user_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });

    superAdminId = superAdmin.id;
    limitedId = limited.id;
    subscriberId = subscriber.id;
    superAdminToken = await signToken(superAdmin.id);
    limitedToken = await signToken(limited.id);
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite touched.
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: [superAdminId, limitedId] } },
          { targetId: { in: [superAdminId, limitedId, subscriberId] } },
        ],
      },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [superAdminId, limitedId, subscriberId] } },
    });
    await prisma.appRole.deleteMany({ where: { id: customRoleId } });
    await app.close();
  });

  const patchUserStatus = (token: string, id: string, status: UserStatus) =>
    request(app.getHttpServer())
      .patch(`/api/users/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });

  it('refuses a limited USERS.SUSPEND holder suspending a Super Admin (403)', async () => {
    await patchUserStatus(
      limitedToken,
      superAdminId,
      UserStatus.SUSPENDED,
    ).expect(403);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: superAdminId },
    });
    expect(row.status).toBe(UserStatus.ACTIVE);
  });

  it('refuses the limited actor suspending themselves (403)', async () => {
    await patchUserStatus(limitedToken, limitedId, UserStatus.SUSPENDED).expect(
      403,
    );
  });

  it('refuses a Super Admin suspending themselves (403)', async () => {
    await patchUserStatus(
      superAdminToken,
      superAdminId,
      UserStatus.SUSPENDED,
    ).expect(403);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: superAdminId },
    });
    expect(row.status).toBe(UserStatus.ACTIVE);
  });

  it('still lets the limited actor suspend an ordinary subscriber (200) and audits it once', async () => {
    await patchUserStatus(
      limitedToken,
      subscriberId,
      UserStatus.SUSPENDED,
    ).expect(200);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: subscriberId },
    });
    expect(row.status).toBe(UserStatus.SUSPENDED);

    const rows = await prisma.auditLog.count({
      where: { action: 'user.status_change', targetId: subscriberId },
    });
    expect(rows).toBe(1);
  });

  it('the staff route still refuses the limited actor on a Super Admin (403) after the shared-gate refactor', async () => {
    await request(app.getHttpServer())
      .patch(`/api/staff/${superAdminId}/status`)
      .set('Authorization', `Bearer ${limitedToken}`)
      .send({ status: UserStatus.SUSPENDED })
      .expect(403);
  });

  it('records no audit row for a refused attempt', async () => {
    const rows = await prisma.auditLog.count({
      where: { action: 'user.status_change', targetId: superAdminId },
    });
    expect(rows).toBe(0);
  });
});
