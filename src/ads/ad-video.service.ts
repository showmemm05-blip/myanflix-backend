import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AdvertisementFormat } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { advertisementSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import {
  AD_VIDEO_FILENAME,
  StorageService,
} from '../common/storage/storage.service';
import {
  ISO_BMFF_HEADER_BYTES,
  isIsoBmff,
} from '../common/utils/video-magic-bytes';
import { PrismaService } from '../prisma/prisma.service';
import { probeVideo, remuxFastStart } from '../processing/ffmpeg.util';
import { maxAdVideoUploadBytes } from '../uploads/upload-limits';
import { ADS_ERRORS, adBadRequest, adError } from './ads-errors';
import { AD_LIMITS, type AttachAdVideoDto } from './dto/advertisement.dto';

/**
 * POST /ads/admin/:id/video/attach — turns the file the admin uploaded to
 * temp/ads/<adId>/video.mp4 (the "ad" upload type) into the ad's served
 * video. The backend never saw the upload (it went straight to MinIO), so
 * everything is checked here: the object exists and is under the cap, its
 * first bytes are an MP4 container, ffprobe reads a duration inside the
 * allowed range. The file is then remuxed for fast start (index first, so
 * a phone shows the first frame before the whole file is down) and written
 * to a fresh ads/<adId>/v-<tag>/video.mp4 — never over the old key, which
 * the cache servers may hold for 7 days. Nothing is written to the row
 * until the new object is in place; the old package and the staging copy
 * are deleted only after the row points at the new one.
 */
@Injectable()
export class AdVideoService {
  private readonly logger = new Logger(AdVideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly minio: MinioService,
    private readonly storage: StorageService,
  ) {}

  async attach(
    adId: string,
    dto: AttachAdVideoDto,
    actor: AuthenticatedUser,
  ): Promise<void> {
    if (dto.relativePath !== AD_VIDEO_FILENAME) {
      throw adBadRequest(
        ADS_ERRORS.VIDEO_MISSING,
        `Upload the file as "${AD_VIDEO_FILENAME}" first.`,
      );
    }
    const ad = await this.prisma.advertisement.findUnique({
      where: { id: adId },
      include: { movies: { select: { movieId: true } } },
    });
    if (!ad) {
      throw adError(
        HttpStatus.NOT_FOUND,
        ADS_ERRORS.NOT_FOUND,
        'Advertisement not found',
      );
    }
    if (ad.format !== AdvertisementFormat.VIDEO) {
      throw adBadRequest(
        ADS_ERRORS.FORMAT_MISMATCH,
        'A corner ad takes a picture, not a video.',
      );
    }

    const stagingKey = this.storage.adStagingKey(adId);
    const staged = await this.minio.objectStat(stagingKey);
    if (!staged) {
      throw adError(
        HttpStatus.NOT_FOUND,
        ADS_ERRORS.VIDEO_MISSING,
        'The video did not reach the server. Upload it again.',
      );
    }
    const maxBytes = maxAdVideoUploadBytes();
    if (staged.size > maxBytes) {
      throw adBadRequest(
        ADS_ERRORS.VIDEO_TOO_LARGE,
        'The video is too large.',
        {
          bytes: staged.size,
          maxBytes,
        },
      );
    }
    const header = await this.minio.readBytes(
      stagingKey,
      ISO_BMFF_HEADER_BYTES,
    );
    if (!isIsoBmff(header)) {
      throw adBadRequest(
        ADS_ERRORS.VIDEO_NOT_MP4,
        'The uploaded file is not an MP4 video.',
      );
    }

    const runId = randomBytes(4).toString('hex');
    const scratch = this.storage.adScratchDir(adId, runId);
    const sourcePath = join(scratch, 'source.mp4');
    const readyPath = join(scratch, 'ready.mp4');
    try {
      await this.storage.ensureDir(scratch);
      try {
        await this.minio.downloadFile(stagingKey, sourcePath);
      } catch (error) {
        // Gone between the stat and the read: another attach of this ad
        // just consumed it (it deletes the staging copy when it lands).
        this.logger.warn(
          `Ad ${adId}: staged upload vanished before the download — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw adError(
          HttpStatus.NOT_FOUND,
          ADS_ERRORS.VIDEO_MISSING,
          'The video did not reach the server. Upload it again.',
        );
      }

      let durationSeconds: number;
      try {
        durationSeconds = Math.round(
          (await probeVideo(sourcePath)).durationSeconds,
        );
      } catch (error) {
        this.logger.warn(
          `Ad ${adId}: ffprobe refused the upload — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw adBadRequest(
          ADS_ERRORS.VIDEO_UNREADABLE,
          'This video cannot be read. Use an MP4 with H.264 video and AAC audio.',
        );
      }
      if (durationSeconds < AD_LIMITS.durationSeconds.min) {
        throw adBadRequest(
          ADS_ERRORS.VIDEO_UNREADABLE,
          'This video has no playable length.',
        );
      }
      if (durationSeconds > AD_LIMITS.durationSeconds.max) {
        throw adBadRequest(
          ADS_ERRORS.VIDEO_TOO_LONG,
          'The video is too long.',
          {
            durationSeconds,
            maxSeconds: AD_LIMITS.durationSeconds.max,
          },
        );
      }

      // A remux that fails (an exotic container ffmpeg will not rewrite) is
      // not a reason to refuse the ad: the original plays, just slower to
      // start on a phone.
      let uploadPath = readyPath;
      try {
        await remuxFastStart(sourcePath, readyPath);
      } catch (error) {
        this.logger.warn(
          `Ad ${adId}: faststart remux failed, keeping the upload as is — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        uploadPath = sourcePath;
      }

      const tag = randomBytes(4).toString('hex');
      const videoKey = this.storage.adVideoKey(adId, tag);
      await this.minio.uploadFile(videoKey, uploadPath);
      const [{ size: videoBytes }, stored] = await Promise.all([
        stat(uploadPath),
        this.minio.objectStat(videoKey),
      ]);

      const previousKey = ad.videoKey;
      await this.prisma
        .$transaction(async (tx) => {
          // Re-read inside the transaction: the skip rule must hold against
          // the duration being attached, and the row must still point where
          // this run started from — two attaches at once would otherwise
          // leave one package unreferenced and both "succeeding".
          const current = await tx.advertisement.findUniqueOrThrow({
            where: { id: adId },
            select: {
              isSkippable: true,
              skipAfterSeconds: true,
              videoKey: true,
            },
          });
          if (current.videoKey !== previousKey) {
            throw adError(
              HttpStatus.CONFLICT,
              ADS_ERRORS.VIDEO_ATTACH_CONFLICT,
              'Another upload landed on this ad meanwhile. Upload and attach again.',
            );
          }
          // The form's skip fields travel with the file so they are checked
          // against the NEW length; absent = the stored ones.
          const isSkippable = dto.isSkippable ?? current.isSkippable;
          const skipAfterSeconds = isSkippable
            ? dto.skipAfterSeconds === undefined
              ? current.skipAfterSeconds
              : dto.skipAfterSeconds
            : null;
          if (isSkippable && skipAfterSeconds === null) {
            throw adBadRequest(
              ADS_ERRORS.SKIP_AFTER_REQUIRED,
              'Enter when skipping is allowed.',
            );
          }
          if (
            isSkippable &&
            skipAfterSeconds !== null &&
            skipAfterSeconds >= durationSeconds
          ) {
            throw adError(
              HttpStatus.CONFLICT,
              ADS_ERRORS.SKIP_AFTER_TOO_LONG,
              'Skip-after must be shorter than the video. Lower it, then attach again.',
              { durationSeconds, skipAfterSeconds },
            );
          }
          const after = await tx.advertisement.update({
            where: { id: adId },
            data: {
              videoKey,
              videoBytes,
              videoEtag: stored?.etag ?? null,
              durationSeconds,
              videoAttachedAt: new Date(),
              isSkippable,
              skipAfterSeconds,
            },
          });
          const movieIds = ad.movies.map((row) => row.movieId);
          await this.audit.record({
            action: 'advertisement.video_attach',
            actor,
            target: { type: 'advertisement', id: adId, label: after.title },
            before: advertisementSnapshot({ ...ad, movieIds }),
            after: advertisementSnapshot({ ...after, movieIds }),
            metadata: {
              bytes: videoBytes,
              durationSeconds,
              previousKey: previousKey ?? null,
            },
            tx,
          });
        })
        .catch(async (error: unknown) => {
          // The row never pointed at the new object: remove it so a refused
          // attach leaves no orphan package behind.
          await this.minio
            .deleteByPrefix(`${dirname(videoKey)}/`)
            .catch(() => undefined);
          throw error;
        });

      await this.minio.deleteObject(stagingKey).catch(() => undefined);
      if (previousKey) {
        await this.minio
          .deleteByPrefix(`${dirname(previousKey)}/`)
          .catch(() => undefined);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
