import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UploadStatus } from '../generated/prisma/client';
import type { PermissionSubject } from '../roles/permission-resolver.service';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import type { MultipartInitDto } from './dto/multipart-init.dto';
import type { PresignBatchDto } from './dto/presign-batch.dto';

// Re-evaluated specifically for this flow's 10-50GB target files and the
// 10-50 Mbps / 100-300ms network conditions it needs to work under —
// deliberately NOT reused from MinioService's UPLOAD_PART_SIZE, which is
// tuned for a different constraint (the backend's own memory ceiling while
// server-side-streaming a file it already has locally). Returned to the
// caller by initMultipart() the same way the classic flow already returns
// chunkSize — never hardcoded a second time on the frontend.
export const MULTIPART_PART_SIZE = 32 * 1024 * 1024; // 32MB

// A stale IN_PROGRESS session past this age is treated as abandoned by both
// the lazy per-key check below and UploadCleanupService's daily sweep.
export const ABANDONED_SESSION_AGE_MS = 48 * 60 * 60 * 1000; // 48h

type UploadedPart = { partNumber: number; etag: string; size: number };

/**
 * Direct browser->MinIO multipart upload — the resource-generic
 * counterpart to UploadsService's chunked-upload-to-local-disk flow. Never
 * touches local disk: parts land straight in MinIO via presigned URLs, and
 * MinIO's own ListPartsCommand is always the source of truth for what's
 * been received (see MultipartUploadSession's schema doc comment) — this
 * service only ever writes two rows per large file (create, complete).
 */
@Injectable()
export class MultipartUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly resourceTypes: ResourceUploadTypeRegistry,
  ) {}

  /** Small files (playlists, subtitles, segments) — one presigned PUT each, no session row. */
  async presignBatch(user: PermissionSubject, dto: PresignBatchDto) {
    await this.resourceTypes.assertPermission(dto.resourceType, user);
    const type = this.resourceTypes.resolve(dto.resourceType);
    await type.assertExists(dto.resourceId);

    const files = await Promise.all(
      dto.files.map(async (file) => {
        const key = type.buildKey(dto.resourceId, file.relativePath);
        const url = await this.minioService.getPresignedPutUrl(key);
        return { relativePath: file.relativePath, key, url };
      }),
    );
    return { files };
  }

  /**
   * Resumable the same way the classic flow's initUpload() is: an
   * in-progress session for the exact same resource/key/size means the
   * client is re-attempting an upload that never finished, not starting a
   * new one — reuse it and hand back what MinIO already has.
   */
  async initMultipart(user: PermissionSubject, dto: MultipartInitDto) {
    await this.resourceTypes.assertPermission(dto.resourceType, user);
    const type = this.resourceTypes.resolve(dto.resourceType);
    await type.assertExists(dto.resourceId);

    const key = type.buildKey(dto.resourceId, dto.relativePath);

    const existing = await this.prisma.multipartUploadSession.findFirst({
      where: {
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        objectKey: key,
        fileSize: BigInt(dto.filesize),
        status: UploadStatus.IN_PROGRESS,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      const uploadedParts = await this.listUploadedPartsIfLive(
        existing.objectKey,
        existing.minioUploadId,
      );
      if (uploadedParts) {
        return {
          sessionId: existing.id,
          key: existing.objectKey,
          partSize: existing.partSize,
          totalParts: existing.totalParts,
          uploadedParts,
        };
      }
      // MinIO no longer has this upload (e.g. lifecycle-expired) — the row
      // is stale; fail it and fall through to start a fresh one.
      await this.markFailed(existing.id);
    }

    // Defense-in-depth against two live sessions piling up for the same key
    // between UploadCleanupService's daily runs.
    await this.abortStaleSessionsForKey(dto.resourceType, dto.resourceId, key);

    const totalParts = Math.ceil(dto.filesize / MULTIPART_PART_SIZE);
    const minioUploadId = await this.minioService.createMultipartUpload(key);

    const session = await this.prisma.multipartUploadSession.create({
      data: {
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        objectKey: key,
        fileSize: BigInt(dto.filesize),
        partSize: MULTIPART_PART_SIZE,
        totalParts,
        minioUploadId,
        status: UploadStatus.IN_PROGRESS,
      },
    });

    return {
      sessionId: session.id,
      key,
      partSize: MULTIPART_PART_SIZE,
      totalParts,
      uploadedParts: [] as UploadedPart[],
    };
  }

  async getPartUrls(
    user: PermissionSubject,
    sessionId: string,
    partNumbers: number[],
  ) {
    const session = await this.getActiveSessionOrThrow(sessionId);
    await this.resourceTypes.assertPermission(session.resourceType, user);

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        if (partNumber < 1 || partNumber > session.totalParts) {
          throw new BadRequestException(
            `partNumber must be between 1 and ${session.totalParts}`,
          );
        }
        const url = await this.minioService.getPresignedUploadPartUrl(
          session.objectKey,
          session.minioUploadId,
          partNumber,
        );
        return { partNumber, url };
      }),
    );
    return { parts };
  }

  async completeMultipart(
    user: PermissionSubject,
    sessionId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const session = await this.getActiveSessionOrThrow(sessionId);
    await this.resourceTypes.assertPermission(session.resourceType, user);

    if (parts.length !== session.totalParts) {
      throw new BadRequestException(
        `Expected ${session.totalParts} parts, received ${parts.length}`,
      );
    }

    await this.minioService.completeMultipartUpload(
      session.objectKey,
      session.minioUploadId,
      parts,
    );
    await this.prisma.multipartUploadSession.update({
      where: { id: sessionId },
      data: { status: UploadStatus.COMPLETED },
    });

    return { relativePath: session.objectKey, status: UploadStatus.COMPLETED };
  }

  async abortMultipart(user: PermissionSubject, sessionId: string) {
    const session = await this.getSessionOrThrow(sessionId);
    await this.resourceTypes.assertPermission(session.resourceType, user);

    await this.minioService.abortMultipartUpload(
      session.objectKey,
      session.minioUploadId,
    );
    await this.markFailed(sessionId);
  }

  /** Returns MinIO's current part list, or null if MinIO says this upload no longer exists (lifecycle-expired, previously aborted). */
  private async listUploadedPartsIfLive(
    key: string,
    minioUploadId: string,
  ): Promise<UploadedPart[] | null> {
    try {
      return await this.minioService.listUploadedParts(key, minioUploadId);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name.includes('NoSuchUpload')) return null;
      throw error;
    }
  }

  private async abortStaleSessionsForKey(
    resourceType: string,
    resourceId: string,
    objectKey: string,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - ABANDONED_SESSION_AGE_MS);
    const stale = await this.prisma.multipartUploadSession.findMany({
      where: {
        resourceType,
        resourceId,
        objectKey,
        status: UploadStatus.IN_PROGRESS,
        updatedAt: { lt: cutoff },
      },
    });
    for (const session of stale) {
      await this.minioService.abortMultipartUpload(
        session.objectKey,
        session.minioUploadId,
      );
      await this.markFailed(session.id);
    }
  }

  private async markFailed(sessionId: string): Promise<void> {
    await this.prisma.multipartUploadSession.update({
      where: { id: sessionId },
      data: { status: UploadStatus.FAILED },
    });
  }

  private async getSessionOrThrow(sessionId: string) {
    const session = await this.prisma.multipartUploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('Upload session not found');
    return session;
  }

  private async getActiveSessionOrThrow(sessionId: string) {
    const session = await this.getSessionOrThrow(sessionId);
    if (session.status !== UploadStatus.IN_PROGRESS) {
      throw new BadRequestException('This upload session is no longer active');
    }
    return session;
  }
}
