import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { HlsSubtitlesService } from './hls-subtitles.service';

/**
 * Its own module (rather than living inside SubtitlesModule) because BOTH
 * ingest paths have to reach it: SubtitlesModule for admin create/delete/
 * set-default, and ProcessingModule so a re-transcode — which rewrites
 * master.m3u8 from scratch and would otherwise silently drop the subtitle
 * group — republishes it. Importing SubtitlesModule from ProcessingModule
 * instead would drag the whole subtitles HTTP surface into the transcode
 * graph.
 */
@Module({
  providers: [HlsSubtitlesService, MinioService, StorageService],
  exports: [HlsSubtitlesService],
})
export class HlsSubtitlesModule {}
