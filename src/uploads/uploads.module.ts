import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { ProcessingModule } from '../processing/processing.module';
import { SubtitlesModule } from '../subtitles/subtitles.module';
import { MultipartUploadController } from './multipart-upload.controller';
import { MultipartUploadService } from './multipart-upload.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import { UploadCleanupService } from './upload-cleanup.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [RolesModule, VideosModule, ProcessingModule, SubtitlesModule],
  controllers: [UploadsController, MultipartUploadController],
  providers: [
    UploadsService,
    MultipartUploadService,
    ResourceUploadTypeRegistry,
    UploadCleanupService,
  ],
})
export class UploadsModule {}
