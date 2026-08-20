import { Test, TestingModule } from '@nestjs/testing';
import { UploadCleanupService } from './upload-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { UploadStatus } from '../generated/prisma/client';

describe('UploadCleanupService', () => {
  let service: UploadCleanupService;
  let prisma: {
    multipartUploadSession: { findMany: jest.Mock; update: jest.Mock };
  };
  let minioService: {
    abortMultipartUpload: jest.Mock;
    listInProgressMultipartUploads: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      multipartUploadSession: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };
    minioService = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listInProgressMultipartUploads: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadCleanupService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(UploadCleanupService);
  });

  it('aborts and fails every stale IN_PROGRESS session row it finds', async () => {
    prisma.multipartUploadSession.findMany.mockResolvedValueOnce([
      {
        id: 'session-1',
        objectKey: 'videos/movie-1/original.mp4',
        minioUploadId: 'minio-1',
      },
      {
        id: 'session-2',
        objectKey: 'videos/movie-2/original.mp4',
        minioUploadId: 'minio-2',
      },
    ]);

    await service.sweepAbandonedMultipartUploads();

    expect(minioService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/movie-1/original.mp4',
      'minio-1',
    );
    expect(minioService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/movie-2/original.mp4',
      'minio-2',
    );
    expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { status: UploadStatus.FAILED },
    });
    expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
      where: { id: 'session-2' },
      data: { status: UploadStatus.FAILED },
    });
  });

  it(
    'queries stale rows with an updatedAt cutoff, not an unbounded scan — a fast-moving in-progress ' +
      'upload must never be swept mid-flight',
    async () => {
      await service.sweepAbandonedMultipartUploads();

      expect(prisma.multipartUploadSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: UploadStatus.IN_PROGRESS,
            updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
        }),
      );
    },
  );

  it('aborts a MinIO-side upload with no matching session row at all (the crash-before-insert case)', async () => {
    const staleInitiated = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago
    minioService.listInProgressMultipartUploads.mockResolvedValue([
      {
        key: 'videos/movie-3/original.mp4',
        uploadId: 'orphan-1',
        initiated: staleInitiated,
      },
    ]);
    prisma.multipartUploadSession.findMany
      .mockResolvedValueOnce([]) // sweepStaleSessionRows: no stale rows
      .mockResolvedValueOnce([]); // sweepOrphanedMinioUploads: no row matches orphan-1

    await service.sweepAbandonedMultipartUploads();

    expect(minioService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/movie-3/original.mp4',
      'orphan-1',
    );
  });

  it('leaves a MinIO-side upload alone when a live session row already accounts for it', async () => {
    const staleInitiated = new Date(Date.now() - 72 * 60 * 60 * 1000);
    minioService.listInProgressMultipartUploads.mockResolvedValue([
      {
        key: 'videos/movie-4/original.mp4',
        uploadId: 'known-1',
        initiated: staleInitiated,
      },
    ]);
    prisma.multipartUploadSession.findMany
      .mockResolvedValueOnce([]) // no stale rows to sweep
      .mockResolvedValueOnce([{ minioUploadId: 'known-1' }]); // a row already tracks this upload

    await service.sweepAbandonedMultipartUploads();

    expect(minioService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('leaves a recently-initiated orphan alone — it may just be mid-flight, not abandoned yet', async () => {
    minioService.listInProgressMultipartUploads.mockResolvedValue([
      {
        key: 'videos/movie-5/original.mp4',
        uploadId: 'fresh-orphan',
        initiated: new Date(),
      },
    ]);
    prisma.multipartUploadSession.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.sweepAbandonedMultipartUploads();

    expect(minioService.abortMultipartUpload).not.toHaveBeenCalled();
  });
});
