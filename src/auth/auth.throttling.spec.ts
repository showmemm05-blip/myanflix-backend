import { Test, TestingModule } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SkipThrottle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Public } from '../common/decorators/public.decorator';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { AppThrottlerGuard } from '../common/throttling/app-throttler.guard';
import { buildThrottlerOptions } from '../common/throttling/throttling.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Stands in for the catalogue: ordinary @Public routes under the site-wide
 * `default` bucket only, plus one @SkipThrottle route like /health.
 */
@Public()
@Controller('page')
class PageStubController {
  @Get('movies')
  movies() {
    return { items: [] };
  }

  @Get('books')
  books() {
    return { items: [] };
  }

  @SkipThrottle()
  @Get('health')
  health() {
    return { ok: true };
  }
}

const TOO_MANY = /^Too many requests\. Try again in \d+ seconds\.$/;

/**
 * The real AuthController + the real guard, pipe, filter and module options
 * — only AuthService is faked, so every request that gets past the limiter
 * answers 200. Buckets live in the guard's in-memory storage, so each test
 * boots a fresh app and starts from zero.
 */
describe('Auth rate limiting', () => {
  let app: INestApplication<App>;
  let service: Record<string, jest.Mock>;

  async function boot(env: Record<string, string> = {}, trustedProxies = '127.0.0.1') {
    // supertest always connects from loopback; trusting it lets the tests
    // simulate distinct clients through X-Forwarded-For. The spoofing tests
    // boot with NO trusted proxy to prove the header is then ignored.
    process.env.TRUSTED_PROXIES = trustedProxies;
    service = {
      register: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      login: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      checkPhoneExists: jest.fn().mockResolvedValue({ exists: false }),
      verifyPhonePassword: jest.fn().mockResolvedValue({ ok: true }),
      requestPhoneOtp: jest.fn().mockResolvedValue(undefined),
      verifyPhoneOtp: jest.fn().mockResolvedValue({ accessToken: 'a' }),
      refresh: jest.fn().mockResolvedValue({ accessToken: 'b' }),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlerOptions())],
      controllers: [AuthController, PageStubController],
      providers: [
        { provide: AuthService, useValue: service },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
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
  }

  afterEach(async () => {
    await app.close();
  });

  const otp = (phone: string, ip?: string) => {
    const req = request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone });
    return ip ? req.set('x-forwarded-for', ip) : req;
  };

  describe('POST /auth/otp/request (3 per phone / 10 min, 20 per IP / hour)', () => {
    beforeEach(() => boot());

    it('answers the 4th request for one phone with the 429 envelope and Retry-After', async () => {
      for (let i = 0; i < 3; i += 1) {
        await otp('+959111111111').expect(200);
      }
      const blocked = await otp('+959111111111').expect(429);

      expect(blocked.body).toEqual({
        success: false,
        message: expect.stringMatching(TOO_MANY),
      });
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(600);
      expect(service.requestPhoneOtp).toHaveBeenCalledTimes(3);
    });

    it('keeps serving a different phone from the same IP', async () => {
      for (let i = 0; i < 3; i += 1) {
        await otp('+959111111111').expect(200);
      }
      await otp('+959111111111').expect(429);
      await otp('+959222222222').expect(200);
    });

    it('buckets "09..." and "+959..." spellings of one phone together', async () => {
      await otp('09111111111').expect(200);
      await otp('+959111111111').expect(200);
      await otp('09111111111').expect(200);
      await otp('+959111111111').expect(429);
    });

    it('caps one IP at 20 codes an hour across phones', async () => {
      for (let i = 0; i < 20; i += 1) {
        await otp(`+9597000000${String(i).padStart(2, '0')}`).expect(200);
      }
      await otp('+959799999999').expect(429);
      // A different client behind the same proxy is a different bucket.
      await otp('+959799999999', '203.0.113.9').expect(200);
    });

    it('invalid bodies still count against the phone before validation runs', async () => {
      // 400s come from the pipe, which runs AFTER the guard — a flood of
      // junk aimed at one phone is still a flood.
      await otp('+959111111111').expect(200);
      await otp('+959111111111').expect(200);
      await otp('+959111111111').expect(200);
      await request(app.getHttpServer())
        .post('/auth/otp/request')
        .send({ phone: '+959111111111', extra: 'x' })
        .expect(429);
    });
  });

  describe('POST /auth/login (10 per username / min, 60 per IP / min)', () => {
    beforeEach(() => boot());

    it('blocks the 11th attempt for one username but not another', async () => {
      for (let i = 0; i < 10; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ username: 'Alice', password: `guess${i}` })
          .expect(200);
      }
      const blocked = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'alice', password: 'guess10' })
        .expect(429);
      expect(blocked.body.success).toBe(false);
      expect(blocked.body.message).toMatch(TOO_MANY);
      expect(blocked.headers['retry-after']).toBeDefined();

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ username: 'bob', password: 'pw' })
        .expect(200);
      expect(service.login).toHaveBeenCalledTimes(11);
    });
  });

  describe('POST /auth/refresh (30 per IP / min)', () => {
    beforeEach(() => boot());

    it('keys on the first X-Forwarded-For hop, not the socket peer', async () => {
      for (let i = 0; i < 30; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('x-forwarded-for', '198.51.100.7, 10.0.0.1')
          .send({ refreshToken: 'tok' })
          .expect(200);
      }
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('x-forwarded-for', '198.51.100.7, 10.0.0.1')
        .send({ refreshToken: 'tok' })
        .expect(429);
      // Same proxy (10.0.0.1), different original client → fresh bucket.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('x-forwarded-for', '198.51.100.8, 10.0.0.1')
        .send({ refreshToken: 'tok' })
        .expect(200);
    });
  });

  describe('X-Forwarded-For trust', () => {
    it('ignores a client-supplied X-Forwarded-For when the peer is not a trusted proxy', async () => {
      await boot({}, '');
      // 30 distinct spoofed addresses from the same real peer → one bucket → the 31st trips.
      for (let i = 1; i <= 30; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('x-forwarded-for', `203.0.113.${i}`)
          .send({ refreshToken: 'x' });
      }
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('x-forwarded-for', '203.0.113.99')
        .send({ refreshToken: 'x' });
      expect(res.status).toBe(429);
    });

    it('honours the first X-Forwarded-For hop only when the peer is a trusted proxy', async () => {
      await boot({}, '127.0.0.1');
      for (let i = 1; i <= 30; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('x-forwarded-for', `203.0.113.${i}`)
          .send({ refreshToken: 'x' });
      }
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('x-forwarded-for', '203.0.113.99')
        .send({ refreshToken: 'x' });
      expect(res.status).not.toBe(429);
    });
  });

  describe('site-wide default (300 per IP per route / min)', () => {
    beforeEach(() => boot());

    it('does not trip on a normal page load of 20 mixed requests', async () => {
      const paths = ['/page/movies', '/page/books', '/page/health'];
      for (let i = 0; i < 20; i += 1) {
        await request(app.getHttpServer())
          .get(paths[i % paths.length])
          .expect(200);
      }
    });

    it('never touches a @SkipThrottle route and does not count auth hits against the page', async () => {
      for (let i = 0; i < 301; i += 1) {
        await request(app.getHttpServer()).get('/page/health').expect(200);
      }
      await request(app.getHttpServer()).get('/page/movies').expect(200);
    });

    it('blocks the 301st hit on one route from one IP', async () => {
      for (let i = 0; i < 300; i += 1) {
        await request(app.getHttpServer()).get('/page/movies').expect(200);
      }
      await request(app.getHttpServer()).get('/page/movies').expect(429);
      await request(app.getHttpServer()).get('/page/books').expect(200);
    });
  });

  describe('THROTTLE_DISABLED=true', () => {
    beforeEach(() => boot({ THROTTLE_DISABLED: 'true' }));

    it('switches every limit off', async () => {
      for (let i = 0; i < 6; i += 1) {
        await otp('+959111111111').expect(200);
      }
      expect(service.requestPhoneOtp).toHaveBeenCalledTimes(6);
    });
  });
});
