import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { RolesModule } from '../roles/roles.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [RolesModule],
  controllers: [SeriesController],
  // MinioService has no shared module — provided per-module, the same way
  // VideosModule/FinanceModule already do it. Needed here so persisted
  // poster/cover URLs can be re-hosted per request (MinioService.imageUrl).
  // StorageService comes along for the same reason: deleting a show builds
  // its episodes' storage prefixes through the one key builder, so this
  // path cannot drift from the layout the rest of the backend writes.
  providers: [SeriesService, MinioService, StorageService],
  exports: [SeriesService],
})
export class SeriesModule {}
