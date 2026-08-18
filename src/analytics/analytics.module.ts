import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RolesModule } from '../roles/roles.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [RolesModule],
  controllers: [AnalyticsController],
  // MinioService has no shared module — provided per-module, the same way
  // VideosModule/FinanceModule already do it. Needed here so persisted
  // poster URLs can be re-hosted per request (MinioService.imageUrl).
  providers: [AnalyticsService, MinioService],
})
export class AnalyticsModule {}
