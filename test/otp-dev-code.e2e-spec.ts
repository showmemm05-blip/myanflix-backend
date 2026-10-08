// Must stay the FIRST import: it turns OTP_DEV_CODE on (and the phone
// gateway, never online) before AppModule is loaded.
import { E2E_OTP_DEV_CODE } from './otp-dev-code.e2e-env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomInt, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OtpCodeHasher } from '../src/otp/otp-code.hasher';
import { OtpService } from '../src/otp/otp.service';
import { OtpPurpose, Role } from '../src/generated/prisma/client';

/**
 * OTP_DEV_CODE end to end, against the real test database (e2e-setup.ts):
 * every code request answers exactly as usual but stores the keyed hash of
 * the fixed dev code and queues no SMS; the normal verify paths (sign-up,
 * password reset, withdrawal-code reset) accept it; a wrong code still
 * spends a try; the resend cooldown still applies.
 */
describe('OTP_DEV_CODE (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let hasher: OtpCodeHasher;
  const phones: string[] = [];
  const newPhone = () => {
    const phone = `+959${randomInt(10_000_000, 99_999_999)}`;
    phones.push(phone);
    return phone;
  };
  const api = () => request(app.getHttpServer());
  const PASSWORD = 'DevCode-e2e-Passw0rd!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    hasher = OtpCodeHasher.fromConfig(app.get(ConfigService));
    await prisma.smsGatewayDevice.deleteMany({});
  });

  afterAll(async () => {
    try {
      const users = await prisma.user.findMany({
        where: { phone: { in: phones } },
        select: { id: true },
      });
      const userIds = users.map((u) => u.id);
      await prisma.smsMessage.deleteMany({ where: { phone: { in: phones } } });
      await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
      await prisma.userSession.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
  });

  it('a sign-in request answers 200 { sent: true } as usual, stores the dev code hash and queues no SMS (gateway offline)', async () => {
    const phone = newPhone();
    const res = await api()
      .post('/api/auth/otp/request')
      .send({ phone })
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { sent: true } });

    const rows = await prisma.otpCode.findMany({ where: { phone } });
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe(OtpPurpose.LOGIN);
    expect(rows[0].codeHash).toBe(hasher.hash(phone, E2E_OTP_DEV_CODE));
    expect(rows[0].codeHash).not.toContain(E2E_OTP_DEV_CODE);
    expect(await prisma.smsMessage.count({ where: { phone } })).toBe(0);
  });

  it('a wrong code spends a try; the dev code then creates the account (sign-up)', async () => {
    const phone = newPhone();
    await api().post('/api/auth/otp/request').send({ phone }).expect(200);

    await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: '135790', password: PASSWORD })
      .expect(401);
    const afterWrong = await prisma.otpCode.findFirstOrThrow({
      where: { phone },
    });
    expect(afterWrong.attemptCount).toBe(1);
    expect(afterWrong.consumedAt).toBeNull();

    const ok = await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: E2E_OTP_DEV_CODE, password: PASSWORD })
      .expect(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));
    const used = await prisma.otpCode.findFirstOrThrow({ where: { phone } });
    expect(used.consumedAt).not.toBeNull();

    // Single use: the same code again is refused.
    await api()
      .post('/api/auth/otp/verify')
      .send({ phone, code: E2E_OTP_DEV_CODE, password: PASSWORD })
      .expect(401);
  });

  it('the resend cooldown still answers 409 and stores nothing more', async () => {
    const phone = newPhone();
    await api().post('/api/auth/otp/request').send({ phone }).expect(200);
    await api().post('/api/auth/otp/request').send({ phone }).expect(409);
    expect(await prisma.otpCode.count({ where: { phone } })).toBe(1);
  });

  it('password reset: the request and the reset itself work with the dev code, no SMS', async () => {
    const phone = newPhone();
    await prisma.user.create({
      data: {
        username: `devcode_${randomUUID().slice(0, 8)}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        phone,
      },
    });
    await api()
      .post('/api/auth/otp/request')
      .send({ phone, purpose: 'password_reset' })
      .expect(200);
    await api()
      .post('/api/auth/password/reset')
      .send({ phone, code: E2E_OTP_DEV_CODE, newPassword: PASSWORD })
      .expect(200);
    expect(await prisma.smsMessage.count({ where: { phone } })).toBe(0);
  });

  it('withdrawal-code reset purpose: stored as the dev code hash, verifies, no SMS', async () => {
    const phone = newPhone();
    const otp = app.get(OtpService);
    await otp.requestOtp(phone, OtpPurpose.WITHDRAWAL_CODE_RESET);
    const row = await prisma.otpCode.findFirstOrThrow({ where: { phone } });
    expect(row.codeHash).toBe(hasher.hash(phone, E2E_OTP_DEV_CODE));
    await expect(
      otp.verifyOtp(phone, E2E_OTP_DEV_CODE, OtpPurpose.WITHDRAWAL_CODE_RESET),
    ).resolves.toBeUndefined();
    expect(await prisma.smsMessage.count({ where: { phone } })).toBe(0);
  });
});
