import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { AppThrottlerGuard } from '../common/throttling/app-throttler.guard';
import { buildThrottlerOptions } from '../common/throttling/throttling.config';
import { PERMISSIONS_KEY } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { Role } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { DeviceTokenGuard } from './device-token.guard';
import { SmsDeviceBindingService } from './sms-device-binding.service';
import {
  SMS_DEVICE_THROTTLE_PER_MINUTE,
  SmsGatewayDeviceController,
} from './sms-gateway-device.controller';
import {
  SMS_BINDING_RESET_SUPER_ADMIN_ONLY,
  SmsGatewayStatusController,
} from './sms-gateway-status.controller';
import { SmsGatewayService } from './sms-gateway.service';

const TOKEN = 'unit-sms-gateway-token-0123456789abcdef';
const DEVICE = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';
const OTHER_DEVICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_ID = '11111111-2222-4333-8444-555555555555';

const heartbeatBody = () => ({
  appVersion: '1.0.0',
  battery: 80,
  charging: false,
  signalLevel: null,
  networkType: 'LTE',
  simOperator: null,
  pendingResults: 0,
  lastError: null,
});

/**
 * The real device controller behind the real throttler guard, validation
 * pipe, exception filter and response envelope — only SmsGatewayService is
 * faked, so these prove the HTTP contract the gateway app is built to
 * without a database (sms-gateway.e2e-spec.ts covers the rest).
 */
describe('SmsGatewayDeviceController (HTTP)', () => {
  let app: INestApplication<App>;
  let gateway: {
    heartbeat: jest.Mock;
    pollJobs: jest.Mock;
    recordResult: jest.Mock;
  };
  let binding: { admit: jest.Mock };
  const savedToken = process.env.SMS_GATEWAY_TOKEN;
  const savedProxies = process.env.TRUSTED_PROXIES;

  const asDevice = (id = DEVICE, token = TOKEN) => ({
    Authorization: `Bearer ${token}`,
    'X-Device-Id': id,
  });

  beforeEach(async () => {
    process.env.SMS_GATEWAY_TOKEN = TOKEN;
    process.env.TRUSTED_PROXIES = '';
    gateway = {
      heartbeat: jest.fn().mockResolvedValue({
        serverTime: '2026-09-30T10:00:00.000Z',
        pollWaitSeconds: 25,
      }),
      pollJobs: jest.fn().mockResolvedValue({ jobs: [] }),
      recordResult: jest.fn().mockResolvedValue({ id: JOB_ID, status: 'SENT' }),
    };
    // Every device is the pinned one unless a test says otherwise.
    binding = { admit: jest.fn().mockResolvedValue(true) };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlerOptions())],
      controllers: [SmsGatewayDeviceController],
      providers: [
        DeviceTokenGuard,
        { provide: SmsGatewayService, useValue: gateway },
        { provide: SmsDeviceBindingService, useValue: binding },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'SMS_GATEWAY_TOKEN' ? TOKEN : undefined,
          },
        },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
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
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);
  });

  afterEach(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.SMS_GATEWAY_TOKEN;
    else process.env.SMS_GATEWAY_TOKEN = savedToken;
    if (savedProxies === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = savedProxies;
  });

  const api = () => request(app.getHttpServer());

  it('is @Public, so the global JWT guard never parses the gateway token', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SmsGatewayDeviceController)).toBe(
      true,
    );
  });

  it('401 { success: false, message: "Unauthorized" } on every route without the token', async () => {
    const calls = [
      api().post('/api/sms-gateway/device/heartbeat').send(heartbeatBody()),
      api().get('/api/sms-gateway/device/jobs'),
      api()
        .post(`/api/sms-gateway/device/jobs/${JOB_ID}/result`)
        .send({ status: 'SENT', occurredAt: '2026-09-30T10:00:00.000Z' }),
    ];
    for (const call of calls) {
      const res = await call.set(asDevice(DEVICE, 'wrong')).expect(401);
      expect(res.body).toEqual({ success: false, message: 'Unauthorized' });
    }
    await api()
      .post('/api/sms-gateway/device/heartbeat')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(heartbeatBody())
      .expect(401);
    expect(gateway.heartbeat).not.toHaveBeenCalled();
    expect(gateway.pollJobs).not.toHaveBeenCalled();
    expect(gateway.recordResult).not.toHaveBeenCalled();
    // A wrong token never reaches the device pin.
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('H-5: the same 401 on every route for a device the token is not pinned to; the service is never called', async () => {
    binding.admit.mockResolvedValue(false);
    const calls = [
      api().post('/api/sms-gateway/device/heartbeat').send(heartbeatBody()),
      api().get('/api/sms-gateway/device/jobs?wait=0'),
      api()
        .post(`/api/sms-gateway/device/jobs/${JOB_ID}/result`)
        .send({ status: 'SENT', occurredAt: '2026-09-30T10:00:00.000Z' }),
    ];
    for (const call of calls) {
      const res = await call.set(asDevice(OTHER_DEVICE)).expect(401);
      expect(res.body).toEqual({ success: false, message: 'Unauthorized' });
    }
    expect(binding.admit).toHaveBeenCalledWith(OTHER_DEVICE);
    expect(gateway.heartbeat).not.toHaveBeenCalled();
    expect(gateway.pollJobs).not.toHaveBeenCalled();
    expect(gateway.recordResult).not.toHaveBeenCalled();
  });

  it('heartbeat: 200 in the success envelope, for the device in X-Device-Id', async () => {
    const res = await api()
      .post('/api/sms-gateway/device/heartbeat')
      .set(asDevice(DEVICE.toUpperCase()))
      .send(heartbeatBody())
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { serverTime: '2026-09-30T10:00:00.000Z', pollWaitSeconds: 25 },
    });
    expect(gateway.heartbeat).toHaveBeenCalledWith(
      DEVICE,
      expect.objectContaining({ battery: 80, signalLevel: null }),
    );
  });

  it('heartbeat: 400 for a stray key', async () => {
    await api()
      .post('/api/sms-gateway/device/heartbeat')
      .set(asDevice())
      .send({ ...heartbeatBody(), imei: '1234' })
      .expect(400);
  });

  it('jobs: waits 25 s by default, or what ?wait= asks (0-30)', async () => {
    gateway.pollJobs.mockResolvedValueOnce({
      jobs: [
        {
          id: JOB_ID,
          phone: '+959123',
          body: 'b',
          expiresAt: '2026-09-30T10:05:00.000Z',
        },
      ],
    });

    const res = await api()
      .get('/api/sms-gateway/device/jobs')
      .set(asDevice())
      .expect(200);
    await api()
      .get('/api/sms-gateway/device/jobs?wait=7')
      .set(asDevice())
      .expect(200);
    await api()
      .get('/api/sms-gateway/device/jobs?wait=31')
      .set(asDevice())
      .expect(400);

    expect(res.body.data.jobs[0].id).toBe(JOB_ID);
    expect(gateway.pollJobs).toHaveBeenNthCalledWith(
      1,
      DEVICE,
      25,
      expect.any(AbortSignal),
    );
    expect(gateway.pollJobs).toHaveBeenNthCalledWith(
      2,
      DEVICE,
      7,
      expect.any(AbortSignal),
    );
    expect(gateway.pollJobs).toHaveBeenCalledTimes(2);
  });

  it('jobs: a phone that drops the connection aborts its poll (nothing is leased into it)', async () => {
    let signal: AbortSignal | undefined;
    const aborted = new Promise<void>((resolve) => {
      gateway.pollJobs.mockImplementation(
        (_id: string, _wait: number, s: AbortSignal) => {
          signal = s;
          return new Promise((done) => {
            s.addEventListener('abort', () => {
              resolve();
              done({ jobs: [] });
            });
          });
        },
      );
    });

    await expect(
      api()
        .get('/api/sms-gateway/device/jobs?wait=25')
        .set(asDevice())
        .timeout(150),
    ).rejects.toThrow();
    await aborted;

    expect(signal?.aborted).toBe(true);
  });

  it('result: 200 in the envelope; 400 for a bad id or body', async () => {
    const res = await api()
      .post(`/api/sms-gateway/device/jobs/${JOB_ID}/result`)
      .set(asDevice())
      .send({ status: 'SENT', occurredAt: '2026-09-30T10:00:00.000Z' })
      .expect(200);
    expect(res.body).toEqual({
      success: true,
      data: { id: JOB_ID, status: 'SENT' },
    });
    expect(gateway.recordResult).toHaveBeenCalledWith(
      DEVICE,
      JOB_ID,
      expect.objectContaining({ status: 'SENT' }),
    );

    await api()
      .post('/api/sms-gateway/device/jobs/not-a-uuid/result')
      .set(asDevice())
      .send({ status: 'SENT', occurredAt: '2026-09-30T10:00:00.000Z' })
      .expect(400);
    await api()
      .post(`/api/sms-gateway/device/jobs/${JOB_ID}/result`)
      .set(asDevice())
      .send({ status: 'LEASED', occurredAt: '2026-09-30T10:00:00.000Z' })
      .expect(400);
  });

  it(`M-28: throttles correct-token requests per client ADDRESS at ${SMS_DEVICE_THROTTLE_PER_MINUTE}/min per route — a made-up device id buys no fresh bucket; another address keeps its own`, async () => {
    const beat = (id: string, forwardedFor?: string) => {
      const call = api()
        .post('/api/sms-gateway/device/heartbeat')
        .set(asDevice(id))
        .send(heartbeatBody());
      return forwardedFor ? call.set('X-Forwarded-For', forwardedFor) : call;
    };

    for (let i = 0; i < SMS_DEVICE_THROTTLE_PER_MINUTE; i++) {
      await beat(DEVICE).expect(200);
    }
    const blocked = await beat(DEVICE).expect(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.headers['retry-after']).toBeDefined();

    // Same address, another device id: the same bucket (before the fix this
    // was a fresh 120/min per invented id — and a way to burn the real
    // phone's bucket by sending under ITS id).
    await beat(OTHER_DEVICE).expect(429);
    // A forged X-Forwarded-For from a non-proxy peer is ignored: still the
    // same bucket.
    await beat(DEVICE, '198.51.100.7').expect(429);
    // A request that really comes from another address (relayed by a
    // trusted proxy) has its own budget: the phone's bucket is nobody
    // else's.
    process.env.TRUSTED_PROXIES = '127.0.0.1';
    await beat(DEVICE, '198.51.100.7').expect(200);
    await beat(DEVICE).expect(429);
    process.env.TRUSTED_PROXIES = '';
    // Polling is a different route with its own bucket.
    await api().get('/api/sms-gateway/device/jobs').set(asDevice()).expect(200);
  });
});

describe('SmsGatewayStatusController', () => {
  const actor = (role: Role): AuthenticatedUser => ({
    id: 'staff-id',
    username: 'staff',
    role,
    appRoleId: null,
  });

  it('DELETE /sms-gateway/binding needs PermissionsGuard + SETTINGS.MANAGE and is NOT @Public', () => {
    const handler = Object.getOwnPropertyDescriptor(
      SmsGatewayStatusController.prototype,
      'resetBinding',
    )!.value as () => unknown;

    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      'SETTINGS.MANAGE',
    ]);
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
  });

  it('the reset is super-admin-only even for a role that holds SETTINGS.MANAGE', async () => {
    const reset = jest.fn().mockResolvedValue({ deviceId: null });
    const controller = new SmsGatewayStatusController(
      {} as SmsGatewayService,
      { reset } as unknown as SmsDeviceBindingService,
    );

    for (const role of [Role.ADMIN, Role.CONTENT_UPLOADER, Role.USER]) {
      await expect(
        Promise.resolve().then(() => controller.resetBinding(actor(role))),
      ).rejects.toThrow(
        new ForbiddenException(SMS_BINDING_RESET_SUPER_ADMIN_ONLY),
      );
    }
    expect(reset).not.toHaveBeenCalled();

    await expect(
      controller.resetBinding(actor(Role.SUPER_ADMIN)),
    ).resolves.toEqual({ deviceId: null });
    expect(reset).toHaveBeenCalledWith(actor(Role.SUPER_ADMIN));
  });

  it('is staff-only: PermissionsGuard + SETTINGS.VIEW, and NOT @Public', () => {
    const handler = Object.getOwnPropertyDescriptor(
      SmsGatewayStatusController.prototype,
      'status',
    )!.value as () => unknown;

    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      'SETTINGS.VIEW',
    ]);
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      PermissionsGuard,
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, SmsGatewayStatusController),
    ).toBeUndefined();
  });
});
