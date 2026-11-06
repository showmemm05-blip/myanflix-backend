import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * GET /api/health (OPS-005). PrismaService comes from the global
 * PrismaModule; nothing else is listed, on purpose — see the controller for
 * why the probe stops at the database.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
