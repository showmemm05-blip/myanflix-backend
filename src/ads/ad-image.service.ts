import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { AdvertisementFormat } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { advertisementSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import {
  sniffImageType,
  type ImageMimeType,
} from '../common/utils/image-magic-bytes';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS, adBadRequest, adError } from './ads-errors';
import { AdsAdminService, type StaffAdView } from './ads-admin.service';
import { AD_LIMITS } from './dto/advertisement.dto';

/** Multer's own cap — above the service's, so a 3–5 MB file gets the coded 413 with sizes. */
export const AD_IMAGE_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

interface PreparedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * A corner ad's picture (POST /ads/admin/:id/image, ADS.MANAGE): checked
 * by its bytes, measured, stored under images/ad/<adId>/ and attached to
 * the row — the avatar pattern (one folder per owner, the key stored, the
 * URL built per request). Not POST /uploads/image: that route needs
 * MEDIA.UPLOAD, and a flat purpose folder gives no prefix delete.
 *
 * A GIF is never opened by sharp (its size is read off the header) and an
 * animated WebP is never re-encoded: both are stored byte-for-byte so they
 * keep moving. A still picture wider than AD_LIMITS.imageMaxWidth is
 * scaled down — it is shown a few hundred pixels wide at most.
 */
@Injectable()
export class AdImageService {
  private readonly logger = new Logger(AdImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly minio: MinioService,
    private readonly storage: StorageService,
    private readonly ads: AdsAdminService,
  ) {}

  async attach(
    adId: string,
    file: Express.Multer.File | undefined,
    actor: AuthenticatedUser,
  ): Promise<StaffAdView> {
    const before = await this.ads.findRow(adId);
    if (before.format !== AdvertisementFormat.CORNER) {
      throw adBadRequest(
        ADS_ERRORS.FORMAT_MISMATCH,
        'Only a corner ad takes a picture.',
      );
    }
    if (!file?.buffer?.length) {
      throw adBadRequest(
        ADS_ERRORS.IMAGE_UNSUPPORTED,
        'No picture received (expected the field "file").',
      );
    }
    if (file.buffer.length > AD_LIMITS.imageBytes) {
      throw adError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        ADS_ERRORS.IMAGE_TOO_LARGE,
        'The picture is too large.',
        { bytes: file.buffer.length, maxBytes: AD_LIMITS.imageBytes },
      );
    }
    const type = sniffImageType(file.buffer);
    if (!type) {
      throw adBadRequest(
        ADS_ERRORS.IMAGE_UNSUPPORTED,
        'Use a PNG, JPEG, WebP or GIF picture.',
      );
    }
    const image = await this.prepare(file.buffer, type.mimetype);
    const shortSide = Math.min(image.width, image.height);
    const longSide = Math.max(image.width, image.height);
    if (
      shortSide < AD_LIMITS.imageMinSide ||
      longSide > shortSide * AD_LIMITS.imageMaxAspect
    ) {
      throw adBadRequest(
        ADS_ERRORS.IMAGE_SHAPE_INVALID,
        `The picture must be at least ${AD_LIMITS.imageMinSide} px on each side and no longer than ${AD_LIMITS.imageMaxAspect}:1.`,
        { width: image.width, height: image.height },
      );
    }

    const key = this.storage.adImageKey(
      adId,
      randomBytes(4).toString('hex'),
      type.extension,
    );
    await this.minio.uploadBuffer(key, image.buffer);
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.advertisement.update({
          where: { id: adId },
          data: {
            imageKey: key,
            imageBytes: image.buffer.length,
            imageWidth: image.width,
            imageHeight: image.height,
            imageAttachedAt: new Date(),
          },
        });
        const movieIds = before.movies.map((m) => m.movieId);
        await this.audit.record({
          action: 'advertisement.image_attach',
          actor,
          target: { type: 'advertisement', id: adId, label: row.title },
          before: advertisementSnapshot({ ...before, movieIds }),
          after: advertisementSnapshot({ ...row, movieIds }),
          metadata: {
            bytes: image.buffer.length,
            width: image.width,
            height: image.height,
            type: type.mimetype,
            replaced: before.imageKey !== null,
          },
          tx,
        });
      });
    } catch (error) {
      // Nothing points at the new object: take it back out.
      await this.minio.deleteObject(key).catch(() => undefined);
      throw error;
    }

    // The old picture, only ever inside this ad's own folder (a tampered
    // key could otherwise reach someone else's object).
    const prefix = `${this.storage.adImagePrefix(adId)}/`;
    if (
      before.imageKey &&
      before.imageKey !== key &&
      before.imageKey.startsWith(prefix)
    ) {
      await this.minio.deleteObject(before.imageKey).catch((error: unknown) => {
        this.logger.warn(
          `Ad ${adId}: could not delete the replaced picture ${before.imageKey} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return this.ads.findOne(adId);
  }

  /** The bytes to store and the size the players get (a still picture may be scaled down). */
  private async prepare(
    buffer: Buffer,
    mimetype: ImageMimeType,
  ): Promise<PreparedImage> {
    if (mimetype === 'image/gif') {
      // Logical screen size, bytes 6–9 little-endian; sharp never opens a GIF.
      if (buffer.length < 10) throw this.unreadable();
      return {
        buffer,
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      };
    }
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buffer).metadata();
    } catch {
      throw this.unreadable();
    }
    if (!meta.width || !meta.height) throw this.unreadable();
    // EXIF orientations 5–8 swap the axes once .rotate() applies them.
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = swapped ? meta.height : meta.width;
    const height = swapped ? meta.width : meta.height;
    const animated = (meta.pages ?? 1) > 1;
    if (animated || width <= AD_LIMITS.imageMaxWidth) {
      // Animated WebP keeps every frame; a small still is stored as sent
      // (its EXIF turn, if any, is the browser's to apply).
      return { buffer, width, height };
    }
    const pipeline = sharp(buffer)
      .rotate()
      .resize({ width: AD_LIMITS.imageMaxWidth, withoutEnlargement: true });
    const out = await (
      meta.format === 'jpeg'
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : meta.format === 'png'
          ? pipeline.png()
          : pipeline.webp({ quality: 82 })
    ).toBuffer({ resolveWithObject: true });
    return { buffer: out.data, width: out.info.width, height: out.info.height };
  }

  private unreadable() {
    return adBadRequest(
      ADS_ERRORS.IMAGE_UNSUPPORTED,
      'The picture could not be read. Use a PNG, JPEG, WebP or GIF picture.',
    );
  }
}
