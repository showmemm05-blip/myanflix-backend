import { Module } from '@nestjs/common';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingModule } from '../tracking/tracking.module';
import { VideoDurationService } from './video-duration.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [TrackingModule],
  controllers: [VideosController],
  providers: [
    VideosService,
    VideoDurationService,
    StorageService,
    MinioService,
  ],
  // VideoDurationService is exported for MoviesController (the backfill
  // route) and UploadsService (finalize-time capture) — both modules already
  // import VideosModule.
  exports: [VideosService, VideoDurationService, StorageService, MinioService],
})
export class VideosModule {}
