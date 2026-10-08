import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { randomInt, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OtpCodeHasher } from '../src/otp/otp-code.hasher';
import {
  AuditCategory,
  OtpPurpose,
  Role,
  UserStatus,
} from '../src/generated/prisma/client';
import {
  requestHostContext,
  resolveClientIp,
} from '../src/common/storage/request-host.context';

/**
 * H-6, H-8, H-16 and H-21 end to end, against the real test database (see
 * e2e-setup.ts): phone sign-in needs BOTH steps, "forgot password" resets
 * with a code and signs every session out, a self-service password change
 * keeps only the caller, a staff reset kills the old access token at once,
 * and a closed account is anonymised, keeps its money records and never
 * signs in again. Codes are written straight into otp_codes (no SMS). B1:
 * every code is bound to its purpose — sign-in or password reset.
 *
 * The suite is one story, in order: each `it` continues from the last.
 */
describe('Account security (e2e: H-6, H-8, H-16, H-21)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  /** M-1: otp_codes holds only a keyed hash — written and looked up through this. */
  let otpHasher: OtpCodeHasher;

  const phone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const phoneUsername = `user_${phone.replace(/\D/g, '')}`;
  const suffix = randomUUID().slice(0, 8);
  /** B1: phones that must never get a reset code, and two that request one. */
  const unknownPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const staffPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const resetPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const signInPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  /** M-20: a phone whose synthesized username someone else already holds. */
  const squattedPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const otherUserIds: string[] = [];
  /** B4: the request address and device the audit trail must forget. */
  const CLIENT_IP = '203.0.113.77';
  const CLIENT_UA = 'account-security-e2e/1.0';

  let userId: string;
  /** The live sessions of the phone account, by name. */
  const sessions: Record<
    string,
    { accessToken: string; refreshToken: string }
  > = {};
  let superAdminId: string;
  let superAdminToken: string;
  let staffId: string;
  const createdDepositIds: string[] = [];
  const seededAuditIds: string[] = [];

  const api = () => request(app.getHttpServer());

  async function giveCode(
    code: string,
    purpose: OtpPurpose = OtpPurpose.LOGIN,
  ): Promise<void> {
    await prisma.otpCode.create({
      data: {
        phone,
        codeHash: otpHasher.hash(phone, code),
        purpose,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
  }

  async function signIn(password: string, code: string) {
    const step = await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password })
      .expect(200);
    expect(step.body.data.valid).toBe(true);
    await giveCode(code);
    const res = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code, stepToken: step.body.data.stepToken })
      .expect(200);
    return res.body.data as { accessToken: string; refreshToken: string };
  }

  const me = (token: string) =>
    api().get('/api/users/me').set('Authorization', `Bearer ${token}`);
  const refresh = (refreshToken: string) =>
    api().post('/api/auth/refresh').send({ refreshToken });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    // The request context main.ts installs (the part the audit log reads),
    // so the rows below record an IP address and user agent as they do live.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      requestHostContext.run(
        {
          hostname: '',
          ip: resolveClientIp(
            req.headers['x-forwarded-for'],
            req.socket.remoteAddress,
          ),
          userAgent: req.headers['user-agent'] ?? null,
        },
        next,
      );
    });
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);
    otpHasher = OtpCodeHasher.fromConfig(configService);

    const superAdminRole = await prisma.appRole.findUniqueOrThrow({
      where: { key: Role.SUPER_ADMIN },
    });
    const superAdmin = await prisma.user.create({
      data: {
        username: `sec_super_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        appRoleId: superAdminRole.id,
      },
    });
    await prisma.wallet.create({ data: { userId: superAdmin.id, balance: 0 } });
    superAdminId = superAdmin.id;
    superAdminToken = await jwtService.signAsync(
      { sub: superAdmin.id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );

    // A brand-new phone signs up through the real flow: code + chosen password.
    await giveCode('100000');
    const signup = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: '100000', password: 'first-password-1' })
      .expect(200);
    userId = signup.body.data.user.id;
    sessions.a = signup.body.data;
  });

  afterAll(async () => {
    const ids = [userId, superAdminId, staffId, ...otherUserIds].filter(
      Boolean,
    );
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { id: { in: seededAuditIds } },
          { actorId: { in: ids } },
          { targetId: { in: ids } },
          { targetId: { in: createdDepositIds } },
        ],
      },
    });
    await prisma.deposit.deleteMany({
      where: { id: { in: createdDepositIds } },
    });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.otpCode.deleteMany({
      where: {
        phone: {
          in: [
            phone,
            unknownPhone,
            staffPhone,
            resetPhone,
            signInPhone,
            squattedPhone,
          ],
        },
      },
    });
    await app.close();
  });

  it('M-20: a pre-claimed user_<digits> name does not block that phone from signing up', async () => {
    // Any door that lets a caller pick a username (a Google e-mail spelt
    // user_<digits>@…, a staff-created account) could hold the exact name
    // the phone sign-up synthesizes. Seed that row directly.
    const digits = squattedPhone.replace(/\D/g, '');
    const squatter = await prisma.user.create({
      data: {
        username: `user_${digits}`,
        password: await bcrypt.hash('squatter-password', 4),
        email: `squatter-${suffix}@example.com`,
        googleId: `squat-${suffix}`,
      },
    });
    otherUserIds.push(squatter.id);
    await prisma.wallet.create({ data: { userId: squatter.id, balance: 0 } });

    await prisma.otpCode.create({
      data: {
        phone: squattedPhone,
        codeHash: otpHasher.hash(squattedPhone, '424242'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    const res = await api()
      .post('/api/auth/otp/verify')
      .send({ phone: squattedPhone, code: '424242', password: 'victim-pass-1' })
      .expect(200);
    const created = res.body.data as {
      user: { id: string; username: string };
      accessToken: string;
    };
    otherUserIds.push(created.user.id);

    // A real, separate account for the phone — not the squatter's.
    expect(created.user.id).not.toBe(squatter.id);
    expect(created.user.username).toMatch(
      new RegExp(`^user_${digits}_[0-9a-f]{6}$`),
    );
    const row = await prisma.user.findUnique({
      where: { id: created.user.id },
    });
    expect(row?.phone).toBe(squattedPhone);
    expect(row?.googleId).toBeNull();
    await me(created.accessToken).expect(200);
    // The squatter's row is untouched.
    const squatterRow = await prisma.user.findUnique({
      where: { id: squatter.id },
    });
    expect(squatterRow?.phone).toBeNull();
    expect(squatterRow?.username).toBe(`user_${digits}`);
  });

  it('H-6: /auth/login never opens a customer account, even with the right password', async () => {
    const res = await api()
      .post('/api/auth/login')
      .send({ username: phoneUsername, password: 'first-password-1' })
      .expect(401);
    expect(res.body.message).toBe('Invalid username or password');
  });

  it('H-6: the code alone does not open the existing account — and the code is not spent', async () => {
    await giveCode('111111');
    const res = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: '111111' })
      .expect(401);
    expect(res.body.message).toBe('Please enter your password again.');

    const code = await prisma.otpCode.findFirst({
      where: { phone, codeHash: otpHasher.hash(phone, '111111') },
    });
    expect(code?.consumedAt).toBeNull();
    expect(code?.attemptCount).toBe(0);
  });

  it('H-6: password step, then code, opens it', async () => {
    const step = await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password: 'first-password-1' })
      .expect(200);
    const res = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: '111111', stepToken: step.body.data.stepToken })
      .expect(200);
    sessions.b = res.body.data;
    await me(sessions.b.accessToken).expect(200);
  });

  it('H-21: a self-service password change signs out every OTHER session and keeps the caller', async () => {
    await api()
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${sessions.b.accessToken}`)
      .send({
        currentPassword: 'first-password-1',
        newPassword: 'second-password-2',
      })
      .expect(200);

    // Session A is gone at once, access and refresh alike.
    await me(sessions.a.accessToken).expect(401);
    await refresh(sessions.a.refreshToken).expect(401);

    // Session B's old access token is refused too, but its refresh session
    // was kept: one refresh and the caller carries on.
    await me(sessions.b.accessToken).expect(401);
    const renewed = await refresh(sessions.b.refreshToken).expect(200);
    sessions.b = renewed.body.data;
    await me(sessions.b.accessToken).expect(200);
  });

  it('B1: a code requested for sign-in never resets the password — and is not spent', async () => {
    await giveCode('212121', OtpPurpose.LOGIN);
    const res = await api()
      .post('/api/auth/password/reset')
      .send({ phone, code: '212121', newPassword: 'hijacked-password-9' })
      .expect(401);
    expect(res.body.message).toBe('Invalid or expired code');

    const code = await prisma.otpCode.findFirstOrThrow({
      where: { phone, codeHash: otpHasher.hash(phone, '212121') },
    });
    expect(code.consumedAt).toBeNull();
    expect(code.attemptCount).toBe(0);
    await me(sessions.b.accessToken).expect(200);
    await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password: 'second-password-2' })
      .expect(200);
  });

  it('B1: a code requested for a password reset never signs in — and is not spent', async () => {
    await giveCode('232323', OtpPurpose.PASSWORD_RESET);
    const step = await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password: 'second-password-2' })
      .expect(200);
    const res = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: '232323', stepToken: step.body.data.stepToken })
      .expect(401);
    expect(res.body.message).toBe('Invalid or expired code');

    const code = await prisma.otpCode.findFirstOrThrow({
      where: { phone, codeHash: otpHasher.hash(phone, '232323') },
    });
    expect(code.consumedAt).toBeNull();
    expect(code.attemptCount).toBe(0);
  });

  it('B1: a reset code is refused BEFORE it exists for a phone with no customer account — staff included', async () => {
    const staffRole = await prisma.appRole.findUniqueOrThrow({
      where: { key: Role.ADMIN },
    });
    const staffWithPhone = await prisma.user.create({
      data: {
        username: `sec_phone_staff_${suffix}`,
        password: 'unused-in-these-tests',
        phone: staffPhone,
        role: Role.ADMIN,
        appRoleId: staffRole.id,
      },
    });
    otherUserIds.push(staffWithPhone.id);

    for (const target of [unknownPhone, staffPhone]) {
      const res = await api()
        .post('/api/auth/otp/request')
        .send({ phone: target, purpose: 'password_reset' })
        .expect(400);
      expect(res.body.message).toBe(
        'No account was found for this phone number.',
      );
      await expect(
        prisma.otpCode.count({ where: { phone: target } }),
      ).resolves.toBe(0);
    }
  });

  it('B1: /auth/otp/request stores the purpose — a reset code for a customer, a sign-in code by default', async () => {
    const customer = await prisma.user.create({
      data: {
        username: `sec_reset_${suffix}`,
        password: 'unused-in-these-tests',
        phone: resetPhone,
      },
    });
    otherUserIds.push(customer.id);

    const reset = await api()
      .post('/api/auth/otp/request')
      .send({ phone: resetPhone, purpose: 'password_reset' })
      .expect(200);
    expect(reset.body.data).toEqual({ sent: true });
    const signIn = await api()
      .post('/api/auth/otp/request')
      .send({ phone: signInPhone })
      .expect(200);
    expect(signIn.body.data).toEqual({ sent: true });

    const stored = await prisma.otpCode.findMany({
      where: { phone: { in: [resetPhone, signInPhone] } },
      select: { phone: true, purpose: true },
    });
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        { phone: resetPhone, purpose: OtpPurpose.PASSWORD_RESET },
        { phone: signInPhone, purpose: OtpPurpose.LOGIN },
      ]),
    );

    await api()
      .post('/api/auth/otp/request')
      .send({ phone: resetPhone, purpose: 'reset' })
      .expect(400);
  });

  it('H-8: forgot password — phone, code, new password — revokes every session and opens none', async () => {
    await giveCode('222222', OtpPurpose.PASSWORD_RESET);
    const res = await api()
      .post('/api/auth/password/reset')
      .set('X-Forwarded-For', CLIENT_IP)
      .set('User-Agent', CLIENT_UA)
      .send({ phone, code: '222222', newPassword: 'third-password-3' })
      .expect(200);
    expect(res.body.data).toEqual({ reset: true });

    await me(sessions.b.accessToken).expect(401);
    await refresh(sessions.b.refreshToken).expect(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.password_reset', targetId: userId },
    });
    expect(audit).toEqual(
      expect.objectContaining({
        category: AuditCategory.USERS,
        actorId: userId,
        actorRole: Role.USER,
      }),
    );
    expect(JSON.stringify(audit)).not.toContain('third-password-3');
    // Recorded like any request — until the account is closed (B4, below).
    expect(audit).toEqual(
      expect.objectContaining({ ip: CLIENT_IP, userAgent: CLIENT_UA }),
    );

    // The old password is dead; the new one signs in through both steps.
    await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password: 'second-password-2' })
      .expect(401);
    sessions.c = await signIn('third-password-3', '333333');
    await me(sessions.c.accessToken).expect(200);
  });

  it('H-8: a wrong code changes nothing', async () => {
    await giveCode('444444', OtpPurpose.PASSWORD_RESET);
    await api()
      .post('/api/auth/password/reset')
      .send({ phone, code: '000000', newPassword: 'fourth-password-4' })
      .expect(401);
    await me(sessions.c.accessToken).expect(200);
  });

  it('H-16: account deletion is refused while the wallet holds money', async () => {
    await prisma.wallet.update({ where: { userId }, data: { balance: 500 } });
    const res = await api()
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${sessions.c.accessToken}`)
      .expect(409);
    expect(res.body.message).toBe(
      'Your wallet still has money in it. Withdraw or spend it before deleting your account.',
    );
    await prisma.wallet.update({ where: { userId }, data: { balance: 0 } });
  });

  it('H-16: account deletion is refused while a deposit is pending', async () => {
    const deposit = await api()
      .post('/api/deposits')
      .set('Authorization', `Bearer ${sessions.c.accessToken}`)
      .send({ amount: 5000, paymentMethod: 'KBZ Pay', reference: '731902' })
      .expect(201);
    createdDepositIds.push(deposit.body.data.id);

    const res = await api()
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${sessions.c.accessToken}`)
      .expect(409);
    expect(res.body.message).toBe(
      'You have a deposit waiting for review. Wait until it is approved or rejected before deleting your account.',
    );

    // Settled (as staff would): the money record itself stays.
    await prisma.deposit.update({
      where: { id: deposit.body.data.id },
      data: { status: 'REJECTED', rejectionReason: 'e2e' },
    });
  });

  it('H-16: deleting closes the account — anonymised, CLOSED, money records kept, the name gone from the audit trail', async () => {
    // Audit rows that name the account, and one that names a DIFFERENT
    // account whose username merely starts with ours.
    const seeded = await Promise.all([
      prisma.auditLog.create({
        data: {
          category: AuditCategory.USERS,
          action: 'user.status_change',
          actorId: superAdminId,
          actorUsername: `sec_super_${suffix}`,
          targetType: 'user',
          targetId: userId,
          targetLabel: `@${phoneUsername}`,
          before: { username: phoneUsername, phone, status: 'ACTIVE' },
          after: { username: phoneUsername, phone, status: 'SUSPENDED' },
        },
      }),
      prisma.auditLog.create({
        data: {
          category: AuditCategory.FINANCE,
          action: 'deposit.reject',
          actorId: superAdminId,
          actorUsername: `sec_super_${suffix}`,
          targetType: 'deposit',
          targetId: createdDepositIds[0],
          targetLabel: `731902 · @${phoneUsername}`,
        },
      }),
      prisma.auditLog.create({
        data: {
          category: AuditCategory.FINANCE,
          action: 'deposit.reject',
          actorId: superAdminId,
          actorUsername: `sec_super_${suffix}`,
          targetType: 'deposit',
          targetId: null,
          targetLabel: `111111 · @${phoneUsername}7`,
        },
      }),
    ]);
    seededAuditIds.push(...seeded.map((row) => row.id));

    const res = await api()
      .delete('/api/users/me')
      .set('Authorization', `Bearer ${sessions.c.accessToken}`)
      .set('X-Forwarded-For', CLIENT_IP)
      .set('User-Agent', CLIENT_UA)
      .expect(200);
    expect(res.body.data).toEqual({ deleted: true });

    const closedName = `deleted_${userId.replace(/-/g, '')}`;
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row).toEqual(
      expect.objectContaining({
        username: closedName,
        phone: null,
        email: null,
        googleId: null,
        displayName: null,
        avatar: null,
        status: UserStatus.CLOSED,
      }),
    );
    await expect(
      bcrypt.compare('third-password-3', row.password),
    ).resolves.toBe(false);

    // Money records kept.
    await expect(
      prisma.wallet.findUnique({ where: { userId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.deposit.findUnique({ where: { id: createdDepositIds[0] } }),
    ).resolves.toEqual(expect.objectContaining({ userId }));

    // No live session, no code left for the phone.
    await expect(
      prisma.refreshToken.count({ where: { userId, revoked: false } }),
    ).resolves.toBe(0);
    await expect(prisma.otpCode.count({ where: { phone } })).resolves.toBe(0);

    // The audit trail no longer names the person — but only whole names.
    const [userRow, depositRow, otherRow] = await Promise.all(
      seeded.map((entry) =>
        prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } }),
      ),
    );
    expect(userRow.targetLabel).toBe(`@${closedName}`);
    expect(userRow.before).toEqual({
      username: closedName,
      phone: null,
      email: null,
      displayName: null,
      status: 'ACTIVE',
    });
    expect(userRow.after).toEqual(
      expect.objectContaining({ username: closedName, phone: null }),
    );
    expect(depositRow.targetLabel).toBe(`731902 · @${closedName}`);
    expect(otherRow.targetLabel).toBe(`111111 · @${phoneUsername}7`);

    const ownRows = await prisma.auditLog.findMany({
      where: { actorId: userId },
    });
    expect(ownRows.map((entry) => entry.action).sort()).toEqual([
      'user.account_delete',
      'user.password_reset',
    ]);
    for (const entry of ownRows) {
      expect(entry.actorUsername).toBe(closedName);
      expect(JSON.stringify(entry)).not.toContain(phone.replace('+', ''));
      // B4: the rows stay, but no longer say where from or on what device —
      // the deletion request's own row included.
      expect(entry.ip).toBeNull();
      expect(entry.userAgent).toBeNull();
    }
  });

  it('H-16: a closed account can never sign in again, and staff cannot reopen it', async () => {
    await me(sessions.c.accessToken).expect(401);
    await refresh(sessions.c.refreshToken).expect(401);

    const check = await api()
      .post('/api/auth/phone/check')
      .send({ phone })
      .expect(200);
    expect(check.body.data).toEqual({ exists: false });
    await api()
      .post('/api/auth/phone/verify-password')
      .send({ phone, password: 'third-password-3' })
      .expect(401);
    await api()
      .post('/api/auth/login')
      .send({
        username: `deleted_${userId.replace(/-/g, '')}`,
        password: 'third-password-3',
      })
      .expect(401);

    const reopen = await api()
      .patch(`/api/users/${userId}/status`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(409);
    expect(reopen.body.message).toBe(
      'This account was closed by its owner and cannot be changed.',
    );
    await api()
      .patch(`/api/users/${userId}/status`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ status: 'CLOSED' })
      .expect(400);
  });

  it("H-21: a staff password reset by a Super Admin kills the staff member's access token at once", async () => {
    const adminRole = await prisma.appRole.findUniqueOrThrow({
      where: { key: Role.ADMIN },
    });
    const staff = await prisma.user.create({
      data: {
        username: `sec_staff_${suffix}`,
        password: await bcrypt.hash('staff-password-1', 4),
        role: Role.ADMIN,
        appRoleId: adminRole.id,
      },
    });
    await prisma.wallet.create({ data: { userId: staff.id, balance: 0 } });
    staffId = staff.id;

    const login = await api()
      .post('/api/auth/login')
      .send({ username: staff.username, password: 'staff-password-1' })
      .expect(200);
    const { accessToken, refreshToken } = login.body.data as {
      accessToken: string;
      refreshToken: string;
    };
    await me(accessToken).expect(200);

    await api()
      .patch(`/api/staff/${staff.id}/password`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ newPassword: 'staff-password-2' })
      .expect(200);

    await me(accessToken).expect(401);
    await refresh(refreshToken).expect(401);
    await api()
      .post('/api/auth/login')
      .send({ username: staff.username, password: 'staff-password-2' })
      .expect(200);
  });
});
