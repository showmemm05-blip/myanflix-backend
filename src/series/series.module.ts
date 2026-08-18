import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RolesModule } from '../roles/roles.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [RolesModule],
  controllers: [SeriesController],
  // MinioService has no shared module — provided per-module, the same way
  // VideosModule/FinanceModule already do it. Needed here so persisted
  // poster/cover URLs can be re-hosted per request (MinioService.imageUrl).
  providers: [SeriesService, MinioService],
  exports: [SeriesService],
})
export class SeriesModule {}
