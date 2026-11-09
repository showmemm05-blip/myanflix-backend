import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import sharp from 'sharp';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import type { ImagePurpose } from '../common/storage/media-taxonomy';
import {
  sniffImageType,
  type ImageMimeType,
} from '../common/utils/image-magic-bytes';
import { TMDB_IMAGE_ID_PREFIX } from './image-source';

/**
 * Widest an uploaded ARTWORK image is stored at, per image purpose (see
 * ImageStoreService.downscaleArtwork). The purpose names the owner, not the
 * slot, so the image's own shape picks the cap: portrait or square art
 * (posters, headshots) is mostly shown small, landscape art (covers,
 * backdrops, episode thumbnails) can fill a desktop hero. Film and series
 * posters get 1300: the phone's title page (mobile TitleHero) draws the
 * poster edge to edge, which is about 1170-1290 real pixels on current
 * phones, so 1000 would be stretched there. "book" also carries chapter
 * and inline reading images, so it gets the PDF page width (1600) for any
 * shape. Purposes left out — payment logos/QR codes, category, other — are
 * always stored exactly as uploaded.
 */
const ARTWORK_MAX_WIDTH: Partial<
  Record<ImagePurpose, { portrait: number; landscape: number }>
> = {
  movie: { portrait: 1300, landscape: 1920 },
  series: { portrait: 1300, landscape: 1920 },
  music: { portrait: 1000, landscape: 1920 },
  actor: { portrait: 1000, landscape: 1000 },
  bookauthor: { portrait: 1000, landscape: 1000 },
  book: { portrait: 1600, landscape: 1600 },
  // Home promo art fills the full-bleed home hero on desktop, like a
  // movie backdrop, and a phone-width poster slot otherwise.
  promo: { portrait: 1300, landscape: 1920 },
  // A dream picture is a card thumbnail (the Lottery dream books), shown
  // small like a headshot.
  lottery: { portrait: 1000, landscape: 1000 },
  // The ticket frame is print artwork: the whole ticket (1800 x 940 at 1x,
  // 3600 x 1880 at 2x) is drawn on it and every text layer is placed by
  // fractions of its size, so it is kept at up to 4000 px either way.
  lottery_frame: { portrait: 4000, landscape: 4000 },
};

/**
 * The most bytes POST /uploads/image accepts, per purpose. Every purpose
 * keeps the 10 MB the route always had, except the ticket frame: a 3600 x
 * 1880 PNG with real artwork is 6-8 MB and a richer one goes past 10 MB, so
 * the purpose the pixel cap above was raised for gets 25 MB. The route's
 * multer limit is the largest of these (so no purpose can smuggle more
 * past it); save() applies the purpose's own figure with a coded 413
 * before the bytes are sniffed, resized or stored.
 */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const FRAME_IMAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** The byte cap for one purpose — see IMAGE_UPLOAD_MAX_BYTES. */
export function imageUploadByteLimit(purpose: ImagePurpose): number {
  return purpose === 'lottery_frame'
    ? FRAME_IMAGE_UPLOAD_MAX_BYTES
    : IMAGE_UPLOAD_MAX_BYTES;
}

/** The 413 a staff image upload gets when it is over its purpose's byte cap. */
export const IMAGE_UPLOAD_TOO_LARGE_CODE = 'IMAGE_UPLOAD_TOO_LARGE';
export function imageUploadTooLargeMessage(maxBytes: number): string {
  return `The image is too large — up to ${Math.round(maxBytes / (1024 * 1024))} MB is allowed`;
}

/**
 * The 400 a staff image upload gets when its bytes are not a JPEG, PNG,
 * WebP or GIF — whatever the filename or Content-Type claimed (SEC-019).
 */
export const IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE =
  'IMAGE_UPLOAD_UNSUPPORTED_TYPE';
export const IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE =
  'Only JPEG, PNG, WebP or GIF images are allowed';

/** Where the bytes of a stored image came from, when not from a staff upload. */
export interface ImageSaveOptions {
  /**
   * 'tmdb' = the backend fetched the picture from TMDB. The file is then
   * named tmdb-<uuid> (see image-source.ts) and the audit row says so.
   * Omitted = a staff upload: a bare uuid, exactly as before.
   */
  source?: 'tmdb';
  /** What it was fetched from — for TMDB, the picture's TMDB file path. Audit only. */
  sourceRef?: string;
}

/**
 * Checks, resizes and stores one still image, and records the upload. Lifted
 * out of UploadsService (2026-11-06) so the TMDB module can store the
 * pictures it fetches through the very same checks a staff upload gets —
 * UploadsService.saveImage is now a one-line call into save().
 */
@Injectable()
export class ImageStoreService {
  private readonly logger = new Logger(ImageStoreService.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Uploads a still image straight to the storage server (no local disk
   * involved) and returns its public URL. `purpose` decides which folder
   * under images/ it lands in and is validated by UploadImageDto — there is
   * no default, because an image in the wrong folder is invisible to the
   * prefix-based cleanup paths that are supposed to find it later.
   *
   * What the file IS comes from its first bytes — never from the client's
   * filename or Content-Type, both of which it controls. Anything that is
   * not a JPEG, PNG, WebP or GIF by its magic bytes is refused with a 400
   * before a single byte lands under the public images/ folder and before
   * sharp opens it (SEC-008, SEC-019); the stored extension is the one the
   * bytes say, so a PDF renamed to poster.jpg can neither be stored nor
   * be served as anything.
   *
   * `options.source` marks a picture the backend fetched itself: the same
   * byte cap, byte check, resize and audit row apply, and only the file
   * name (and two audit fields) differ. A staff upload passes no options.
   */
  async save(
    purpose: ImagePurpose,
    originalFilename: string,
    buffer: Buffer,
    actor: AuthenticatedUser,
    options?: ImageSaveOptions,
  ): Promise<string> {
    // The purpose's own byte cap first: the route's multer limit is the
    // largest cap of any purpose, so a 20 MB poster gets this far and is
    // refused here, before its bytes are sniffed, opened or stored.
    const maxBytes = imageUploadByteLimit(purpose);
    if (buffer.length > maxBytes) {
      throw new CodedHttpException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        IMAGE_UPLOAD_TOO_LARGE_CODE,
        imageUploadTooLargeMessage(maxBytes),
        { maxBytes },
      );
    }
    const image = sniffImageType(buffer);
    if (!image) {
      throw new CodedHttpException(
        HttpStatus.BAD_REQUEST,
        IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
        IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE,
      );
    }
    const fromTmdb = options?.source === 'tmdb';
    const key = this.storageService.imageObjectKey(
      purpose,
      // The tmdb- file name is the only mark a TMDB picture carries.
      fromTmdb ? `${TMDB_IMAGE_ID_PREFIX}${randomUUID()}` : randomUUID(),
      image.extension,
    );
    // Artwork is shrunk to a sensible display size before it is stored;
    // anything else (and anything sharp cannot read) is stored exactly as
    // uploaded, as it always was. Same key, same URL, same response.
    const stored = await this.downscaleArtwork(purpose, buffer, image.mimetype);
    await this.minioService.uploadBuffer(key, stored);
    // No owner row exists yet (the image is uploaded before the movie /
    // actor / category it belongs to is created), so the row names the
    // purpose folder and the key — enough to find the object again (M-22).
    await this.audit.record({
      action: 'image.upload',
      actor,
      target: { type: 'image', id: null, label: basename(key) },
      metadata: {
        purpose,
        key,
        originalFilename,
        // What is stored; originalSize is what was uploaded.
        fileSize: stored.length,
        originalSize: buffer.length,
        ...(fromTmdb
          ? {
              source: 'tmdb',
              ...(options?.sourceRef !== undefined
                ? { sourceRef: options.sourceRef }
                : {}),
            }
          : {}),
      },
    });
    return this.minioService.publicUrl(key);
  }

  /**
   * Shrinks an artwork image that is wider than its purpose needs, keeping
   * its own format (so the key's extension stays truthful) and its aspect
   * ratio. Every client loads images at full stored size (the website's
   * image optimiser is off), so a 5000 px poster shown on a 168 px card
   * used to cost ~100 MB of decoded memory per card on a phone.
   *
   * Only JPEG, PNG and WebP that are wider than the cap are touched; an
   * animated image, any other format, or anything sharp refuses (corrupt
   * data, or over sharp's default input-pixel limit — the decompression
   * bomb guard, deliberately left at its default) is returned unchanged,
   * which is exactly what was stored before this existed.
   *
   * `mimetype` is what save() read off the magic bytes, so sharp only
   * ever opens a file that starts like a JPEG, PNG or WebP: a GIF is never
   * resized (every frame is kept) and so is not opened at all, and nothing
   * that failed the byte check gets this far (SEC-008).
   */
  private async downscaleArtwork(
    purpose: ImagePurpose,
    buffer: Buffer,
    mimetype: ImageMimeType,
  ): Promise<Buffer> {
    const rule = ARTWORK_MAX_WIDTH[purpose];
    if (!rule) return buffer;
    if (mimetype === 'image/gif') return buffer;
    try {
      const meta = await sharp(buffer).metadata();
      const format = meta.format;
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
        return buffer;
      }
      if ((meta.pages ?? 1) > 1) return buffer; // animated: keep every frame
      if (!meta.width || !meta.height) return buffer;
      // EXIF orientations 5-8 swap the axes once .rotate() applies them.
      const swapped = (meta.orientation ?? 1) >= 5;
      const width = swapped ? meta.height : meta.width;
      const height = swapped ? meta.width : meta.height;
      // Posters, portraits and square art are shown small; covers and
      // backdrops (landscape) fill a desktop hero.
      const maxWidth = width > height ? rule.landscape : rule.portrait;
      if (width <= maxWidth) return buffer;

      const pipeline = sharp(buffer)
        .rotate()
        .resize({ width: maxWidth, withoutEnlargement: true });
      const out =
        format === 'jpeg'
          ? pipeline.jpeg({ quality: 82, mozjpeg: true })
          : format === 'png'
            ? pipeline.png()
            : pipeline.webp({ quality: 80 });
      return await out.toBuffer();
    } catch (error) {
      this.logger.warn(
        `Could not resize a ${purpose} image (${buffer.length} bytes) — storing it as uploaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return buffer;
    }
  }
}
