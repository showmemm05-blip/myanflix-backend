import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { AppThrottlerGuard } from '../common/throttling/app-throttler.guard';
import { buildThrottlerOptions } from '../common/throttling/throttling.config';
import { WithdrawalCodeController } from './withdrawal-code.controller';
import {
  withdrawalCodeLocked,
  withdrawalCodeNotSet,
  withdrawalCodeWrong,
} from './withdrawal-code.errors';
import { WithdrawalCodeService } from './withdrawal-code.service';

/**
 * Stands in for the global JwtAuthGuard, registered BEFORE the throttler
 * exactly like AppModule does: `x-test-user` becomes `req.user`.
 */
@Injectable()
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const id = req.headers['x-test-user'];
    if (!id) return false;
    req.user = { id, username: id, role: 'USER', appRoleId: null };
    return true;
  }
}

const STATUS = {
  hasCode: true,
  lockedUntil: null,
  triesLeft: 5,
  maxTries: 5,
  canResetBySms: true,
};

/**
 * The real controller, pipe, filter, envelope and rate limiter — only the
 * service is faked — so the wire contract the app and the website build on
 * is what is asserted here.
 */
describe('WithdrawalCodeController (HTTP contract)', () => {
  let app: INestApplication<App>;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    process.env.TRUSTED_PROXIES = '127.0.0.1';
    service = {
      getStatus: jest.fn().mockResolvedValue(STATUS),
      create: jest.fn().mockResolvedValue(STATUS),
      verify: jest.fn().mockResolvedValue(STATUS),
      change: jest.fn().mockResolvedValue(STATUS),
      requestReset: jest.fn().mockResolvedValue({
        sent: true,
        resendAfterSeconds: 60,
        expiresInSeconds: 300,
      }),
      verifyReset: jest
        .fn()
        .mockResolvedValue({ resetToken: 'tok', expiresInSeconds: 600 }),
      confirmReset: jest.fn().mockResolvedValue(STATUS),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlerOptions())],
      controllers: [WithdrawalCodeController],
      providers: [
        { provide: WithdrawalCodeService, useValue: service },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: APP_GUARD, useClass: FakeJwtAuthGuard },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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

  const as = (user: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('x-test-user', user),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(path)
        .set('x-test-user', user)
        .send(body),
    put: (path: string, body: object) =>
      request(app.getHttpServer())
        .put(path)
        .set('x-test-user', user)
        .send(body),
  });

  const BASE = '/users/me/withdrawal-code';

  it('GET answers the status in the success envelope, for the signed-in account', async () => {
    const res = await as('user-1').get(BASE).expect(200);
    expect(res.body).toEqual({ success: true, data: STATUS });
    expect(service.getStatus).toHaveBeenCalledWith('user-1');
  });

  it('POST creates (201) and hands the service the normalised code — spaces gone, Myanmar digits as 0-9', async () => {
    await as('user-1')
      .post(BASE, { code: '582 904', confirm: '၅၈၂၉၀၄' })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith('user-1', '582904', '582904');
  });

  it('POST verify / PUT change / reset routes answer 200 with their payloads', async () => {
    await as('u').post(`${BASE}/verify`, { code: '582904' }).expect(200);
    expect(service.verify).toHaveBeenCalledWith('u', '582904');

    await as('u')
      .put(BASE, {
        currentCode: '582904',
        newCode: '371940',
        confirm: '371940',
      })
      .expect(200);
    expect(service.change).toHaveBeenCalledWith(
      'u',
      '582904',
      '371940',
      '371940',
    );

    const sent = await as('u').post(`${BASE}/reset/request`).expect(200);
    expect(sent.body.data).toEqual({
      sent: true,
      resendAfterSeconds: 60,
      expiresInSeconds: 300,
    });

    const verified = await as('u')
      .post(`${BASE}/reset/verify`, { otpCode: '482 913' })
      .expect(200);
    expect(service.verifyReset).toHaveBeenCalledWith('u', '482913');
    expect(verified.body.data).toEqual({
      resetToken: 'tok',
      expiresInSeconds: 600,
    });

    await as('u')
      .post(`${BASE}/reset/confirm`, { resetToken: 'tok', newCode: '371940' })
      .expect(200);
    expect(service.confirmReset).toHaveBeenCalledWith(
      'u',
      expect.objectContaining({ resetToken: 'tok', newCode: '371940' }),
    );
  });

  it('a coded refusal reaches the client as { success:false, message, code, ...extra }', async () => {
    service.verify.mockRejectedValue(withdrawalCodeWrong(4));
    const wrong = await as('u')
      .post(`${BASE}/verify`, { code: '111222' })
      .expect(400);
    expect(wrong.body).toEqual({
      success: false,
      message: 'Wrong code. 4 tries left.',
      code: 'WITHDRAWAL_CODE_WRONG',
      triesLeft: 4,
      maxTries: 5,
    });

    const until = new Date(Date.now() + 15 * 60 * 1000);
    service.verify.mockRejectedValue(withdrawalCodeLocked(until));
    const locked = await as('u')
      .post(`${BASE}/verify`, { code: '111222' })
      .expect(423);
    expect(locked.body).toEqual({
      success: false,
      message: 'Too many tries. Try again in 15 minutes.',
      code: 'WITHDRAWAL_CODE_LOCKED',
      lockedUntil: until.toISOString(),
      triesLeft: 0,
      maxTries: 5,
    });

    service.verify.mockRejectedValue(withdrawalCodeNotSet());
    const notSet = await as('u')
      .post(`${BASE}/verify`, { code: '111222' })
      .expect(409);
    expect(notSet.body).toEqual({
      success: false,
      message: 'Create a withdrawal code first.',
      code: 'WITHDRAWAL_CODE_NOT_SET',
    });
  });

  it('refuses unknown body fields and a missing code before the service (400)', async () => {
    await as('u').post(BASE, { code: '582904', pin: '1' }).expect(400);
    await as('u').post(BASE, {}).expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('the service only ever receives a string (an object is stringified by the pipe, then fails the 6-digit rule there)', async () => {
    await as('u').post(BASE, { code: { $gt: '' } });
    const [, code] = service.create.mock.calls[0] as [string, unknown];
    expect(typeof code).toBe('string');
    expect(code).not.toMatch(/^\d{6}$/);
  });

  it('throttles code checks per ACCOUNT (10 a minute), not per shared IP', async () => {
    for (let i = 0; i < 10; i += 1) {
      await as('user-a').post(`${BASE}/verify`, { code: '582904' }).expect(200);
    }
    const blocked = await as('user-a')
      .post(`${BASE}/verify`, { code: '582904' })
      .expect(429);
    expect(blocked.body).toEqual({
      success: false,
      message: expect.stringMatching(
        /^Too many requests\. Try again in \d+ seconds\.$/,
      ),
    });
    // Same address, another account: its own bucket.
    await as('user-b').post(`${BASE}/verify`, { code: '582904' }).expect(200);
  });

  it('throttles SMS requests like /auth/otp/request: 4 per account per 2 minutes', async () => {
    for (let i = 0; i < 4; i += 1) {
      await as('user-a').post(`${BASE}/reset/request`).expect(200);
    }
    await as('user-a').post(`${BASE}/reset/request`).expect(429);
    await as('user-b').post(`${BASE}/reset/request`).expect(200);
  });
});
