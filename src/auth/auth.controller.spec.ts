import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * M-20: the public username+password sign-up is gone. The real controller
 * with a faked AuthService: a route that exists answers through the fake,
 * a route that does not answers 404 before any service method could run.
 */
describe('AuthController — M-20: no public username sign-up', () => {
  let app: INestApplication<App>;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      login: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      checkPhoneExists: jest.fn().mockResolvedValue({ exists: false }),
      verifyPhonePassword: jest.fn().mockResolvedValue({ ok: true }),
      requestPhoneOtp: jest.fn().mockResolvedValue(undefined),
      verifyPhoneOtp: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      resetPasswordWithOtp: jest.fn().mockResolvedValue({ reset: true }),
      refresh: jest.fn().mockResolvedValue({ accessToken: 'b' }),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: service },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /auth/register no longer exists: a squatter cannot pre-claim user_<digits> or mint an unverified account', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username: 'user_959123456789', password: 'anything8' })
      .expect(404);

    expect(res.body).toEqual({
      success: false,
      message: 'Cannot POST /auth/register',
    });
    // Nothing on the service was asked to create or sign anyone in.
    for (const method of Object.values(service)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('the phone sign-up route still answers (the only customer sign-up there is)', async () => {
    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: '09123456789', code: '482 913', password: 'first-pw-1' })
      .expect(200);

    expect(service.verifyPhoneOtp).toHaveBeenCalledWith(
      '+959123456789',
      '482913',
      'first-pw-1',
      undefined,
    );
  });

  it('the staff login route still answers', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'boss', password: 'boss-password-1' })
      .expect(200);

    expect(service.login).toHaveBeenCalledWith({
      username: 'boss',
      password: 'boss-password-1',
    });
  });
});
