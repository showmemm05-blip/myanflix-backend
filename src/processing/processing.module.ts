import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { ProcessingService } from './processing.service';

@Module({
  imports: [VideosModule],
  providers: [ProcessingService],
  exports: [ProcessingService],
})
export class ProcessingModule {}
