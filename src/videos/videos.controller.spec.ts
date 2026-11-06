import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { Role, UserStatus } from '../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AppThrottlerGuard } from '../common/throttling/app-throttler.guard';
import {
  accountTracker,
  buildThrottlerOptions,
} from '../common/throttling/throttling.config';
import { UsersService } from '../users/users.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { TrackingService } from '../tracking/tracking.service';
import { VideoDiagnosisService } from './video-diagnosis.service';
import {
  STREAM_THROTTLE_PER_MINUTE,
  VideosController,
} from './videos.controller';
import { VideosService } from './videos.service';

/**
 * GET /videos/:movieId/watch-progress over real HTTP, behind the REAL global
 * JwtAuthGuard and JwtStrategy (only the database lookups are stubbed), so
 * what is proven is what a client actually gets: a guest is refused, and a
 * signed-in user only ever reads their own row — the user id comes from the
 * token, never from the request.
 */
describe('VideosController — GET :movieId/watch-progress', () => {
  const SECRET = 'unit-test-jwt-secret-0123456789abcdef';
  const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
  const USER_ID = '0b9d3c1e-6a43-4c2f-9a0e-0d8e3f4b5a61';

  let app: INestApplication;
  const videosService = {
    getWatchProgress: jest.fn(),
    recordWatchProgress: jest.fn(),
  };
  const usersService = {
    findAuthSubject: jest.fn().mockResolvedValue({
      id: USER_ID,
      username: 'viewer',
      role: Role.USER,
      appRoleId: null,
      status: UserStatus.ACTIVE,
      sessionsRevokedAt: null,
    }),
  };

  const tokenFor = (sub: string) =>
    sign({ sub, ims: Date.now() }, SECRET, { expiresIn: '15m' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [VideosController],
      providers: [
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
          },
        },
        { provide: UsersService, useValue: usersService },
        {
          provide: TrackingService,
          useValue: {
            fireAndForget: jest.fn(),
            touchLastSeen: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: VideosService, useValue: videosService },
        { provide: VideoDiagnosisService, useValue: {} },
        // Only the staff routes of this controller use PermissionsGuard; the
        // route under test never reaches it.
        { provide: PermissionResolverService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    videosService.getWatchProgress.mockReset();
  });

  it('answers a guest (no token) 401 and reads nothing', async () => {
    const res = await request(app.getHttpServer()).get(
      `/videos/${MOVIE_ID}/watch-progress`,
    );

    expect(res.status).toBe(401);
    expect(videosService.getWatchProgress).not.toHaveBeenCalled();
  });

  it('answers a forged token 401', async () => {
    const forged = sign({ sub: USER_ID }, 'not-the-secret');

    const res = await request(app.getHttpServer())
      .get(`/videos/${MOVIE_ID}/watch-progress`)
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(videosService.getWatchProgress).not.toHaveBeenCalled();
  });

  it("returns the signed-in user's own position, looked up by the id in the token", async () => {
    const updatedAt = '2026-10-07T10:00:00.000Z';
    videosService.getWatchProgress.mockResolvedValue({
      position: 1234,
      progress: 41.5,
      updatedAt,
    });

    const res = await request(app.getHttpServer())
      .get(`/videos/${MOVIE_ID}/watch-progress`)
      // A user id smuggled into the query is ignored.
      .query({ userId: 'someone-else' })
      .set('Authorization', `Bearer ${tokenFor(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ position: 1234, progress: 41.5, updatedAt });
    expect(videosService.getWatchProgress).toHaveBeenCalledWith(
      USER_ID,
      MOVIE_ID,
    );
  });

  it('refuses a movie id that is not a UUID with 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/not-a-uuid/watch-progress')
      .set('Authorization', `Bearer ${tokenFor(USER_ID)}`);

    expect(res.status).toBe(400);
    expect(videosService.getWatchProgress).not.toHaveBeenCalled();
  });
});

/**
 * GET /videos/:movieId/stream is rate limited per ACCOUNT (SEC-022): the real
 * AppThrottlerGuard with the production module options, behind the real
 * JwtAuthGuard in the same order as AppModule (the tracker keys on the
 * `req.user` that guard sets), VideosService stubbed. What is proven: the
 * route no longer opts out of the limiter, the 61st lookup by one account
 * inside a minute is a 429 with a plain Retry-After, a second account from
 * the SAME address is untouched (viewers share carrier-NAT addresses), one
 * account cannot refill its bucket by changing address, and — since express
 * parses a body on a GET like on any method — it cannot refill it by sending
 * a made-up username/phone in a body either. Buckets live in the guard's
 * in-memory storage for the life of this app, so every test uses accounts
 * of its own.
 */
describe('VideosController — GET :movieId/stream rate limit', () => {
  const SECRET = 'unit-test-jwt-secret-0123456789abcdef';
  const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
  const USER_A = '0b9d3c1e-6a43-4c2f-9a0e-0d8e3f4b5a61';
  const USER_B = '5c2a7e94-1d3b-4f6a-8b0c-2e9d4f1a7b53';
  const USER_C = '9e1f3a7d-4b2c-4d8e-a6f0-7c5b3d2e1f94';
  const USER_D = '3a8c6e2f-7d1b-4a5e-9c0f-4b6d8e2a1c75';
  // The bucket tests make 60+ real HTTP round-trips each; the 15 s default
  // is tight on a loaded host.
  const LOOP_TEST_TIMEOUT_MS = 60_000;

  let app: INestApplication;
  const videosService = {
    getStreamInfo: jest.fn().mockResolvedValue({ playlistUrl: 'signed' }),
  };
  // Every well-formed token names an active account of its own.
  const usersService = {
    findAuthSubject: jest.fn((id: string) =>
      Promise.resolve({
        id,
        username: `viewer-${id.slice(0, 8)}`,
        role: Role.USER,
        appRoleId: null,
        status: UserStatus.ACTIVE,
        sessionsRevokedAt: null,
      }),
    ),
  };

  const tokenFor = (sub: string) =>
    sign({ sub, ims: Date.now() }, SECRET, { expiresIn: '15m' });

  const stream = (sub: string, ip?: string) => {
    const req = request(app.getHttpServer())
      .get(`/videos/${MOVIE_ID}/stream`)
      .set('Authorization', `Bearer ${tokenFor(sub)}`);
    return ip ? req.set('x-forwarded-for', ip) : req;
  };
  // The crafted request a hammering client could send: a body on the GET,
  // in each shape the app's global parsers accept.
  const streamWithBody = (sub: string, type: string, body: string) =>
    stream(sub).set('Content-Type', type).send(body);

  beforeAll(async () => {
    // supertest always connects from loopback; trusting it lets one test
    // stand in for different client addresses through X-Forwarded-For.
    process.env.TRUSTED_PROXIES = '127.0.0.1';

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        ThrottlerModule.forRoot(buildThrottlerOptions()),
      ],
      controllers: [VideosController],
      providers: [
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        // AFTER JwtAuthGuard, exactly as AppModule registers them.
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
          },
        },
        { provide: UsersService, useValue: usersService },
        {
          provide: TrackingService,
          useValue: {
            fireAndForget: jest.fn(),
            touchLastSeen: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: VideosService, useValue: videosService },
        { provide: VideoDiagnosisService, useValue: {} },
        { provide: PermissionResolverService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.TRUSTED_PROXIES;
  });

  beforeEach(() => {
    videosService.getStreamInfo.mockClear();
  });

  it('declares a per-account `default` bucket of 60 a minute and no longer skips the limiter', () => {
    const handler = VideosController.prototype.getStream;
    // The keys are `<constant><throttler name>` as @nestjs/throttler's
    // throttler.constants spells them (not exported from the package root).
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', handler),
    ).toBeUndefined();
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
    expect(STREAM_THROTTLE_PER_MINUTE).toBe(60);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:TRACKERdefault', handler)).toBe(
      accountTracker,
    );
  });

  it('answers a guest 401 before the limiter and looks nothing up', async () => {
    const res = await request(app.getHttpServer()).get(
      `/videos/${MOVIE_ID}/stream`,
    );

    expect(res.status).toBe(401);
    expect(videosService.getStreamInfo).not.toHaveBeenCalled();
  });

  it(
    'answers the 61st lookup by one account inside a minute with 429 + Retry-After, and keeps serving another account from the same address',
    async () => {
      for (let i = 0; i < 60; i += 1) {
        await stream(USER_A).expect(200);
      }
      const blocked = await stream(USER_A).expect(429);

      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(videosService.getStreamInfo).toHaveBeenCalledTimes(60);

      // Same loopback address, different account: its own bucket.
      await stream(USER_B).expect(200);
      expect(videosService.getStreamInfo).toHaveBeenCalledTimes(61);
    },
    LOOP_TEST_TIMEOUT_MS,
  );

  it(
    'keys on the account, not the address: a new address does not refill the bucket',
    async () => {
      for (let i = 0; i < 60; i += 1) {
        await stream(USER_C, '203.0.113.7').expect(200);
      }
      await stream(USER_C, '198.51.100.9').expect(429);
      expect(videosService.getStreamInfo).toHaveBeenCalledTimes(60);
    },
    LOOP_TEST_TIMEOUT_MS,
  );

  it(
    'keys on the account, not the body: a made-up username/phone on the GET does not open a fresh bucket',
    async () => {
      // Sixty lookups, every one with a different username in a JSON body —
      // all land in USER_D's one bucket.
      for (let i = 0; i < 60; i += 1) {
        await streamWithBody(
          USER_D,
          'application/json',
          JSON.stringify({ username: `someone-${i}` }),
        ).expect(200);
      }
      expect(videosService.getStreamInfo).toHaveBeenCalledTimes(60);

      // The 61st is blocked whatever the body says — and with none at all.
      await streamWithBody(
        USER_D,
        'application/json',
        JSON.stringify({ username: 'someone-else' }),
      ).expect(429);
      await streamWithBody(
        USER_D,
        'application/json',
        JSON.stringify({ phone: '09777000777' }),
      ).expect(429);
      await streamWithBody(
        USER_D,
        'application/x-www-form-urlencoded',
        'username=another&phone=09777000778',
      ).expect(429);
      await stream(USER_D).expect(429);
      expect(videosService.getStreamInfo).toHaveBeenCalledTimes(60);
    },
    LOOP_TEST_TIMEOUT_MS,
  );
});
