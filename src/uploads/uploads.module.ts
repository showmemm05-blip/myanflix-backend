import { Module } from '@nestjs/common';
import { ImagesModule } from '../images/images.module';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { ProcessingModule } from '../processing/processing.module';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { TmdbModule } from '../tmdb/tmdb.module';
import { MultipartUploadController } from './multipart-upload.controller';
import { MultipartUploadService } from './multipart-upload.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import { UploadCleanupService } from './upload-cleanup.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  // ImagesModule owns the image store POST /uploads/image saves through
  // (UploadsService.saveImage) — shared with the TMDB module. TmdbModule
  // gives the lookup a finished folder upload starts (TmdbLookupService);
  // it imports nothing of this module, so there is no cycle.
  imports: [
    RolesModule,
    VideosModule,
    ProcessingModule,
    SubtitlesModule,
    ImagesModule,
    TmdbModule,
  ],
  controllers: [UploadsController, MultipartUploadController],
  providers: [
    UploadsService,
    MultipartUploadService,
    ResourceUploadTypeRegistry,
    UploadCleanupService,
  ],
})
export class UploadsModule {}
