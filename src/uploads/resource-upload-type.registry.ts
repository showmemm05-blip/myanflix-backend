import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { basename } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import type { Permission } from '../roles/permission-catalogue';
import {
  PermissionResolverService,
  type PermissionSubject,
} from '../roles/permission-resolver.service';

/**
 * The relativePath prefix that marks a bundle file as a subtitle SOURCE
 * rather than a video asset. Exported because UploadsService recognises the
 * same prefix when it parses a bundle's structure — the folder name and the
 * routing rule below must always mean the same thing.
 */
export const SUBTITLE_RELATIVE_PREFIX = 'subtitles/';

export interface ResourceUploadType {
  permission: Permission;
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
        assertExists: async (resourceId) => {
          const movie = await this.prisma.movie.findUnique({
            where: { id: resourceId },
            select: { id: true },
          });
          if (!movie) throw new NotFoundException('Movie not found');
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
      book: {
        // BOOKS.EDIT rather than MEDIA.UPLOAD: whoever may edit a book may
        // attach its PDF, and the books module has no other reason to grant
        // the movie-pipeline's upload permission.
        permission: 'BOOKS.EDIT',
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
    };
  }

  resolve(resourceType: string): ResourceUploadType {
    const type = this.types[resourceType];
    if (!type)
      throw new NotFoundException(`Unknown resourceType "${resourceType}"`);
    return type;
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
