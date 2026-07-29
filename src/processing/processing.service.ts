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

  // Video IDs this process is genuinely, currently transcoding — the only
  // reliable way to tell "still actually running" apart from "the DB still
  // says PROCESSING because whatever was working on it died" (a crash, a
  // restart, a redeploy). Nothing persists this anywhere else on purpose:
  // a fresh process always starts with an empty set, so any row still
  // PROCESSING from before it started is unambiguously orphaned — no
  // timeout or heuristic needed to tell the difference.
  private readonly activeVideoIds = new Set<string>();

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly prisma: PrismaService,
  ) {}

  isActivelyProcessing(videoId: string): boolean {
    return this.activeVideoIds.has(videoId);
  }

  /**
   * Original video -> ffmpeg -> HLS renditions -> master playlist.
   * Runs in the background; upload completion does not wait on this.
   */
  async processVideo(videoId: string, movieId: string, inputPath: string): Promise<void> {
    this.activeVideoIds.add(videoId);
    try {
      await this.runPipeline(videoId, movieId, inputPath);
    } finally {
      this.activeVideoIds.delete(videoId);
    }
  }

  private async runPipeline(videoId: string, movieId: string, inputPath: string): Promise<void> {
    await this.videosService.markProcessing(videoId);

    try {
      const probe = await probeVideo(inputPath);

      // Archive the original upload too — same reasoning as the HLS output
      // below, just earlier: the Flokinet VPS has limited disk, so nothing
      // that needs to persist should end up staying there. Kept in MinIO
      // (rather than deleted outright) in case a future re-transcode at
      // different settings is ever wanted. Skipped when it's already there
      // (a reprocess() run re-downloaded this exact object to feed ffmpeg) —
      // otherwise every retry would re-upload the same multi-GB file back to
      // the storage server for no reason.
      const originalKey = this.storageService.originalObjectKey(movieId, extname(inputPath));
      if (!(await this.minioService.objectExists(originalKey))) {
        await this.minioService.uploadFile(originalKey, inputPath);
      }
      await this.videosService.updateOriginalPath(videoId, originalKey);

      const renditions = pickRenditions(probe.height);
      const hlsDir = this.storageService.hlsDir(movieId);
      await this.storageService.ensureDir(hlsDir);

      const variantEntries: { name: string; bandwidth: number; width: number; height: number }[] = [];

      for (const tier of renditions) {
        const renditionKeyPrefix = this.storageService.hlsRenditionKeyPrefix(movieId, tier.name);

        // A retry after a partial failure shouldn't redo tiers that already
        // finished transcoding *and* uploading — on a big file those earlier
        // tiers can represent most of an hour of work. Only the tier that
        // was still in flight (or never started) actually needs redoing.
        const alreadyUploaded = await this.minioService.objectExists(`${renditionKeyPrefix}/index.m3u8`);

        if (!alreadyUploaded) {
          const outputDir = join(hlsDir, tier.name);
          // Clear any stale partial output from an earlier crashed attempt
          // at this same tier before ffmpeg writes into it again.
          await rm(outputDir, { recursive: true, force: true });
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
          await this.minioService.uploadDirectory(outputDir, renditionKeyPrefix);
          this.logger.log(`Rendition ${tier.name} ready for movie ${movieId}`);
        } else {
          this.logger.log(`Rendition ${tier.name} already uploaded for movie ${movieId} — skipping re-transcode`);
        }

        variantEntries.push({
          name: tier.name,
          bandwidth: tier.bandwidth,
          width: approximateWidth(probe.width, probe.height, tier.height),
          height: tier.height,
        });
      }

      const masterPath = join(hlsDir, 'master.m3u8');
      await writeFile(masterPath, buildMasterPlaylist(variantEntries), 'utf-8');
      await this.minioService.uploadFile(this.storageService.hlsMasterKey(movieId), masterPath);

      // Everything this movie needs — the original and every rendition —
      // is on the storage server now. Both local copies were only ever
      // needed for ffmpeg to read from / write to.
      await this.cleanupScratch(movieId, inputPath);

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

      // The movie — and, by cascade, this Video row — can be deleted while
      // this runs in the background. Recording the failure then throws
      // P2025 from inside the handler itself, and an unhandled rejection is
      // fatal in Node: that is what previously killed the whole container.
      // Nothing in here is allowed to escape.
      try {
        await this.videosService.markFailed(videoId, message);
        await this.prisma.movie.update({
          where: { id: movieId },
          data: { status: MovieStatus.DRAFT },
        });
      } catch (recordError) {
        const reason = recordError instanceof Error ? recordError.message : 'unknown error';
        this.logger.warn(
          `Could not record failure for video ${videoId} (its movie was likely deleted mid-processing): ${reason}`,
        );
      }

      // Cleanup previously only ran on the success path, so every failed or
      // abandoned run leaked its original plus whatever renditions it had
      // produced — several GB per attempt on a disk shared with everything else.
      // Note this deletes local copies of tiers that already finished too —
      // harmless, since they're already durably in MinIO and the resume
      // check above works off MinIO, not local disk.
      await this.cleanupScratch(movieId, inputPath);
    }
  }

  /**
   * Removes this movie's local scratch files. Best-effort by design: it runs
   * on both the success and failure paths, and a cleanup problem must never
   * turn into the error the caller sees (or, worse, an unhandled rejection).
   */
  private async cleanupScratch(movieId: string, inputPath: string): Promise<void> {
    try {
      await rm(this.storageService.hlsDir(movieId), { recursive: true, force: true });
      await rm(inputPath, { force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Could not clean scratch files for movie ${movieId}: ${reason}`);
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
