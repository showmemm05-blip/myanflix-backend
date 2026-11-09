import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { ImageStoreService } from './image-store.service';

/**
 * The one place a still image is checked, resized and stored. It is its own
 * module because two modules that must not import each other both store
 * pictures: UploadsModule (POST /uploads/image, a staff upload) and the TMDB
 * module (posters, backdrops and actor photos fetched from TMDB) — and
 * UploadsModule itself calls into the TMDB module after an upload finishes.
 *
 * VideosModule is imported for StorageService and MinioService, which it
 * owns and exports; AuditService comes from the global AuditModule.
 */
@Module({
  imports: [VideosModule],
  providers: [ImageStoreService],
  exports: [ImageStoreService],
})
export class ImagesModule {}
