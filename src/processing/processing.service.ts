import { Injectable, Logger } from '@nestjs/common';
import { rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MovieStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { probeVideo, transcodeToHls } from './ffmpeg.util';
import { approximateWidth, pickRenditions } from './rendition-tiers';

@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Original video -> ffmpeg -> HLS renditions -> master playlist.
   * Runs in the background; upload completion does not wait on this.
   */
  async processVideo(videoId: string, movieId: string, inputPath: string): Promise<void> {
    await this.videosService.markProcessing(videoId);

    try {
      const probe = await probeVideo(inputPath);

      // Archive the original upload too — same reasoning as the HLS output
      // below, just earlier: the Flokinet VPS has limited disk, so nothing
      // that needs to persist should end up staying there. Kept in MinIO
      // (rather than deleted outright) in case a future re-transcode at
      // different settings is ever wanted.
      const originalKey = this.storageService.originalObjectKey(movieId, extname(inputPath));
      await this.minioService.uploadFile(originalKey, inputPath);
      await this.videosService.updateOriginalPath(videoId, originalKey);

      const renditions = pickRenditions(probe.height);
      const hlsDir = this.storageService.hlsDir(movieId);
      await this.storageService.ensureDir(hlsDir);

      const variantEntries: { name: string; bandwidth: number; width: number; height: number }[] = [];

      for (const tier of renditions) {
        const outputDir = join(hlsDir, tier.name);
        await this.storageService.ensureDir(outputDir);

        await transcodeToHls({
          inputPath,
          outputDir,
          segmentPattern: join(outputDir, 'segment_%03d.ts'),
          playlistPath: join(outputDir, 'index.m3u8'),
          targetHeight: tier.height,
          videoBitrate: tier.videoBitrate,
        });

        // ffmpeg can only write to a real local path, so outputDir is
        // scratch space — push the finished rendition (playlist + segments)
        // to the storage server, then it's no longer needed on local disk.
        await this.minioService.uploadDirectory(
          outputDir,
          this.storageService.hlsRenditionKeyPrefix(movieId, tier.name),
        );

        variantEntries.push({
          name: tier.name,
          bandwidth: tier.bandwidth,
          width: approximateWidth(probe.width, probe.height, tier.height),
          height: tier.height,
        });

        this.logger.log(`Rendition ${tier.name} ready for movie ${movieId}`);
      }

      const masterPath = join(hlsDir, 'master.m3u8');
      await writeFile(masterPath, buildMasterPlaylist(variantEntries), 'utf-8');
      await this.minioService.uploadFile(this.storageService.hlsMasterKey(movieId), masterPath);

      // Everything this movie needs — the original and every rendition —
      // is on the storage server now. Both local copies were only ever
      // needed for ffmpeg to read from / write to.
      await rm(hlsDir, { recursive: true, force: true });
      await rm(inputPath, { force: true });

      await this.videosService.markReady(videoId, {
        duration: probe.durationSeconds,
        resolution: `${probe.width}x${probe.height}`,
        hlsMasterPath: this.storageService.hlsMasterKey(movieId),
        renditions: variantEntries.map((v) => ({
          resolution: v.name,
          playlistPath: `${this.storageService.hlsRenditionKeyPrefix(movieId, v.name)}/index.m3u8`,
        })),
      });

      await this.prisma.movie.update({
        where: { id: movieId },
        data: { status: MovieStatus.PUBLISHED },
      });

      this.logger.log(`Video ${videoId} processed successfully for movie ${movieId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error';
      this.logger.error(`Processing failed for video ${videoId}: ${message}`);
      await this.videosService.markFailed(videoId, message);
      await this.prisma.movie.update({
        where: { id: movieId },
        data: { status: MovieStatus.DRAFT },
      });
    }
  }
}

function buildMasterPlaylist(
  variants: { name: string; bandwidth: number; width: number; height: number }[],
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const variant of variants) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height}`,
      `${variant.name}/index.m3u8`,
    );
  }

  return lines.join('\n') + '\n';
}
