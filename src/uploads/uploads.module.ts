import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { ProcessingModule } from '../processing/processing.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [RolesModule, VideosModule, ProcessingModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
