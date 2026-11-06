import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UploadStatus } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditAction } from '../audit/audit-actions';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AD_RESOURCE_TYPE,
  MOVIE_REPLACE_RESOURCE_TYPE,
  ResourceUploadTypeRegistry,
} from './resource-upload-type.registry';
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

// How many of a presign batch's relativePaths the audit row keeps. A bundle
// batch can be 500 segments; the count is always recorded, the first few
// names are enough to tell what was being written.
const AUDIT_PATH_SAMPLE = 20;

type UploadedPart = { partNumber: number; etag: string; size: number };

/**
 * Which audit action a storage-writing step files under, by resource type.
 * A replacement bundle is still an act on the MOVIE (it stages for that
 * title), so "movie-replace" records under the movie's own labels with
 * metadata.resourceType telling the two apart.
 */
function auditActionFor(
  resourceType: string,
  step: 'presign' | 'multipart',
): {
  action: AuditAction;
  targetType: 'movie' | 'book' | 'advertisement';
} {
  const family =
    resourceType === 'movie' || resourceType === MOVIE_REPLACE_RESOURCE_TYPE
      ? 'movie'
      : resourceType === AD_RESOURCE_TYPE
        ? 'advertisement'
        : 'book';
  return {
    action: `${family}.upload_${step}` as AuditAction,
    targetType: family,
  };
}

/** The exact byte length one part of a session must have: the part size, or the remainder for the last part. */
export function expectedPartSize(
  session: { fileSize: bigint | number; partSize: number; totalParts: number },
  partNumber: number,
): number {
  const fileSize = Number(session.fileSize);
  if (partNumber < session.totalParts) return session.partSize;
  return fileSize - (session.totalParts - 1) * session.partSize;
}

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
    private readonly audit: AuditService,
  ) {}

  /**
   * Small files (playlists, subtitles, segments) — one presigned PUT each,
   * no session row. Each file's declared size is checked against the
   * type's budget and then SIGNED into its URL, so the PUT can only ever
   * carry exactly that many bytes (M-23). One audit row per batch (M-22).
   */
  async presignBatch(user: AuthenticatedUser, dto: PresignBatchDto) {
    await this.resourceTypes.assertPermission(dto.resourceType, user);
    const type = this.resourceTypes.resolve(dto.resourceType);
    await type.assertExists(dto.resourceId);
    for (const file of dto.files) {
      this.resourceTypes.assertFileSizeAllowed(
        dto.resourceType,
        file.filesize,
        file.relativePath,
      );
    }

    const files = await Promise.all(
      dto.files.map(async (file) => {
        const key = type.buildKey(dto.resourceId, file.relativePath);
        const url = await this.minioService.getPresignedPutUrl(
          key,
          file.filesize,
        );
        return { relativePath: file.relativePath, key, url };
      }),
    );

    const { action, targetType } = auditActionFor(dto.resourceType, 'presign');
    await this.audit.record({
      action,
      actor: user,
      target: { type: targetType, id: dto.resourceId, label: null },
      metadata: {
        resourceType: dto.resourceType,
        fileCount: dto.files.length,
        totalBytes: dto.files.reduce((sum, f) => sum + f.filesize, 0),
        relativePaths: dto.files
          .slice(0, AUDIT_PATH_SAMPLE)
          .map((f) => f.relativePath),
      },
    });
    return { files };
  }

  /**
   * Resumable the same way the classic flow's initUpload() is: an
   * in-progress session for the exact same resource/key/size means the
   * client is re-attempting an upload that never finished, not starting a
   * new one — reuse it and hand back what MinIO already has.
   */
  async initMultipart(user: AuthenticatedUser, dto: MultipartInitDto) {
    await this.resourceTypes.assertPermission(dto.resourceType, user);
    const type = this.resourceTypes.resolve(dto.resourceType);
    await type.assertExists(dto.resourceId);
    this.resourceTypes.assertFileSizeAllowed(
      dto.resourceType,
      dto.filesize,
      dto.relativePath,
    );

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

    await this.recordMultipart(user, 'init', {
      id: session.id,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      objectKey: key,
      fileSize: BigInt(dto.filesize),
      totalParts,
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
    user: AuthenticatedUser,
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
        // The part's length is signed into its URL: a part can only be as
        // long as the session says, so the object can never grow past the
        // filesize declared at init (M-23).
        const url = await this.minioService.getPresignedUploadPartUrl(
          session.objectKey,
          session.minioUploadId,
          partNumber,
          expectedPartSize(session, partNumber),
        );
        return { partNumber, url };
      }),
    );
    return { parts };
  }

  async completeMultipart(
    user: AuthenticatedUser,
    sessionId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const session = await this.getActiveSessionOrThrow(sessionId);
    await this.resourceTypes.assertPermission(session.resourceType, user);
    // The state gate again, at the moment the object would actually be
    // assembled (M-22): a session lives up to 48 h, and a title that was
    // UPLOADING at init can have been finalized or published since. The
    // same 409 as init; the parts stay in MinIO for the abort route or the
    // daily sweep to clear, exactly like any other session never completed.
    await this.resourceTypes
      .resolve(session.resourceType)
      .assertExists(session.resourceId);

    if (parts.length !== session.totalParts) {
      throw new BadRequestException(
        `Expected ${session.totalParts} parts, received ${parts.length}`,
      );
    }

    // What MinIO actually holds must add up to the size declared at init —
    // the count check above says nothing about bytes (M-23). A mismatch
    // means the browser sent a different file than it announced; the
    // upload is thrown away rather than assembled into the wrong object.
    const received = await this.minioService.listUploadedParts(
      session.objectKey,
      session.minioUploadId,
    );
    const receivedBytes = received.reduce((sum, part) => sum + part.size, 0);
    if (receivedBytes !== Number(session.fileSize)) {
      await this.minioService.abortMultipartUpload(
        session.objectKey,
        session.minioUploadId,
      );
      await this.markFailed(sessionId);
      throw new BadRequestException(
        `Uploaded ${receivedBytes} bytes but the session was opened for ${Number(session.fileSize)} — the upload was discarded, start it again`,
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
    await this.recordMultipart(user, 'complete', session);

    return { relativePath: session.objectKey, status: UploadStatus.COMPLETED };
  }

  async abortMultipart(user: AuthenticatedUser, sessionId: string) {
    const session = await this.getSessionOrThrow(sessionId);
    await this.resourceTypes.assertPermission(session.resourceType, user);

    await this.minioService.abortMultipartUpload(
      session.objectKey,
      session.minioUploadId,
    );
    await this.markFailed(sessionId);
    await this.recordMultipart(user, 'abort', session);
  }

  /** One audit row per multipart lifecycle step — who touched which key of which title (M-22). */
  private async recordMultipart(
    user: AuthenticatedUser,
    phase: 'init' | 'complete' | 'abort',
    session: {
      id: string;
      resourceType: string;
      resourceId: string;
      objectKey: string;
      fileSize: bigint | number;
      totalParts: number;
    },
  ): Promise<void> {
    const { action, targetType } = auditActionFor(
      session.resourceType,
      'multipart',
    );
    await this.audit.record({
      action,
      actor: user,
      target: { type: targetType, id: session.resourceId, label: null },
      metadata: {
        phase,
        resourceType: session.resourceType,
        sessionId: session.id,
        key: session.objectKey,
        fileSize: Number(session.fileSize),
        totalParts: session.totalParts,
      },
    });
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
