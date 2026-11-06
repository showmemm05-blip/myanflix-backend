import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { HEALTH_DEGRADED_CODE } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';

interface HealthBody {
  success: boolean;
  data?: { status: string; db: boolean; timestamp: string };
  status?: string;
  db?: boolean;
  code?: string;
}

/**
 * GET /api/health through the real AppModule (global JwtAuthGuard, filter
 * and envelope) against the isolated e2e database: a database that answers
 * gives 200 with db: true; the moment the probe reports it gone the route
 * answers 503 with db: false — OPS-005, where the old handler answered 200
 * "ok" with Postgres stopped.
 *
 * A jest run cannot stop Postgres, so the second case stubs the probe; the
 * real stop → 503 → start → 200 sequence is the throwaway-stack check
 * recorded in DOCKER.md ("Health checks").
 */
describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let health: HealthService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    health = app.get(HealthService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 ok with db: true while the database answers, with no token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    const body = res.body as HealthBody;
    expect(body).toMatchObject({
      success: true,
      data: { status: 'ok', db: true },
    });
    expect(Number.isNaN(Date.parse(body.data?.timestamp ?? ''))).toBe(false);
  });

  it('answers 503 degraded with db: false when the database probe fails', async () => {
    jest.spyOn(health, 'databaseReachable').mockResolvedValueOnce(false);

    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(503);

    expect(res.body as HealthBody).toMatchObject({
      success: false,
      status: 'degraded',
      db: false,
      code: HEALTH_DEGRADED_CODE,
    });
  });

  it('recovers without a restart once the database answers again', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);

    expect((res.body as HealthBody).data?.db).toBe(true);
  });
});
