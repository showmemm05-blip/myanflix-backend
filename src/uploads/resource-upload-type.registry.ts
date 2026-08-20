import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Permission } from '../roles/permission-catalogue';
import {
  PermissionResolverService,
  type PermissionSubject,
} from '../roles/permission-resolver.service';

export interface ResourceUploadType {
  permission: Permission;
  /** Confirms the owning row actually exists before a multipart session/presigned URL is issued against it. */
  assertExists(resourceId: string): Promise<void>;
  /** Full MinIO object key for a file inside this resource's bundle — same convention the existing external-flow upload already produces (`videos/<movieId>/<relativePath>`), so streaming/finalization needs no changes regardless of which upload path wrote the object. */
  buildKey(resourceId: string, relativePath: string): string;
}

/**
 * The one place that knows how to turn a generic `resourceType` string (see
 * MultipartUploadSession's schema doc comment) into something concrete —
 * ownership validation and an object key. Adding a future resource type
 * (e.g. "book") is one new entry here; nothing in MultipartUploadService,
 * MinioService, or the frontend upload primitives needs to change.
 *
 * "movie" is the only entry today — it also serves series episodes, which
 * are just Movie rows with seriesId set (see schema.prisma's Movie doc
 * comment), so no separate "episode" type is needed.
 */
@Injectable()
export class ResourceUploadTypeRegistry {
  private readonly types: Record<string, ResourceUploadType>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolverService,
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
        buildKey: (resourceId, relativePath) =>
          `videos/${resourceId}/${relativePath}`,
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
