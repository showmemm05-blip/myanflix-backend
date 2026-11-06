import { Controller, Get, HttpStatus } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { HealthService } from './health.service';

/** Stable `code` on the 503 envelope, for a probe that branches on it. */
export const HEALTH_DEGRADED_CODE = 'HEALTH_DEGRADED';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * GET /api/health — 200 `{ status: 'ok', db: true, timestamp }` when the
   * database answers `SELECT 1` within 2 s, else 503 `{ status: 'degraded',
   * db: false }` (inside the usual `success: false, message, code` error
   * envelope). Only the database is probed, on purpose: MinIO and the cache
   * server live on other machines, and a restart of this container — which
   * is what a failing healthcheck leads to — cannot fix an outage there.
   *
   * Never rate limited and never behind a login: uptime probes, the compose
   * healthcheck and the admin's network check poll it every 20-30 s, and
   * each treats any non-2xx as "down" — which, with the database gone, is
   * now the truth (OPS-005).
   */
  @Public()
  @SkipThrottle()
  @Get()
  async getHealth() {
    if (!(await this.health.databaseReachable())) {
      throw new CodedHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        HEALTH_DEGRADED_CODE,
        'Database unreachable',
        { status: 'degraded', db: false },
      );
    }
    return { status: 'ok', db: true, timestamp: new Date().toISOString() };
  }
}
