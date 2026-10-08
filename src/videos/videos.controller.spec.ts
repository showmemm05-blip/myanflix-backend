import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { Role, UserStatus } from '../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { UsersService } from '../users/users.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { TrackingService } from '../tracking/tracking.service';
import { VideoDiagnosisService } from './video-diagnosis.service';
import { VideosController } from './videos.controller';
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
