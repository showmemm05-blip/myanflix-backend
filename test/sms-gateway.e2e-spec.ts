// Must stay the FIRST import: it switches this file's environment to the
// phone gateway before AppModule (and its ConfigModule) is loaded.
import {
  E2E_SMS_DAILY_CAP,
  E2E_SMS_DAILY_CAP_PER_PHONE,
  E2E_SMS_GATEWAY_TOKEN,
} from './sms-gateway.e2e-env';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomInt, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { OtpCodeHasher } from '../src/otp/otp-code.hasher';
import { Role, SmsMessageStatus } from '../src/generated/prisma/client';
import { SmsService } from '../src/sms/sms.service';
import {
  SMS_REDACTED,
  SMS_UNAVAILABLE_MESSAGE,
  TOO_MANY_CODE_REQUESTS_MESSAGE,
} from '../src/sms/sms.config';
import {
  SmsGatewayService,
  startOfUtcDay,
} from '../src/sms-gateway/sms-gateway.service';
import { SmsSweeperService } from '../src/sms-gateway/sms-sweeper.service';

/**
 * The company-phone SMS gateway end to end, against the real test database
 * (see e2e-setup.ts), with SMS_PROVIDER=phone-gateway: device auth, the
 * heartbeat, an OTP request queueing exactly one SMS, the at-most-once
 * long-poll (never leased twice, not even by concurrent polls), result
 * transitions, the offline and daily-cap refusals that leave no code
 * behind, and the sweeper. Then the hardening: a resend cancels the older
 * SMS, simultaneous requests make one code, the per-phone cap and the
 * Myanmar-mobile-only rule, body redaction and account close, and the
 * phone's own "cannot send" verdict. Then the 2026-10-06 audit fixes: the
 * token is bound to ONE device (H-5 / H-7; a super admin resets the pin)
 * and a reported, expired or abandoned job loses its body at once (a
 * privacy extra, asked for by no finding).
 *
 * This spec owns sms_messages, sms_gateway_devices and sms_gateway_binding
 * in the test database: it empties them before it starts and after it
 * ends. The story runs in order; each `it` may continue from the last.
 */
describe('SMS gateway (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sms: SmsService;
  let gateway: SmsGatewayService;
  let sweeper: SmsSweeperService;

  const DEVICE = randomUUID();
  const OTHER_DEVICE = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const newPhone = () => `+959${randomInt(10_000_000, 99_999_999)}`;
  const phones: string[] = [];
  const userIds: string[] = [];
  let superAdminToken: string;
  let userToken: string;

  const api = () => request(app.getHttpServer());
  const asDevice = (id: string = DEVICE, token = E2E_SMS_GATEWAY_TOKEN) => ({
    Authorization: `Bearer ${token}`,
    'X-Device-Id': id,
  });
  const heartbeatBody = (overrides: Record<string, unknown> = {}) => ({
    appVersion: '1.0.0 (1)',
    battery: 87,
    charging: true,
    signalLevel: 3,
    networkType: 'LTE',
    simOperator: 'ATOM',
    pendingResults: 0,
    lastError: null,
    ...overrides,
  });
  const heartbeat = (id: string = DEVICE) =>
    api()
      .post('/api/sms-gateway/device/heartbeat')
      .set(asDevice(id))
      .send(heartbeatBody())
      .expect(200);
  const poll = (id: string = DEVICE, wait = 0) =>
    api().get(`/api/sms-gateway/device/jobs?wait=${wait}`).set(asDevice(id));
  const report = (
    jobId: string,
    status: string,
    id: string = DEVICE,
    extra: Record<string, unknown> = {},
  ) =>
    api()
      .post(`/api/sms-gateway/device/jobs/${jobId}/result`)
      .set(asDevice(id))
      .send({ status, occurredAt: new Date().toISOString(), ...extra });
  const requestCode = (phone: string, purpose?: 'login' | 'password_reset') => {
    phones.push(phone);
    return api()
      .post('/api/auth/otp/request')
      .send(purpose ? { phone, purpose } : { phone });
  };
  const messagesFor = (phone: string) =>
    prisma.smsMessage.findMany({ where: { phone } });
  /** The SMS text OtpService queues: "MyanFlix: 482 913" (owner-tested form, 2026-10-01). */
  const SMS_TEXT_PATTERN = /^MyanFlix: \d{3} \d{3}$/;
  const bindingRow = () =>
    prisma.smsGatewayBinding.findUnique({ where: { id: 1 } });
  const resetBinding = (token: string) =>
    api()
      .delete('/api/sms-gateway/binding')
      .set('Authorization', `Bearer ${token}`);
  /** Moves every code for `phone` back in time, past the 60 s cooldown. */
  const ageCodes = (phone: string, seconds = 61) =>
    prisma.otpCode.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - seconds * 1000) },
    });
  /** Leases whatever is still queued, so the next test starts empty. */
  async function drainQueue(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const res = await poll().expect(200);
      if ((res.body.data.jobs as unknown[]).length === 0) return;
    }
    throw new Error('queue never drained');
  }
  /** A customer with a phone number (and an empty wallet). */
  async function createCustomer(phone: string) {
    phones.push(phone);
    const user = await prisma.user.create({
      data: {
        username: `sms_cust_${randomUUID().slice(0, 8)}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        phone,
      },
    });
    userIds.push(user.id);
    await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });
    return user;
  }

  /** Queues a message straight through SmsService (no OTP row). */
  async function queueDirect(): Promise<string> {
    const phone = newPhone();
    phones.push(phone);
    await sms.send(phone, 'e2e gateway message');
    const [row] = await messagesFor(phone);
    return row.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Concurrent polls below: listen on an ephemeral port first so
    // supertest never starts and closes its own listener under a sibling
    // request (see auth-refresh.e2e-spec.ts). app.close() shuts it down.
    await app.listen(0);

    prisma = app.get(PrismaService);
    sms = app.get(SmsService);
    gateway = app.get(SmsGatewayService);
    sweeper = app.get(SmsSweeperService);
    const jwt = app.get(JwtService);
    const secret = app.get(ConfigService).get<string>('JWT_SECRET');

    await prisma.smsMessage.deleteMany({});
    await prisma.smsGatewayDevice.deleteMany({});
    await prisma.smsGatewayBinding.deleteMany({});

    const superAdminRole = await prisma.appRole.findUniqueOrThrow({
      where: { key: Role.SUPER_ADMIN },
    });
    const superAdmin = await prisma.user.create({
      data: {
        username: `sms_super_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        appRoleId: superAdminRole.id,
      },
    });
    const user = await prisma.user.create({
      data: {
        username: `sms_user_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
      },
    });
    userIds.push(superAdmin.id, user.id);
    for (const id of userIds) {
      await prisma.wallet.create({ data: { userId: id, balance: 0 } });
    }
    superAdminToken = await jwt.signAsync(
      { sub: superAdmin.id },
      { secret, expiresIn: '15m' },
    );
    userToken = await jwt.signAsync(
      { sub: user.id },
      { secret, expiresIn: '15m' },
    );
  });

  afterAll(async () => {
    try {
      await prisma.smsMessage.deleteMany({});
      await prisma.smsGatewayDevice.deleteMany({});
      await prisma.smsGatewayBinding.deleteMany({});
      await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
        },
      });
      await prisma.userSession.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      // Always release the listener, or a failed clean-up hangs the run.
      await app?.close();
    }
  });

  describe('device auth', () => {
    const routes = () => [
      api().post('/api/sms-gateway/device/heartbeat').send(heartbeatBody()),
      api().get('/api/sms-gateway/device/jobs?wait=0'),
      api()
        .post(`/api/sms-gateway/device/jobs/${randomUUID()}/result`)
        .send({ status: 'SENT', occurredAt: new Date().toISOString() }),
    ];

    it('401 "Unauthorized" on every device route without headers', async () => {
      for (const call of routes()) {
        const res = await call.expect(401);
        expect(res.body).toEqual({ success: false, message: 'Unauthorized' });
      }
    });

    it('401 with a wrong token, a missing X-Device-Id, or a user JWT', async () => {
      for (const call of routes()) {
        await call.set(asDevice(DEVICE, 'wrong-token')).expect(401);
      }
      for (const call of routes()) {
        await call
          .set('Authorization', `Bearer ${E2E_SMS_GATEWAY_TOKEN}`)
          .expect(401);
      }
      for (const call of routes()) {
        await call
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Device-Id', DEVICE)
          .expect(401);
      }
      expect(await prisma.smsGatewayDevice.count()).toBe(0);
      // A wrong token never pins a device (the token check comes first).
      expect(await bindingRow()).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('upserts the device row and answers with the server time and poll wait', async () => {
      const res = await heartbeat();

      expect(res.body.success).toBe(true);
      expect(res.body.data.pollWaitSeconds).toBe(25);
      expect(
        Math.abs(Date.parse(res.body.data.serverTime) - Date.now()),
      ).toBeLessThan(5_000);
      const row = await prisma.smsGatewayDevice.findUniqueOrThrow({
        where: { id: DEVICE },
      });
      expect(row).toMatchObject({
        appVersion: '1.0.0 (1)',
        battery: 87,
        charging: true,
        signalLevel: 3,
        networkType: 'LTE',
        simOperator: 'ATOM',
        pendingResults: 0,
        lastError: null,
        // An app that does not report canSend is taken at its word as able.
        canSend: true,
        notReadyReason: null,
      });
    });

    it('a second heartbeat updates the same row', async () => {
      await api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice())
        .send(
          heartbeatBody({
            battery: 42,
            charging: false,
            signalLevel: null,
            pendingResults: 3,
            lastError: 'RESULT_ERROR_NO_SERVICE',
          }),
        )
        .expect(200);

      expect(await prisma.smsGatewayDevice.count()).toBe(1);
      expect(
        await prisma.smsGatewayDevice.findUniqueOrThrow({
          where: { id: DEVICE },
        }),
      ).toMatchObject({
        battery: 42,
        charging: false,
        signalLevel: null,
        pendingResults: 3,
        lastError: 'RESULT_ERROR_NO_SERVICE',
      });
    });

    it('400 for a malformed heartbeat', async () => {
      await api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice())
        .send(heartbeatBody({ battery: 101 }))
        .expect(400);
    });
  });

  describe('device binding (H-5 / H-7): the token belongs to ONE phone', () => {
    const asSuperAdmin = () =>
      api()
        .get('/api/sms-gateway/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

    it('the first device to present the token is pinned, and the status card names it', async () => {
      expect(await bindingRow()).toMatchObject({
        deviceId: DEVICE,
        lastRejectedDeviceId: null,
        rejectedCount: 0,
      });

      const card = await asSuperAdmin();
      expect(card.body.data.binding).toMatchObject({
        deviceId: DEVICE,
        lastRejectedDeviceId: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      });
      expect(Date.parse(card.body.data.binding.pinnedAt)).not.toBeNaN();
      expect(card.body.data.device.id).toBe(DEVICE);
    });

    it('every other device gets the same 401 on every route, creates no device row, and is noted for the admin card', async () => {
      const calls = [
        api()
          .post('/api/sms-gateway/device/heartbeat')
          .set(asDevice(OTHER_DEVICE))
          .send(heartbeatBody()),
        api()
          .get('/api/sms-gateway/device/jobs?wait=0')
          .set(asDevice(OTHER_DEVICE)),
        api()
          .post(`/api/sms-gateway/device/jobs/${randomUUID()}/result`)
          .set(asDevice(OTHER_DEVICE))
          .send({ status: 'SENT', occurredAt: new Date().toISOString() }),
      ];
      for (const call of calls) {
        const res = await call.expect(401);
        expect(res.body).toEqual({ success: false, message: 'Unauthorized' });
      }

      expect(await prisma.smsGatewayDevice.count()).toBe(1);
      expect(await bindingRow()).toMatchObject({
        deviceId: DEVICE,
        lastRejectedDeviceId: OTHER_DEVICE,
        rejectedCount: 3,
      });
      const card = await asSuperAdmin();
      expect(card.body.data.binding).toMatchObject({
        deviceId: DEVICE,
        lastRejectedDeviceId: OTHER_DEVICE,
        rejectedCount: 3,
      });
      expect(
        Date.now() - Date.parse(card.body.data.binding.lastRejectedAt),
      ).toBeLessThan(10_000);
      // The real phone is unaffected.
      await heartbeat();
    });

    it('reset: 401 without a token, 403 for a customer', async () => {
      await api().delete('/api/sms-gateway/binding').expect(401);
      await resetBinding(userToken).expect(403);
      expect((await bindingRow())!.deviceId).toBe(DEVICE);
    });

    it('a super admin resets the pin: the next phone to present the token is pinned, the old one is refused, and an audit row is written', async () => {
      const reset = await resetBinding(superAdminToken).expect(200);
      expect(reset.body.data).toMatchObject({
        deviceId: null,
        pinnedAt: null,
        lastRejectedDeviceId: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      });
      expect(Date.parse(reset.body.data.resetAt)).not.toBeNaN();
      const audit = await prisma.auditLog.findMany({
        where: { action: 'sms_gateway.binding_reset' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ targetType: 'sms_gateway' });

      // The reinstalled phone (a new uuid) registers; the old uuid is out.
      await heartbeat(OTHER_DEVICE);
      expect((await bindingRow())!.deviceId).toBe(OTHER_DEVICE);
      await poll(DEVICE).expect(401);
      expect((await bindingRow())!.lastRejectedDeviceId).toBe(DEVICE);

      // And back, so the rest of the story runs on DEVICE.
      await resetBinding(superAdminToken).expect(200);
      await heartbeat();
      expect((await bindingRow())!.deviceId).toBe(DEVICE);
      await poll(OTHER_DEVICE).expect(401);
      await prisma.smsGatewayDevice.deleteMany({ where: { id: OTHER_DEVICE } });
      expect(await prisma.smsGatewayDevice.count()).toBe(1);
    });
  });

  describe('an OTP request, sent through the phone', () => {
    const phone = newPhone();
    let jobId: string;

    it('queues exactly one SMS carrying that code', async () => {
      await requestCode(phone).expect(200);

      const codes = await prisma.otpCode.findMany({ where: { phone } });
      const messages = await messagesFor(phone);
      expect(codes).toHaveLength(1);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        otpCodeId: codes[0].id,
        status: SmsMessageStatus.QUEUED,
        deviceId: null,
        expiresAt: codes[0].expiresAt,
      });
      // M-1: the row holds only a keyed hash; the SMS carries the digits.
      const sentCode = messages[0].body.replace(/\D/g, '');
      expect(sentCode).toMatch(/^\d{6}$/);
      expect(codes[0].codeHash).toBe(
        OtpCodeHasher.fromConfig(app.get(ConfigService)).hash(phone, sentCode),
      );
      jobId = messages[0].id;
    });

    it('a resend inside the cooldown is refused and queues nothing more', async () => {
      await requestCode(phone).expect(409);

      expect(await messagesFor(phone)).toHaveLength(1);
    });

    it('the same code is never queued twice', async () => {
      const [code] = await prisma.otpCode.findMany({ where: { phone } });

      await sms.send(phone, 'duplicate', { otpCodeId: code.id });

      expect(await messagesFor(phone)).toHaveLength(1);
    });

    it('a long-poll leases it once; the next poll gets nothing', async () => {
      const first = await poll().expect(200);

      expect(first.body.success).toBe(true);
      expect(first.body.data.jobs).toHaveLength(1);
      const [job] = first.body.data.jobs as {
        id: string;
        phone: string;
        body: string;
        expiresAt: string;
      }[];
      const row = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(job).toEqual({
        id: jobId,
        phone,
        body: row.body,
        expiresAt: row.expiresAt.toISOString(),
      });
      expect(row.status).toBe(SmsMessageStatus.LEASED);
      expect(row.deviceId).toBe(DEVICE);
      expect(row.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(
        row.leasedAt!.getTime() + 60_000,
      );
      expect(row.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(
        row.expiresAt.getTime(),
      );

      const second = await poll().expect(200);
      expect(second.body.data).toEqual({ jobs: [] });
      // Another device is not even let in (H-5).
      await poll(OTHER_DEVICE).expect(401);
    });

    it('only the device that leased it may report (401 for another device, 404 for a job it never leased)', async () => {
      const res = await report(jobId, 'SENT', OTHER_DEVICE).expect(401);
      expect(res.body.success).toBe(false);
      await report(randomUUID(), 'SENT').expect(404);
      await report('not-a-uuid', 'SENT').expect(400);
    });

    it('LEASED -> SENT blanks the body at once (privacy extra), then an idempotent repeat', async () => {
      const sent = await report(jobId, 'SENT').expect(200);
      expect(sent.body).toEqual({
        success: true,
        data: { id: jobId, status: 'SENT' },
      });
      const again = await report(jobId, 'SENT').expect(200);
      expect(again.body.data).toEqual({ id: jobId, status: 'SENT' });

      const row = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(row.status).toBe(SmsMessageStatus.SENT);
      expect(row.sentAt).not.toBeNull();
      // The code is gone from the database the moment it was sent.
      expect(row.body).toBe(SMS_REDACTED);
      expect(row.redactedAt).not.toBeNull();
      expect(row.phone).toBe(phone);
    });

    it('SENT -> DELIVERED, a repeat, then 409 for anything else', async () => {
      await report(jobId, 'DELIVERED').expect(200);
      await report(jobId, 'DELIVERED').expect(200);
      const late = await report(jobId, 'SENT').expect(409);
      expect(late.body.success).toBe(false);
      await report(jobId, 'FAILED').expect(409);
      await report(jobId, 'DELIVERY_FAILED').expect(409);

      const row = await prisma.smsMessage.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(row.status).toBe(SmsMessageStatus.DELIVERED);
      expect(row.deliveredAt).not.toBeNull();
    });

    it('400 for a result the phone may not report', async () => {
      await report(jobId, 'QUEUED').expect(400);
      await report(jobId, 'SENT', DEVICE, { occurredAt: 'yesterday' }).expect(
        400,
      );
    });
  });

  describe('failures and late reports', () => {
    it('LEASED -> FAILED keeps the error; SENT is then a 409', async () => {
      const id = await queueDirect();
      const leased = await poll().expect(200);
      expect(leased.body.data.jobs[0].id).toBe(id);

      await report(id, 'FAILED', DEVICE, {
        errorCode: 'RESULT_ERROR_NO_SERVICE',
        errorMessage: 'No service',
      }).expect(200);
      await report(id, 'SENT').expect(409);

      expect(
        await prisma.smsMessage.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: SmsMessageStatus.FAILED,
        errorCode: 'RESULT_ERROR_NO_SERVICE',
        errorMessage: 'No service',
        body: SMS_REDACTED,
      });
    });

    it('a lease that runs out turns UNKNOWN (never re-queued), and a late SENT still lands', async () => {
      const id = await queueDirect();
      await poll().expect(200);
      await prisma.smsMessage.update({
        where: { id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });

      // (The app's own 30 s sweeper may get there first; either way the
      // row must end UNKNOWN.)
      await sweeper.sweep();

      expect(
        await prisma.smsMessage.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: SmsMessageStatus.UNKNOWN, body: SMS_REDACTED });
      expect((await poll().expect(200)).body.data.jobs).toEqual([]);

      await report(id, 'SENT').expect(200);
      expect(
        (await prisma.smsMessage.findUniqueOrThrow({ where: { id } })).status,
      ).toBe(SmsMessageStatus.SENT);
    });

    it('a QUEUED row past its expiry is never leased and is swept to EXPIRED', async () => {
      const expired = await prisma.smsMessage.create({
        data: {
          phone: newPhone(),
          body: 'e2e expired message',
          expiresAt: new Date(Date.now() - 1_000),
        },
      });

      expect((await poll().expect(200)).body.data.jobs).toEqual([]);
      await sweeper.sweep();

      expect(
        await prisma.smsMessage.findUniqueOrThrow({
          where: { id: expired.id },
        }),
      ).toMatchObject({ status: SmsMessageStatus.EXPIRED, body: SMS_REDACTED });
      // No device ever leased it, so no device can report on it.
      await report(expired.id, 'SENT').expect(404);
    });
  });

  describe('concurrency', () => {
    it('concurrent polls from many other devices lease nothing (401, H-5); the pinned phone then takes each job exactly once', async () => {
      const queued: string[] = [];
      for (let i = 0; i < 5; i++) queued.push(await queueDirect());
      const devices = Array.from({ length: 8 }, () => randomUUID());

      await Promise.all(devices.map((id) => poll(id).expect(401)));

      const untouched = await prisma.smsMessage.findMany({
        where: { id: { in: queued } },
      });
      expect(untouched.every((r) => r.status === SmsMessageStatus.QUEUED)).toBe(
        true,
      );
      expect(await prisma.smsGatewayDevice.count()).toBe(1);

      const leased: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await poll().expect(200);
        leased.push(
          ...(res.body.data.jobs as { id: string }[]).map((j) => j.id),
        );
      }
      expect(new Set(leased).size).toBe(leased.length);
      expect([...leased].sort()).toEqual([...queued].sort());
      const rows = await prisma.smsMessage.findMany({
        where: { id: { in: queued } },
      });
      expect(rows.every((r) => r.status === SmsMessageStatus.LEASED)).toBe(
        true,
      );
    });

    it('twenty racing leases over ten jobs hand out each job exactly once', async () => {
      const queued: string[] = [];
      for (let i = 0; i < 10; i++) queued.push(await queueDirect());

      const results = await Promise.all(
        Array.from({ length: 20 }, () => gateway.leaseNext(randomUUID())),
      );

      const leased = results
        .filter((job): job is NonNullable<typeof job> => job !== null)
        .map((job) => job.id);
      expect(leased).toHaveLength(10);
      expect(new Set(leased).size).toBe(10);
      expect([...leased].sort()).toEqual([...queued].sort());
    });

    it('a waiting long-poll returns the moment a job is queued', async () => {
      const started = Date.now();
      const waiting = poll(DEVICE, 20);
      const queuedId = new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          queueDirect().then(resolve, reject);
        }, 300);
      });

      const [res, id] = await Promise.all([waiting, queuedId]);

      expect(res.status).toBe(200);
      expect(res.body.data.jobs.map((j: { id: string }) => j.id)).toEqual([id]);
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });

  describe('B1: a resend cancels the older SMS', () => {
    it('a newer code for the same phone and purpose cancels the older SMS still QUEUED; the phone only ever gets the new code', async () => {
      const phone = newPhone();
      await requestCode(phone).expect(200);
      const [first] = await messagesFor(phone);
      await ageCodes(phone);

      await requestCode(phone).expect(200);

      const codes = await prisma.otpCode.findMany({
        where: { phone },
        orderBy: { createdAt: 'asc' },
      });
      expect(codes).toHaveLength(2);
      const rows = await messagesFor(phone);
      expect(rows).toHaveLength(2);
      const stale = rows.find((r) => r.id === first.id)!;
      const fresh = rows.find((r) => r.id !== first.id)!;
      expect(stale).toMatchObject({
        otpCodeId: codes[0].id,
        status: SmsMessageStatus.CANCELLED,
        deviceId: null,
      });
      expect(fresh).toMatchObject({
        otpCodeId: codes[1].id,
        status: SmsMessageStatus.QUEUED,
      });

      const leased = await poll().expect(200);
      expect(leased.body.data.jobs).toHaveLength(1);
      expect(leased.body.data.jobs[0].id).toBe(fresh.id);
      // The phone gets the new code's text ("MyanFlix: 482 913" since 2026-10-01).
      expect(leased.body.data.jobs[0].body).toMatch(SMS_TEXT_PATTERN);
      // The cancelled one is never handed out, and no device can report on it.
      expect((await poll().expect(200)).body.data.jobs).toEqual([]);
      await report(stale.id, 'SENT').expect(404);
    });

    it('an SMS the phone already leased is left alone (it may be sending)', async () => {
      const phone = newPhone();
      await requestCode(phone).expect(200);
      const [first] = await messagesFor(phone);
      const leased = await poll().expect(200);
      expect(leased.body.data.jobs[0].id).toBe(first.id);
      await ageCodes(phone);

      await requestCode(phone).expect(200);

      const rows = await messagesFor(phone);
      expect(rows.find((r) => r.id === first.id)!.status).toBe(
        SmsMessageStatus.LEASED,
      );
      expect(rows.find((r) => r.id !== first.id)!.status).toBe(
        SmsMessageStatus.QUEUED,
      );
      await report(first.id, 'SENT').expect(200);
      await drainQueue();
    });

    it('a code for the other purpose does not cancel it', async () => {
      const phone = newPhone();
      await createCustomer(phone);
      await requestCode(phone, 'login').expect(200);
      const [signIn] = await messagesFor(phone);

      await requestCode(phone, 'password_reset').expect(200);

      const rows = await messagesFor(phone);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status)).toEqual([
        SmsMessageStatus.QUEUED,
        SmsMessageStatus.QUEUED,
      ]);
      expect(rows.some((r) => r.id === signIn.id)).toBe(true);
      await drainQueue();
    });
  });

  describe('B2: simultaneous requests make one code', () => {
    it('five requests for one phone at once: one 200, four 409 "Please wait", ONE code and ONE SMS', async () => {
      const phone = newPhone();
      phones.push(phone);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          api().post('/api/auth/otp/request').send({ phone }),
        ),
      );

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409]);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(res.body).toEqual({
          success: false,
          message: 'Please wait before requesting another code',
        });
      }
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(1);
      const rows = await messagesFor(phone);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(SmsMessageStatus.QUEUED);
      await drainQueue();
    });

    it('simultaneous requests for different phones never hold each other up', async () => {
      const many = Array.from({ length: 5 }, () => newPhone());

      const responses = await Promise.all(
        many.map((phone) => requestCode(phone)),
      );

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      for (const phone of many) {
        expect(await messagesFor(phone)).toHaveLength(1);
      }
      await drainQueue();
    });
  });

  describe('B3: abuse protection', () => {
    it(`a number that already got ${E2E_SMS_DAILY_CAP_PER_PHONE} SMS today gets the 409 "Too many code requests": no code, no SMS`, async () => {
      const phone = newPhone();
      phones.push(phone);
      await prisma.smsMessage.createMany({
        data: [
          SmsMessageStatus.SENT,
          SmsMessageStatus.DELIVERED,
          SmsMessageStatus.FAILED,
        ].map((status) => ({
          phone,
          body: 'e2e earlier code',
          status,
          expiresAt: new Date(),
        })),
      });

      const res = await requestCode(phone).expect(409);

      expect(res.body).toEqual({
        success: false,
        message: TOO_MANY_CODE_REQUESTS_MESSAGE,
      });
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(0);
      expect(await messagesFor(phone)).toHaveLength(3);
    });

    it('SMS that never left the server (cancelled, expired) and yesterday’s do not count', async () => {
      const phone = newPhone();
      phones.push(phone);
      const yesterday = new Date(
        startOfUtcDay(new Date()).getTime() - 60 * 60 * 1000,
      );
      await prisma.smsMessage.createMany({
        data: [
          { status: SmsMessageStatus.CANCELLED },
          { status: SmsMessageStatus.EXPIRED },
          { status: SmsMessageStatus.CANCELLED },
          { status: SmsMessageStatus.SENT, createdAt: yesterday },
          { status: SmsMessageStatus.SENT, createdAt: yesterday },
          { status: SmsMessageStatus.SENT, createdAt: yesterday },
        ].map((row) => ({
          phone,
          body: 'e2e earlier code',
          expiresAt: new Date(),
          ...row,
        })),
      });

      await requestCode(phone).expect(200);

      expect(await prisma.otpCode.count({ where: { phone } })).toBe(1);
      // Yesterday's rows would skew the daily-cap test's arithmetic.
      await prisma.smsMessage.deleteMany({
        where: { phone, createdAt: { lt: startOfUtcDay(new Date()) } },
      });
      await drainQueue();
    });

    it('only Myanmar mobile numbers (+959...) are queued: anything else is a 400 and leaves no code', async () => {
      // +95 1 ... is a Yangon landline: the request DTO accepts it.
      const landline = '+951234567';

      const res = await requestCode(landline).expect(400);

      expect(res.body).toEqual({
        success: false,
        message: 'Enter a valid Myanmar phone number',
      });
      expect(await prisma.otpCode.count({ where: { phone: landline } })).toBe(
        0,
      );
      expect(await messagesFor(landline)).toHaveLength(0);
      for (const phone of ['+14155550123', '+95912345', '+9591234567890']) {
        await expect(sms.send(phone, 'e2e')).rejects.toThrow(
          BadRequestException,
        );
        expect(await messagesFor(phone)).toHaveLength(0);
      }
    });
  });

  describe('B4: privacy', () => {
    const CODE_BODY = '482913 - MyanFlix';

    it('privacy extra: the sweeper redacts the body of every final row at once, whatever its age, and nothing else', async () => {
      const hourAgo = new Date(Date.now() - 61 * 60 * 1000);
      const finals = [
        SmsMessageStatus.SENT,
        SmsMessageStatus.DELIVERED,
        SmsMessageStatus.FAILED,
        SmsMessageStatus.DELIVERY_FAILED,
        SmsMessageStatus.EXPIRED,
        SmsMessageStatus.UNKNOWN,
        SmsMessageStatus.CANCELLED,
      ];
      const create = (data: {
        status: SmsMessageStatus;
        createdAt: Date;
        expiresAt?: Date;
        deviceId?: string;
        leaseExpiresAt?: Date;
      }) =>
        prisma.smsMessage.create({
          data: {
            phone: newPhone(),
            body: CODE_BODY,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            ...data,
          },
        });
      const old = await Promise.all(
        finals.map((status) => create({ status, createdAt: hourAgo })),
      );
      // Not final (cannot really be an hour old, but must never be touched).
      const live = await Promise.all([
        create({ status: SmsMessageStatus.QUEUED, createdAt: hourAgo }),
        create({
          status: SmsMessageStatus.LEASED,
          createdAt: hourAgo,
          deviceId: OTHER_DEVICE,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ]);
      const young = await create({
        status: SmsMessageStatus.SENT,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      const ids = [...old, ...live, young].map((r) => r.id);

      try {
        await sweeper.sweep();

        const after = await prisma.smsMessage.findMany({
          where: { id: { in: ids } },
        });
        const byId = new Map(after.map((r) => [r.id, r]));
        // Final rows lose their body whether they are an hour old or brand new.
        for (const row of [...old, young]) {
          const now = byId.get(row.id)!;
          expect(now.body).toBe(SMS_REDACTED);
          expect(now.redactedAt).not.toBeNull();
          expect(now.phone).toBe(row.phone);
          expect(now.status).toBe(row.status);
        }
        // QUEUED and LEASED rows still need theirs: the phone has yet to send.
        for (const row of live) {
          expect(byId.get(row.id)!.body).toBe(CODE_BODY);
          expect(byId.get(row.id)!.redactedAt).toBeNull();
        }
      } finally {
        // Old timestamps (and a QUEUED row) would disturb later tests.
        await prisma.smsMessage.deleteMany({ where: { id: { in: ids } } });
      }
    });

    it('closing the account redacts that phone from sms_messages and cancels its QUEUED SMS', async () => {
      const phone = newPhone();
      const other = newPhone();
      const customer = await createCustomer(phone);
      const token = await app.get(JwtService).signAsync(
        { sub: customer.id },
        {
          secret: app.get(ConfigService).get<string>('JWT_SECRET'),
          expiresIn: '15m',
        },
      );
      await requestCode(phone).expect(200);
      const [queued] = await messagesFor(phone);
      const sent = await prisma.smsMessage.create({
        data: {
          phone,
          body: CODE_BODY,
          status: SmsMessageStatus.SENT,
          expiresAt: new Date(),
        },
      });
      const leased = await prisma.smsMessage.create({
        data: {
          phone,
          body: CODE_BODY,
          status: SmsMessageStatus.LEASED,
          deviceId: DEVICE,
          leasedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const control = await prisma.smsMessage.create({
        data: {
          phone: other,
          body: CODE_BODY,
          status: SmsMessageStatus.SENT,
          expiresAt: new Date(),
        },
      });

      await api()
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(await prisma.smsMessage.count({ where: { phone } })).toBe(0);
      const rows = await prisma.smsMessage.findMany({
        where: { id: { in: [queued.id, sent.id, leased.id] } },
      });
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.phone).toBe(SMS_REDACTED);
        expect(row.body).toBe(SMS_REDACTED);
        expect(row.redactedAt).not.toBeNull();
      }
      const status = new Map(rows.map((r) => [r.id, r.status]));
      expect(status.get(queued.id)).toBe(SmsMessageStatus.CANCELLED);
      expect(status.get(sent.id)).toBe(SmsMessageStatus.SENT);
      // The phone already holds the leased one; its result still lands.
      expect(status.get(leased.id)).toBe(SmsMessageStatus.LEASED);
      await report(leased.id, 'SENT').expect(200);
      expect(
        await prisma.smsMessage.findUniqueOrThrow({
          where: { id: control.id },
        }),
      ).toMatchObject({ phone: other, body: CODE_BODY, redactedAt: null });
      // Nothing of that phone is left to lease.
      expect((await poll().expect(200)).body.data.jobs).toEqual([]);
    });
  });

  describe('B5: the phone says it cannot send', () => {
    const agoOthers = () =>
      prisma.smsGatewayDevice.updateMany({
        where: { id: { not: DEVICE } },
        data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

    it('a heartbeat with canSend=false turns the gateway offline: 503, nothing leased, shown on the status card; canSend=true brings it back', async () => {
      await agoOthers();
      await api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice())
        .send(heartbeatBody({ canSend: false, notReadyReason: 'no_service' }))
        .expect(200);
      expect(
        await prisma.smsGatewayDevice.findUniqueOrThrow({
          where: { id: DEVICE },
        }),
      ).toMatchObject({ canSend: false, notReadyReason: 'no_service' });
      const phone = newPhone();

      const refused = await requestCode(phone).expect(503);

      expect(refused.body).toEqual({
        success: false,
        message: SMS_UNAVAILABLE_MESSAGE,
      });
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(0);
      const card = await api()
        .get('/api/sms-gateway/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);
      expect(card.body.data.online).toBe(false);
      expect(card.body.data.device).toMatchObject({
        id: DEVICE,
        canSend: false,
        notReadyReason: 'no_service',
      });

      // A job queued before the phone lost its ability waits for it.
      const waiting = await prisma.smsMessage.create({
        data: {
          phone: newPhone(),
          body: 'e2e waiting message',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });
      expect((await poll().expect(200)).body.data.jobs).toEqual([]);
      expect(
        (
          await prisma.smsMessage.findUniqueOrThrow({
            where: { id: waiting.id },
          })
        ).status,
      ).toBe(SmsMessageStatus.QUEUED);

      // Able again (an app that omits canSend counts as able).
      await heartbeat();
      expect(
        await prisma.smsGatewayDevice.findUniqueOrThrow({
          where: { id: DEVICE },
        }),
      ).toMatchObject({ canSend: true, notReadyReason: null });
      await requestCode(phone).expect(200);
      const next = await poll().expect(200);
      expect(next.body.data.jobs[0].id).toBe(waiting.id);
      await drainQueue();
    });

    it('400 for a canSend that is not a boolean or a notReadyReason over 64 characters', async () => {
      for (const bad of [
        { canSend: 'maybe' },
        { canSend: false, notReadyReason: 'x'.repeat(65) },
        { canSend: false, notReadyReason: 42 },
      ]) {
        await api()
          .post('/api/sms-gateway/device/heartbeat')
          .set(asDevice())
          .send(heartbeatBody(bad))
          .expect(400);
      }
      await heartbeat();
    });

    it("accepts the gateway app's own heartbeat shape: canSend with a null notReadyReason, and a 64-character reason", async () => {
      const stored = () =>
        prisma.smsGatewayDevice.findUniqueOrThrow({ where: { id: DEVICE } });
      // What OkHttpGatewayApi sends while the phone can send.
      await api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice())
        .send(heartbeatBody({ canSend: true, notReadyReason: null }))
        .expect(200);
      expect(await stored()).toMatchObject({
        canSend: true,
        notReadyReason: null,
      });

      // The app clips the reason to 64 characters; exactly 64 is accepted.
      const longest = 'r'.repeat(64);
      await api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice())
        .send(heartbeatBody({ canSend: false, notReadyReason: longest }))
        .expect(200);
      expect(await stored()).toMatchObject({
        canSend: false,
        notReadyReason: longest,
      });

      await heartbeat();
      expect(await stored()).toMatchObject({
        canSend: true,
        notReadyReason: null,
      });
    });
  });

  describe('refusals leave no code behind', () => {
    it('offline gateway: 503 with the exact message, no code row, no SMS, cooldown not spent', async () => {
      await prisma.smsGatewayDevice.updateMany({
        data: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) },
      });
      const phone = newPhone();

      const res = await requestCode(phone).expect(503);

      expect(res.body).toEqual({
        success: false,
        message: SMS_UNAVAILABLE_MESSAGE,
      });
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(0);
      expect(await messagesFor(phone)).toHaveLength(0);

      // Back online: the same phone can ask again at once.
      await heartbeat();
      await requestCode(phone).expect(200);
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(1);
      expect(await messagesFor(phone)).toHaveLength(1);
    });

    it('daily cap reached: 503 with the exact message and no code row', async () => {
      await heartbeat();
      const today = await prisma.smsMessage.count();
      const filler = E2E_SMS_DAILY_CAP - today;
      expect(filler).toBeGreaterThan(0);
      await prisma.smsMessage.createMany({
        data: Array.from({ length: filler }, () => ({
          phone: '+959000000000',
          body: 'e2e cap filler',
          status: SmsMessageStatus.EXPIRED,
          expiresAt: new Date(),
        })),
      });
      const phone = newPhone();

      const res = await requestCode(phone).expect(503);

      expect(res.body.message).toBe(SMS_UNAVAILABLE_MESSAGE);
      expect(await prisma.otpCode.count({ where: { phone } })).toBe(0);
      expect(await prisma.smsMessage.count()).toBe(E2E_SMS_DAILY_CAP);
    });
  });

  describe('staff status', () => {
    it('401 without a token, 403 for a customer', async () => {
      await api().get('/api/sms-gateway/status').expect(401);
      await api()
        .get('/api/sms-gateway/status')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('a super admin sees provider, online, the last device, today and the cap', async () => {
      const res = await api()
        .get('/api/sms-gateway/status')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .expect(200);

      const status = res.body.data;
      expect(status.provider).toBe('phone-gateway');
      expect(status.online).toBe(true);
      expect(status.dailyCap).toBe(E2E_SMS_DAILY_CAP);
      expect(status.device).toMatchObject({
        id: DEVICE,
        appVersion: '1.0.0 (1)',
        battery: 87,
        simOperator: 'ATOM',
        canSend: true,
        notReadyReason: null,
      });
      expect(status.binding).toMatchObject({ deviceId: DEVICE });
      expect(Object.keys(status.today).sort()).toEqual(
        [
          'cancelled',
          'delivered',
          'deliveryFailed',
          'expired',
          'failed',
          'leased',
          'queued',
          'sent',
          'unknown',
        ].sort(),
      );
      const total = Object.values(
        status.today as Record<string, number>,
      ).reduce((a, b) => a + b, 0);
      expect(total).toBe(E2E_SMS_DAILY_CAP);
      expect(status.today.delivered).toBeGreaterThanOrEqual(1);
      expect(status.today.failed).toBeGreaterThanOrEqual(1);
      expect(status.today.cancelled).toBeGreaterThanOrEqual(1);
    });
  });
});
