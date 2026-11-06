import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { basename } from 'node:path';
import { MovieStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import type { Permission } from '../roles/permission-catalogue';
import {
  PermissionResolverService,
  type PermissionSubject,
} from '../roles/permission-resolver.service';
import {
  describeBytes,
  maxAdVideoUploadBytes,
  maxDocumentUploadBytes,
  maxVideoUploadBytes,
} from './upload-limits';
import { AD_VIDEO_FILENAME } from '../common/storage/storage.service';

/**
 * The relativePath prefix that marks a bundle file as a subtitle SOURCE
 * rather than a video asset. Exported because UploadsService recognises the
 * same prefix when it parses a bundle's structure — the folder name and the
 * routing rule below must always mean the same thing.
 */
export const SUBTITLE_RELATIVE_PREFIX = 'subtitles/';

/**
 * The resourceType a replacement bundle is uploaded under — the admin passes
 * it to the EXISTING presign-batch / multipart routes, so the files stage
 * under temp/video-replace/<movieId>/ instead of landing on the live keys.
 */
export const MOVIE_REPLACE_RESOURCE_TYPE = 'movie-replace';

/**
 * The resourceType a pre-roll ad's MP4 is uploaded under (2026-11-04). One
 * file only, always named video.mp4, staged under temp/ads/<adId>/ until
 * POST /ads/admin/:id/video/attach checks it and moves it to its served
 * key — the "ad" row must already exist (the admin creates it first).
 */
export const AD_RESOURCE_TYPE = 'ad';

/**
 * The only movie states whose video may be REPLACED (the owner's decision):
 * a live title, one waiting to be published, or one whose earlier bundle was
 * rejected. UPLOADING / PROCESSING are mid-flight in another flow and
 * DRAFT / ARCHIVED have nothing a viewer could be watching. Shared by the
 * registry entry below (so presign-batch / multipart/init refuse to stage
 * for a non-replaceable movie) and by every replace route in UploadsService.
 * Note what is NOT here: the status never CHANGES through a replace — this
 * list only gates entry.
 */
export const REPLACEABLE_MOVIE_STATUSES: readonly MovieStatus[] = [
  MovieStatus.PUBLISHED,
  MovieStatus.READY_TO_PUBLISH,
  MovieStatus.FAILED,
];

/**
 * The only movie states a DIRECT upload (presign-batch, multipart/init or
 * the chunked bundle flow with resourceType "movie") may write to (M-22):
 * a bulk placeholder still collecting its files, or one whose finalize was
 * rejected and is being retried. The direct flows write straight onto the
 * title's live keys (videos/<movieId>/...), so a title in any other state —
 * PUBLISHED above all, but also READY_TO_PUBLISH, DRAFT, PROCESSING and
 * ARCHIVED — is refused with 409: its files only ever change through the
 * versioned, audited replace flow (REPLACEABLE_MOVIE_STATUSES above).
 * Same list as UploadsService's FINALIZABLE_MOVIE_STATUSES, on purpose: what
 * can be uploaded to is exactly what finalize will act on.
 */
export const DIRECT_UPLOAD_MOVIE_STATUSES: readonly MovieStatus[] = [
  MovieStatus.UPLOADING,
  MovieStatus.FAILED,
];

/** The 409 every direct-upload route answers for a movie outside DIRECT_UPLOAD_MOVIE_STATUSES. */
export function directUploadRefusalMessage(status: MovieStatus): string {
  return `Cannot upload files directly to a ${status} movie — only a title that is still UPLOADING or FAILED accepts a direct upload; to change the video of a live title use the movie-replace flow (POST /uploads/:movieId/replace-begin)`;
}

export interface ResourceUploadType {
  permission: Permission;
  /**
   * Largest single file (bytes) this type accepts, enforced by every direct
   * upload route before a session or URL is issued (M-23). Read at call time
   * so the environment override (see upload-limits.ts) takes effect.
   */
  maxFileSize(): number;
  /** Confirms the owning row actually exists before a multipart session/presigned URL is issued against it. */
  assertExists(resourceId: string): Promise<void>;
  /**
   * Full MinIO object key for a file inside this resource's bundle. This is
   * the ONE place a bundle's relativePath is mapped onto the media taxonomy,
   * which is why no client key builder has to know the layout: the browser
   * keeps sending the folder structure it scanned, and every upload path
   * (presigned, multipart, chunked) routes it through here.
   */
  buildKey(resourceId: string, relativePath: string): string;
}

/**
 * The one place that knows how to turn a generic `resourceType` string (see
 * MultipartUploadSession's schema doc comment) into something concrete —
 * ownership validation and an object key. Adding a future resource type is
 * one new entry here; nothing in MultipartUploadService, MinioService, or
 * the frontend upload primitives needs to change.
 *
 * "movie" also serves series episodes, which are just Movie rows with
 * seriesId set (see schema.prisma's Movie doc comment), so no separate
 * "episode" type is needed. Its bundle is not one namespace: the video
 * assets belong under videos/<movieId>/ while an uploaded subtitle is a
 * SOURCE file and belongs under subtitles/<movieId>/, so buildKey splits
 * them — that split is what lets a movie delete be two prefix deletes
 * instead of a per-object hunt.
 *
 * "book" is the chapter source PDF. The admin sends
 * "<editionId>/<chapterId>/original.pdf" and it lands under
 * documents/books/<bookId>/, not books/<bookId>/: books/ holds only
 * GENERATED reader output, and the whole documents/ namespace is denied at
 * the cache server and unsignable, so a source PDF cannot be handed out by
 * accident. The admin then asks the backend to convert it
 * (POST /books/:id/process).
 */
@Injectable()
export class ResourceUploadTypeRegistry {
  private readonly types: Record<string, ResourceUploadType>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolverService,
    private readonly storageService: StorageService,
  ) {
    this.types = {
      movie: {
        permission: 'MEDIA.UPLOAD',
        maxFileSize: maxVideoUploadBytes,
        // Existence AND state: this entry's keys are the title's LIVE keys,
        // so a movie that viewers could be watching is never a valid
        // target here (M-22) — see DIRECT_UPLOAD_MOVIE_STATUSES.
        assertExists: async (resourceId) => {
          const movie = await this.prisma.movie.findUnique({
            where: { id: resourceId },
            select: { id: true, status: true },
          });
          if (!movie) throw new NotFoundException('Movie not found');
          if (!DIRECT_UPLOAD_MOVIE_STATUSES.includes(movie.status)) {
            throw new ConflictException(
              directUploadRefusalMessage(movie.status),
            );
          }
        },
        // A subtitle source is flattened to its BASENAME on purpose: the
        // bundle's own "subtitles/" folder disappears into the key's
        // subtitles/<movieId>/ prefix, and what is left is the operator's
        // filename ("english.vtt"), which is how they identify the track.
        // Two bundle files whose basenames collide would therefore write
        // the same key — UploadsService.parseBundleStructure rejects that
        // before anything is uploaded.
        buildKey: (resourceId, relativePath) =>
          relativePath.startsWith(SUBTITLE_RELATIVE_PREFIX)
            ? this.storageService.subtitleSourceKey(
                resourceId,
                basename(relativePath),
              )
            : `${this.storageService.videoKeyPrefix(resourceId)}/${relativePath}`,
      },
      // A replacement bundle for an EXISTING movie. Same permission and the
      // same bundle shape as "movie", but every file — subtitles included —
      // stages verbatim under temp/video-replace/<movieId>/ (a prefix the
      // cache server denies and nothing can sign), so the title keeps
      // playing its current files while the new ones upload. The videos/ vs
      // subtitles/ split happens at swap time (UploadsService.finalizeReplace)
      // through the "movie" entry above, never here.
      [MOVIE_REPLACE_RESOURCE_TYPE]: {
        permission: 'MEDIA.UPLOAD',
        maxFileSize: maxVideoUploadBytes,
        assertExists: async (resourceId) => {
          const movie = await this.prisma.movie.findUnique({
            where: { id: resourceId },
            select: { id: true, status: true },
          });
          if (!movie) throw new NotFoundException('Movie not found');
          if (!REPLACEABLE_MOVIE_STATUSES.includes(movie.status)) {
            throw new ConflictException(
              `Cannot replace the video of a ${movie.status} movie — only a PUBLISHED, READY_TO_PUBLISH or FAILED title can have its video replaced`,
            );
          }
        },
        buildKey: (resourceId, relativePath) =>
          this.storageService.videoReplaceStagingKey(resourceId, relativePath),
      },
      book: {
        // BOOKS.EDIT rather than MEDIA.UPLOAD: whoever may edit a book may
        // attach its PDF, and the books module has no other reason to grant
        // the movie-pipeline's upload permission.
        permission: 'BOOKS.EDIT',
        maxFileSize: maxDocumentUploadBytes,
        assertExists: async (resourceId) => {
          const book = await this.prisma.book.findUnique({
            where: { id: resourceId },
            select: { id: true },
          });
          if (!book) throw new NotFoundException('Book not found');
        },
        buildKey: (resourceId, relativePath) =>
          `${this.storageService.bookDocumentPrefix(resourceId)}/${relativePath}`,
      },
      [AD_RESOURCE_TYPE]: {
        // ADS.MANAGE: whoever may edit an ad may attach its video; the ads
        // module has no reason to grant the movie pipeline's permission.
        permission: 'ADS.MANAGE',
        maxFileSize: maxAdVideoUploadBytes,
        assertExists: async (resourceId) => {
          const ad = await this.prisma.advertisement.findUnique({
            where: { id: resourceId },
            select: { id: true, format: true },
          });
          if (!ad) throw new NotFoundException('Advertisement not found');
          // A corner ad's picture has its own route; it never takes a video.
          if (ad.format !== 'VIDEO') {
            throw new BadRequestException(
              'A corner ad takes a picture, not a video',
            );
          }
        },
        // Exactly one filename, so the attach step knows what to read and a
        // bundle-shaped upload cannot smuggle a second file into staging.
        buildKey: (resourceId, relativePath) => {
          if (relativePath !== AD_VIDEO_FILENAME) {
            throw new BadRequestException(
              `An advertisement upload must be named "${AD_VIDEO_FILENAME}"`,
            );
          }
          return this.storageService.adStagingKey(resourceId);
        },
      },
    };
  }

  resolve(resourceType: string): ResourceUploadType {
    const type = this.types[resourceType];
    if (!type)
      throw new NotFoundException(`Unknown resourceType "${resourceType}"`);
    return type;
  }

  /**
   * 400 when `filesize` is over the type's budget. Called by every direct
   * upload route before it creates a session or signs a URL, so the size a
   * staff browser declares is checked once, in one place, for all of them.
   */
  assertFileSizeAllowed(
    resourceType: string,
    filesize: number,
    relativePath?: string,
  ): void {
    const limit = this.resolve(resourceType).maxFileSize();
    if (filesize > limit) {
      throw new BadRequestException(
        `${relativePath ? `"${relativePath}" is` : 'The file is'} ${filesize} bytes — the limit for a ${resourceType} upload is ${describeBytes(limit)}`,
      );
    }
  }

  /**
   * Confirms the caller is allowed to upload this resource type — throws
   * rather than returning a boolean since every caller needs the same
   * reaction (403) on failure.
   *
   * This is the ONLY authorization gate on MultipartUploadController (its
   * routes carry no @RequirePermissions because the permission depends on the
   * request's resourceType), so it resolves the caller's live permission set
   * through PermissionResolverService exactly like PermissionsGuard does.
   */
  async assertPermission(
    resourceType: string,
    user: PermissionSubject,
  ): Promise<void> {
    const type = this.resolve(resourceType);
    if (!(await this.permissionResolver.can(user, type.permission))) {
      throw new ForbiddenException(
        'You do not have permission to upload this resource type',
      );
    }
  }
}
