import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UploadStatus, VideoStatus } from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { LOCAL_SCRATCH_ROOTS } from '../common/storage/media-taxonomy';
import { PrismaService } from '../prisma/prisma.service';
import { ABANDONED_SESSION_AGE_MS } from './multipart-upload.service';

// A scratch directory nobody has touched for this long belongs to a run
// that is over — every flow that writes under <STORAGE_PATH>/temp/ either
// finishes and removes its own directory within minutes, or died. Well
// clear of the longest legitimate run (a multi-hour transcode) while still
// short enough that a failed upload does not hold disk for a week.
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The scratch root holding one directory per chunked UploadSession — the
// only root whose owner is a row we can ask about, which is why it gets the
// extra resumability check below. Must stay one of LOCAL_SCRATCH_ROOTS.
const UPLOADS_SCRATCH_ROOT = 'uploads';

// The scratch root ffmpeg reads its input from and writes its output to,
// keyed by movie id — protected while a Video row for that movie is still
// PROCESSING, because a directory's own mtime stops moving once ffmpeg is
// working inside a SUBdirectory of it (hls/<tier>/), so mtime alone would
// eventually call a long transcode abandoned. Must stay one of
// LOCAL_SCRATCH_ROOTS.
const VIDEOS_SCRATCH_ROOT = 'videos';

/**
 * Automatic cleanup for abandoned uploads — the "clean up abandoned uploads
 * automatically" requirement. No cron infrastructure existed anywhere in
 * this backend before this; this is the first use of @nestjs/schedule here.
 *
 * Two independent sweeps, because there are two independent kinds of
 * leftovers: MinIO-side multipart uploads that were never completed, and
 * local scratch directories under <STORAGE_PATH>/temp/ whose run is over.
 *
 * The MinIO sweep covers both orphan directions:
 *  1. A MultipartUploadSession row stuck IN_PROGRESS (the browser tab
 *     closed, the admin gave up) — its MinIO-side upload is still sitting
 *     there holding storage until aborted.
 *  2. A MinIO-side multipart upload with no matching row at all — the crash
 *     window between CreateMultipartUploadCommand succeeding and the Prisma
 *     insert landing. Only ListMultipartUploadsCommand can find these,
 *     since there's nothing in Postgres to query.
 *
 * Backstopped by a MinIO bucket lifecycle rule (see
 * MinioService.ensureLifecycle()) beneath this — if this cron is ever down
 * or buggy, MinIO reclaims the storage on its own after a longer window
 * regardless. Small-file single-PUT uploads (see MultipartUploadService's
 * presignBatch()) have no server-side abandoned state at all — a PUT either
 * lands or it doesn't — so nothing here concerns them.
 *
 * The local sweep has no backstop at all: nothing used to remove a scratch
 * directory except the flow that created it, on its own success path (see
 * UploadsService.cleanupChunks and ProcessingService's cleanup), so every
 * upload or transcode that failed leaked disk permanently. It is only safe
 * to walk <STORAGE_PATH>/temp/ blindly because NOTHING long-lived is
 * written there — see StorageService, which is the only thing that builds
 * these paths.
 */
@Injectable()
export class UploadCleanupService {
  private readonly logger = new Logger(UploadCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweepAbandonedMultipartUploads(): Promise<void> {
    const abortedRows = await this.sweepStaleSessionRows();
    const abortedOrphans = await this.sweepOrphanedMinioUploads();
    if (abortedRows > 0 || abortedOrphans > 0) {
      this.logger.log(
        `Cleanup swept ${abortedRows} stale session row(s) and ${abortedOrphans} orphaned MinIO upload(s)`,
      );
    }
  }

  private async sweepStaleSessionRows(): Promise<number> {
    const cutoff = new Date(Date.now() - ABANDONED_SESSION_AGE_MS);
    const stale = await this.prisma.multipartUploadSession.findMany({
      where: { status: UploadStatus.IN_PROGRESS, updatedAt: { lt: cutoff } },
    });

    for (const session of stale) {
      await this.minioService.abortMultipartUpload(
        session.objectKey,
        session.minioUploadId,
      );
      await this.prisma.multipartUploadSession.update({
        where: { id: session.id },
        data: { status: UploadStatus.FAILED },
      });
    }
    return stale.length;
  }

  private async sweepOrphanedMinioUploads(): Promise<number> {
    const cutoffMs = Date.now() - ABANDONED_SESSION_AGE_MS;
    const minioUploads =
      await this.minioService.listInProgressMultipartUploads();
    if (minioUploads.length === 0) return 0;

    const knownRows = await this.prisma.multipartUploadSession.findMany({
      where: { minioUploadId: { in: minioUploads.map((u) => u.uploadId) } },
      select: { minioUploadId: true },
    });
    const knownUploadIds = new Set(knownRows.map((row) => row.minioUploadId));

    let abortedCount = 0;
    for (const upload of minioUploads) {
      const isOrphan = !knownUploadIds.has(upload.uploadId);
      const isStale =
        !upload.initiated || upload.initiated.getTime() < cutoffMs;
      if (!isOrphan || !isStale) continue;
      await this.minioService.abortMultipartUpload(upload.key, upload.uploadId);
      abortedCount++;
    }
    return abortedCount;
  }

  /**
   * Removes the local scratch directories left behind by runs that are
   * over. Deliberately an hour after the MinIO sweep: the two touch nothing
   * in common, and keeping them apart means a failure in one never skips
   * the other.
   *
   * It walks exactly the roots the media taxonomy declares
   * (LOCAL_SCRATCH_ROOTS under <STORAGE_PATH>/temp/) and only their DIRECT
   * children — one directory per upload session, movie or book — so it can
   * never wander into a tree it does not understand, and a root that a
   * feature has not started writing yet (the reserved audio/ one) simply
   * does not exist and is skipped.
   *
   * Age comes from the entry's own mtime, which is the last time that run
   * added or removed a direct child of it. That is a true activity signal
   * for a chunked upload (chunk files ARE direct children) but NOT for a
   * transcode, whose output goes into a subdirectory — hence the live-owner
   * check, which is the part that actually protects work in flight.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweepStaleLocalScratch(): Promise<void> {
    const cutoffMs = Date.now() - SCRATCH_MAX_AGE_MS;
    const liveOwners = await this.liveScratchOwners();

    let removed = 0;
    for (const root of LOCAL_SCRATCH_ROOTS) {
      const rootPath = join(this.storageService.scratchRoot, root);
      let entries: string[];
      try {
        entries = await readdir(rootPath);
      } catch {
        continue; // nothing has ever written this root
      }

      for (const entry of entries) {
        if (liveOwners.get(root)?.has(entry)) continue;
        const entryPath = join(rootPath, entry);
        try {
          const info = await stat(entryPath);
          if (info.mtimeMs >= cutoffMs) continue;
          await rm(entryPath, { recursive: true, force: true });
          removed++;
        } catch (error) {
          // A directory that vanished mid-sweep (the owning run finished
          // between the readdir and the stat) is the expected race, not a
          // problem — but an EACCES would be, so it is never silent.
          this.logger.warn(
            `Could not sweep scratch directory ${entryPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    if (removed > 0) {
      this.logger.log(`Cleanup removed ${removed} stale scratch directories`);
    }
  }

  /**
   * The scratch directory names that must be left alone because a run still
   * owns them, per root. Two roots have an owner worth asking about:
   *
   *  - uploads/<uploadId>: a session that is still IN_PROGRESS and was
   *    touched within the abandoned-session window is RESUMABLE — deleting
   *    its chunks would silently force the client to re-send a file it has
   *    already sent most of. Past that window the row is abandoned in every
   *    other part of this system too, so its chunks go.
   *  - videos/<movieId>: a PROCESSING Video is ffmpeg's live input and
   *    output directory.
   *
   * The other roots (a book conversion's scratch) have no row of their own
   * and are governed by mtime alone, which is sound there because those
   * runs are minutes long, not hours.
   */
  private async liveScratchOwners(): Promise<Map<string, Set<string>>> {
    const resumableCutoff = new Date(Date.now() - ABANDONED_SESSION_AGE_MS);
    const [resumableSessions, processingVideos] = await Promise.all([
      this.prisma.uploadSession.findMany({
        where: {
          status: UploadStatus.IN_PROGRESS,
          updatedAt: { gte: resumableCutoff },
        },
        select: { id: true },
      }),
      this.prisma.video.findMany({
        where: { status: VideoStatus.PROCESSING },
        select: { movieId: true },
      }),
    ]);

    return new Map([
      [UPLOADS_SCRATCH_ROOT, new Set(resumableSessions.map((row) => row.id))],
      [
        VIDEOS_SCRATCH_ROOT,
        new Set(processingVideos.map((row) => row.movieId)),
      ],
    ]);
  }
}
