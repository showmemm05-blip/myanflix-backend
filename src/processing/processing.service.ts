import { Injectable, Logger } from '@nestjs/common';
import { rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MovieStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { statusDerivedAuditAction } from '../movies/movies.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { HlsSubtitlesService } from '../subtitles/hls-subtitles.service';
import {
  ConversionSlots,
  videoTranscodeConcurrency,
} from '../common/concurrency/slots';
import { probeVideo, transcodeToHls } from './ffmpeg.util';
import { buildMasterPlaylist, type MasterVariant } from './master-playlist';
import { fitInsideBox, pickRenditions } from './rendition-tiers';

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

  /**
   * Process-wide: at most videoTranscodeConcurrency() pipelines (default 1)
   * past markProcessing at once. activeVideoIds only stops the SAME video
   * running twice; this stops N different videos finishing together from
   * starting N ffmpeg encoders on the box that also runs the API and
   * Postgres. A waiting video is already in activeVideoIds, so reprocess
   * and replace still refuse it (409) while it waits.
   */
  private readonly slots = new ConversionSlots(videoTranscodeConcurrency);

  /** How many transcodes are running and how many wait for a slot — for the spec and the log. */
  get transcodeLoad(): { active: number; queued: number } {
    return { active: this.slots.active, queued: this.slots.queued };
  }

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly prisma: PrismaService,
    private readonly hlsSubtitlesService: HlsSubtitlesService,
    private readonly audit: AuditService,
  ) {}

  isActivelyProcessing(videoId: string): boolean {
    return this.activeVideoIds.has(videoId);
  }

  /**
   * Claims the video for the caller BEFORE it does any async work —
   * synchronous on purpose: a check-and-add with no await in between
   * cannot interleave with another request, so of N simultaneous reprocess
   * requests exactly one gets `true`. The caller must either hand the video
   * to processVideo() (whose finally clears the claim once the run owns it)
   * or release() it on every throw in between. Mirrors
   * BookProcessingService.reserve().
   */
  reserve(videoId: string): boolean {
    if (this.activeVideoIds.has(videoId)) return false;
    this.activeVideoIds.add(videoId);
    return true;
  }

  /** Gives a reserve() back when the start request fails before the pipeline takes over. */
  release(videoId: string): void {
    this.activeVideoIds.delete(videoId);
  }

  /**
   * Original video -> ffmpeg -> HLS renditions -> master playlist.
   * Runs in the background; upload completion does not wait on this.
   */
  async processVideo(
    videoId: string,
    movieId: string,
    inputPath: string,
  ): Promise<void> {
    // Idempotent after a reserve(); the finally is what releases it.
    this.activeVideoIds.add(videoId);
    try {
      await this.runPipeline(videoId, movieId, inputPath);
    } finally {
      this.activeVideoIds.delete(videoId);
    }
  }

  private async runPipeline(
    videoId: string,
    movieId: string,
    inputPath: string,
  ): Promise<void> {
    // Set once the slot is held, so the finally never releases a slot this
    // run did not take (e.g. markProcessing below threw first).
    let taken = false;
    try {
      // The run's first write sits INSIDE the handler on purpose: both
      // callers fire processVideo() and forget it, so a rejection escaping
      // here — one pool timeout under load is enough — was an unhandled
      // rejection, fatal for the whole API process (STR-009). Failing here
      // is now recorded like a failure at any later step.
      await this.videosService.markProcessing(videoId);

      // Wait for a process-wide transcode slot. The video already reads
      // PROCESSING, so the admin sees it queued rather than idle. The
      // per-tier ffmpeg timeout starts inside transcodeToHls, so time spent
      // waiting here never counts against it.
      if (this.slots.active >= videoTranscodeConcurrency()) {
        this.logger.log(
          `Video ${videoId} waiting for a transcode slot (${this.slots.active} running, ${this.slots.queued} queued)`,
        );
      }
      await this.slots.acquire();
      taken = true;

      const probe = await probeVideo(inputPath);

      // Archive the original upload too — same reasoning as the HLS output
      // below, just earlier: the Flokinet VPS has limited disk, so nothing
      // that needs to persist should end up staying there. Kept in MinIO
      // (rather than deleted outright) in case a future re-transcode at
      // different settings is ever wanted. Skipped when it's already there
      // (a reprocess() run re-downloaded this exact object to feed ffmpeg) —
      // otherwise every retry would re-upload the same multi-GB file back to
      // the storage server for no reason.
      const originalKey = this.storageService.originalObjectKey(
        movieId,
        extname(inputPath),
      );
      if (!(await this.minioService.objectExists(originalKey))) {
        await this.minioService.uploadFile(originalKey, inputPath);
      }
      await this.videosService.updateOriginalPath(videoId, originalKey);

      const renditions = pickRenditions(probe.width, probe.height);
      const hlsDir = this.storageService.hlsDir(movieId);
      await this.storageService.ensureDir(hlsDir);

      const variantEntries: MasterVariant[] = [];

      for (const tier of renditions) {
        const renditionKeyPrefix = this.storageService.hlsRenditionKeyPrefix(
          movieId,
          tier.name,
        );

        // A retry after a partial failure shouldn't redo tiers that already
        // finished transcoding *and* uploading — on a big file those earlier
        // tiers can represent most of an hour of work. Only the tier that
        // was still in flight (or never started) actually needs redoing.
        const alreadyUploaded = await this.minioService.objectExists(
          `${renditionKeyPrefix}/index.m3u8`,
        );

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
            targetWidth: tier.width,
            targetHeight: tier.height,
            videoBitrate: tier.videoBitrate,
          });

          // ffmpeg can only write to a real local path, so outputDir is
          // scratch space — push the finished rendition (playlist + segments)
          // to the storage server, then it's no longer needed on local disk.
          await this.minioService.uploadDirectory(
            outputDir,
            renditionKeyPrefix,
          );
          this.logger.log(`Rendition ${tier.name} ready for movie ${movieId}`);
        } else {
          this.logger.log(
            `Rendition ${tier.name} already uploaded for movie ${movieId} — skipping re-transcode`,
          );
        }

        variantEntries.push({
          name: tier.name,
          tierHeight: tier.height,
          bandwidth: tier.bandwidth,
          // The REAL output size, by the same fit-inside maths as the scale
          // filter: a 1920x800 film's 720p rung is 1280x534, not 1280x720.
          ...fitInsideBox(tier, probe.width, probe.height),
        });
      }

      const masterPath = join(hlsDir, 'master.m3u8');
      await writeFile(masterPath, buildMasterPlaylist(variantEntries), 'utf-8');
      await this.minioService.uploadFile(
        this.storageService.hlsMasterKey(movieId),
        masterPath,
      );

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

      // buildMasterPlaylist() above wrote a master from scratch (480p rung
      // first, then highest to lowest — see master-playlist.ts), so any
      // subtitle group a previous publish had put there is gone. Re-derive
      // it from the rows that still exist. Never allowed to fail the
      // pipeline: the transcode itself succeeded, and the catch below would
      // otherwise mark a perfectly good video FAILED.
      try {
        await this.hlsSubtitlesService.publishForVideo(videoId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Could not publish subtitle renditions for video ${videoId}: ${reason}`,
        );
      }

      // Auto-publish: nobody is in the request here, so this is a SYSTEM
      // audit row — the staff member's own upload was recorded as
      // movie.upload by UploadsService when the file landed.
      const before = await this.movieForAudit(movieId);
      await this.prisma.movie.update({
        where: { id: movieId },
        data: { status: MovieStatus.PUBLISHED },
      });
      await this.audit.record({
        action: statusDerivedAuditAction(
          'movie',
          before?.status,
          MovieStatus.PUBLISHED,
        ),
        actor: null,
        target: { type: 'movie', id: movieId, label: before?.title ?? null },
        before: { status: before?.status ?? null },
        after: { status: MovieStatus.PUBLISHED },
        metadata: { trigger: 'transcode_complete', videoId },
      });

      this.logger.log(
        `Video ${videoId} processed successfully for movie ${movieId}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown processing error';
      this.logger.error(`Processing failed for video ${videoId}: ${message}`);

      // The movie — and, by cascade, this Video row — can be deleted while
      // this runs in the background. Recording the failure then throws
      // P2025 from inside the handler itself, and an unhandled rejection is
      // fatal in Node: that is what previously killed the whole container.
      // Nothing in here is allowed to escape.
      try {
        await this.videosService.markFailed(videoId, message);
        const before = await this.movieForAudit(movieId);
        await this.prisma.movie.update({
          where: { id: movieId },
          data: { status: MovieStatus.DRAFT },
        });
        await this.audit.record({
          action: statusDerivedAuditAction(
            'movie',
            before?.status,
            MovieStatus.DRAFT,
          ),
          actor: null,
          target: { type: 'movie', id: movieId, label: before?.title ?? null },
          before: { status: before?.status ?? null },
          after: { status: MovieStatus.DRAFT },
          metadata: { trigger: 'transcode_failed', videoId, error: message },
        });
      } catch (recordError) {
        const reason =
          recordError instanceof Error ? recordError.message : 'unknown error';
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
      //
      // The local original is the exception while it is the ONLY copy: a
      // failure before or during the archive step (the probe, the multi-GB
      // upload to MinIO) used to delete it too, so Reprocess had nothing to
      // read and the admin was forced into a re-upload (STR-004). Once the
      // row points at a MinIO key the local file is just a copy and goes;
      // a kept original is removed by the 04:00 scratch sweep after 24 h.
      await this.cleanupScratch(
        movieId,
        inputPath,
        await this.localOriginalStillNeeded(videoId, inputPath),
      );
    } finally {
      if (taken) this.slots.release();
    }
  }

  /** Title + status as they are right before the pipeline flips the status — the audit `before`. */
  private movieForAudit(movieId: string) {
    return this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { title: true, status: true },
    });
  }

  /**
   * True while the Video row still names the local scratch file this run
   * was fed as its original — archiving never reached updateOriginalPath,
   * so that file is the only copy and Reprocess will read it from there
   * (UploadsService.resolveOriginalForReprocessing). False once the row
   * holds a MinIO key, and for a row that is gone (the movie was deleted
   * mid-run: nothing is left to reprocess). A lookup that fails keeps the
   * file — the safe side; the scratch sweep removes it after 24 h.
   */
  private async localOriginalStillNeeded(
    videoId: string,
    inputPath: string,
  ): Promise<boolean> {
    try {
      const row = await this.prisma.video.findUnique({
        where: { id: videoId },
        select: { originalPath: true },
      });
      return row?.originalPath === inputPath;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Could not tell whether video ${videoId}'s original is archived — keeping the local file: ${reason}`,
      );
      return true;
    }
  }

  /**
   * Removes this movie's local scratch files. Best-effort by design: it runs
   * on both the success and failure paths, and a cleanup problem must never
   * turn into the error the caller sees (or, worse, an unhandled rejection).
   * `keepOriginal` leaves the input file in place (see
   * localOriginalStillNeeded); the HLS scratch folder always goes.
   */
  private async cleanupScratch(
    movieId: string,
    inputPath: string,
    keepOriginal = false,
  ): Promise<void> {
    try {
      await rm(this.storageService.hlsDir(movieId), {
        recursive: true,
        force: true,
      });
      if (!keepOriginal) await rm(inputPath, { force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Could not clean scratch files for movie ${movieId}: ${reason}`,
      );
    }
  }
}
