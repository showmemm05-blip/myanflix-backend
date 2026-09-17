import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomInt, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RefreshPayload } from '../src/auth/types/jwt-payload.type';

/**
 * Refresh-token rotation and OTP consumption must be exactly-once, even
 * under a concurrent burst that replays one token/code (QA F-009). Runs
 * against the real `myanflix_test` database (see e2e-setup.ts, which also
 * disables throttling so the parallel bursts are not rate-limited).
 */
describe('Auth refresh rotation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let userId: string;
  /** Live refresh token for `userId`, replaced as the tests rotate it. */
  let refreshToken: string;

  const otpPhone = `+959${randomInt(10_000_000, 99_999_999)}`;
  const OTP_CODE = '123456';

  function postRefresh(token: string) {
    return request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: token });
  }

  async function decodeRefresh(token: string): Promise<RefreshPayload> {
    return jwtService.verifyAsync<RefreshPayload>(token, {
      secret: configService.get<string>('JWT_REFRESH_SECRET'),
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // ValidationPipe/AllExceptionsFilter/ResponseInterceptor are registered
    // globally by AppModule (APP_PIPE/APP_FILTER/APP_INTERCEPTOR) — do not
    // re-register them here.
    app.setGlobalPrefix('api');
    await app.init();
    // Listen on an ephemeral port before any request is made. supertest only
    // starts (and then closes) its own listener when the server has no
    // address, so with the Promise.all bursts below the first request's
    // server.close() would reset the sockets of its still-connecting
    // siblings (ECONNRESET). A server that is already listening is never
    // started or closed by supertest; app.close() in afterAll shuts it down.
    await app.listen(0);

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);
    const registered = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username: `qa_rt_${suffix}`, password: 'qa-refresh-password' })
      .expect(201);

    userId = registered.body.data.user.id;
    refreshToken = registered.body.data.refreshToken;
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite
    // touched. refresh_tokens and user_sessions cascade from the user row.
    const otpUser = await prisma.user.findUnique({
      where: { phone: otpPhone },
    });
    const userIds = [userId, otpUser?.id].filter((id): id is string =>
      Boolean(id),
    );
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.otpCode.deleteMany({ where: { phone: otpPhone } });
    await app.close();
  });

  it('parallel refreshes with one token: exactly one 200', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postRefresh(refreshToken)),
    );

    const winners = responses.filter((res) => res.status === 200);
    const losers = responses.filter((res) => res.status === 401);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const res of losers) {
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid or expired refresh token',
      });
    }

    const [winner] = winners;
    expect(winner.body.success).toBe(true);
    expect(typeof winner.body.data.accessToken).toBe('string');
    expect(typeof winner.body.data.refreshToken).toBe('string');
    refreshToken = winner.body.data.refreshToken;
  });

  it('one live token remains after the burst', async () => {
    const live = await prisma.refreshToken.findMany({
      where: { userId, revoked: false },
    });
    const { jti } = await decodeRefresh(refreshToken);

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(jti);
  });

  it('sequential reuse: 200 then 401', async () => {
    const consumed = refreshToken;

    const first = await postRefresh(consumed).expect(200);
    refreshToken = first.body.data.refreshToken;

    const replay = await postRefresh(consumed).expect(401);
    expect(replay.body).toEqual({
      success: false,
      message: 'Invalid or expired refresh token',
    });
  });

  it('the rotated token refreshes again: 200', async () => {
    const res = await postRefresh(refreshToken).expect(200);
    expect(res.body.data.refreshToken).not.toBe(refreshToken);
    refreshToken = res.body.data.refreshToken;
  });

  it('logout then refresh: 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken })
      .expect(200);

    await postRefresh(refreshToken).expect(401);
    const live = await prisma.refreshToken.count({
      where: { userId, revoked: false },
    });
    expect(live).toBe(0);
  });

  it('parallel OTP verifies with one code: exactly one 200', async () => {
    await prisma.otpCode.create({
      data: {
        phone: otpPhone,
        code: OTP_CODE,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app.getHttpServer()).post('/api/auth/otp/verify').send({
          phone: otpPhone,
          code: OTP_CODE,
          password: 'qa-otp-password',
        }),
      ),
    );

    expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
    expect(responses.filter((res) => res.status === 401)).toHaveLength(3);

    const accounts = await prisma.user.count({ where: { phone: otpPhone } });
    expect(accounts).toBe(1);
    const unconsumed = await prisma.otpCode.count({
      where: { phone: otpPhone, consumedAt: null },
    });
    expect(unconsumed).toBe(0);
  });
});
