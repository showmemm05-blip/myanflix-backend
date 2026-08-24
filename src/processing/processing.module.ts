import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { HlsSubtitlesModule } from '../subtitles/hls-subtitles.module';
import { ProcessingService } from './processing.service';

@Module({
  imports: [VideosModule, HlsSubtitlesModule],
  providers: [ProcessingService],
  exports: [ProcessingService],
})
export class ProcessingModule {}
