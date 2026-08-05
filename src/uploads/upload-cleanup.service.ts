import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UploadStatus } from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { ABANDONED_SESSION_AGE_MS } from './multipart-upload.service';

/**
 * Automatic cleanup for abandoned direct-to-MinIO multipart uploads — the
 * "clean up abandoned uploads automatically" requirement. No cron
 * infrastructure existed anywhere in this backend before this; this is the
 * first use of @nestjs/schedule here.
 *
 * Covers both orphan directions:
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
 */
@Injectable()
export class UploadCleanupService {
  private readonly logger = new Logger(UploadCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
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
}
