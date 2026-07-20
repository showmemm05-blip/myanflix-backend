import { Module } from '@nestjs/common';
import { StorageService } from '../common/storage/storage.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  controllers: [VideosController],
  providers: [VideosService, StorageService],
  exports: [VideosService, StorageService],
})
export class VideosModule {}
