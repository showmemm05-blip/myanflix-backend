import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { HlsSubtitlesModule } from './hls-subtitles.module';
import { SubtitlesController } from './subtitles.controller';
import { SubtitlesService } from './subtitles.service';

@Module({
  imports: [VideosModule, HlsSubtitlesModule],
  controllers: [SubtitlesController],
  providers: [SubtitlesService],
  exports: [SubtitlesService],
})
export class SubtitlesModule {}
