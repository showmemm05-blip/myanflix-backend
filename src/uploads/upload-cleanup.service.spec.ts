import { Test, TestingModule } from '@nestjs/testing';
import { readdir, rm, stat } from 'node:fs/promises';
import { UploadCleanupService } from './upload-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { UploadStatus, VideoStatus } from '../generated/prisma/client';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  readdir: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
}));

const readdirMock = readdir as jest.Mock;
const rmMock = rm as jest.Mock;
const statMock = stat as jest.Mock;

const HOURS = 60 * 60 * 1000;

describe('UploadCleanupService', () => {
  let service: UploadCleanupService;
  let prisma: {
    multipartUploadSession: { findMany: jest.Mock; update: jest.Mock };
    uploadSession: { findMany: jest.Mock };
    video: { findMany: jest.Mock };
  };
  let minioService: {
    abortMultipartUpload: jest.Mock;
    listInProgressMultipartUploads: jest.Mock;
  };
  let storageService: { scratchRoot: string };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      multipartUploadSession: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      uploadSession: { findMany: jest.fn().mockResolvedValue([]) },
      video: { findMany: jest.fn().mockResolvedValue([]) },
    };
    minioService = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listInProgressMultipartUploads: jest.fn().mockResolvedValue([]),
    };
    storageService = { scratchRoot: '/storage/temp' };
    // Every scratch root is empty unless a case says otherwise.
    readdirMock.mockResolvedValue([]);
    rmMock.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadCleanupService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: StorageService, useValue: storageService },
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

  describe('sweepStaleLocalScratch', () => {
    /** Makes exactly one scratch root non-empty; every other root stays empty. */
    const onlyRootHas = (rootPath: string, entries: string[]) =>
      readdirMock.mockImplementation(async (path: string) =>
        path === rootPath ? entries : [],
      );

    it('removes a scratch directory whose run stopped touching it a day ago', async () => {
      onlyRootHas('/storage/temp/uploads', ['session-dead']);
      statMock.mockResolvedValue({ mtimeMs: Date.now() - 30 * HOURS });

      await service.sweepStaleLocalScratch();

      expect(rmMock).toHaveBeenCalledWith(
        '/storage/temp/uploads/session-dead',
        {
          recursive: true,
          force: true,
        },
      );
    });

    it('leaves a directory that was written to within the window — it belongs to a live run', async () => {
      onlyRootHas('/storage/temp/uploads', ['session-busy']);
      statMock.mockResolvedValue({ mtimeMs: Date.now() - 2 * HOURS });

      await service.sweepStaleLocalScratch();

      expect(rmMock).not.toHaveBeenCalled();
    });

    it(
      'never deletes the chunks of an upload session the client could still resume, however long ' +
        'it has been idle',
      async () => {
        onlyRootHas('/storage/temp/uploads', ['session-resumable']);
        statMock.mockResolvedValue({ mtimeMs: Date.now() - 30 * HOURS });
        prisma.uploadSession.findMany.mockResolvedValue([
          { id: 'session-resumable' },
        ]);

        await service.sweepStaleLocalScratch();

        expect(rmMock).not.toHaveBeenCalled();
        expect(prisma.uploadSession.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: UploadStatus.IN_PROGRESS,
              updatedAt: expect.objectContaining({ gte: expect.any(Date) }),
            }),
          }),
        );
      },
    );

    it(
      "never deletes a transcode's working directory while its Video is PROCESSING — ffmpeg writes " +
        'into a subdirectory, so the directory mtime alone would call a long run abandoned',
      async () => {
        onlyRootHas('/storage/temp/videos', ['movie-1']);
        statMock.mockResolvedValue({ mtimeMs: Date.now() - 30 * HOURS });
        prisma.video.findMany.mockResolvedValue([{ movieId: 'movie-1' }]);

        await service.sweepStaleLocalScratch();

        expect(rmMock).not.toHaveBeenCalled();
        expect(prisma.video.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { status: VideoStatus.PROCESSING },
          }),
        );
      },
    );

    it('walks only the scratch roots the media taxonomy declares, all of them under <STORAGE_PATH>/temp', async () => {
      await service.sweepStaleLocalScratch();

      const walked = readdirMock.mock.calls.map(([path]) => path as string);
      expect(walked).toEqual([
        '/storage/temp/uploads',
        '/storage/temp/videos',
        '/storage/temp/audio',
        '/storage/temp/documents/books',
      ]);
    });

    it('skips a root no feature has written yet instead of failing the whole sweep', async () => {
      readdirMock.mockImplementation(async (path: string) => {
        if (path === '/storage/temp/audio') throw new Error('ENOENT');
        return path === '/storage/temp/videos' ? ['movie-old'] : [];
      });
      statMock.mockResolvedValue({ mtimeMs: Date.now() - 30 * HOURS });

      await service.sweepStaleLocalScratch();

      expect(rmMock).toHaveBeenCalledWith('/storage/temp/videos/movie-old', {
        recursive: true,
        force: true,
      });
    });
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
