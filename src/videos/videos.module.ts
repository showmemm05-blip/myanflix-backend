import { Module } from '@nestjs/common';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  controllers: [VideosController],
  providers: [VideosService, StorageService, MinioService],
  exports: [VideosService, StorageService, MinioService],
})
export class VideosModule {}
