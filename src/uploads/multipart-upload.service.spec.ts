import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  MultipartUploadService,
  MULTIPART_PART_SIZE,
} from './multipart-upload.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import { UploadStatus } from '../generated/prisma/client';

describe('MultipartUploadService', () => {
  let service: MultipartUploadService;
  let prisma: {
    multipartUploadSession: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let minioService: {
    getPresignedPutUrl: jest.Mock;
    createMultipartUpload: jest.Mock;
    getPresignedUploadPartUrl: jest.Mock;
    listUploadedParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let resourceTypes: { assertPermission: jest.Mock; resolve: jest.Mock };
  let movieType: { assertExists: jest.Mock; buildKey: jest.Mock };

  const role = 'ADMIN' as never;

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      multipartUploadSession: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    minioService = {
      getPresignedPutUrl: jest
        .fn()
        .mockResolvedValue('https://minio.example/presigned-put'),
      createMultipartUpload: jest.fn().mockResolvedValue('minio-upload-1'),
      getPresignedUploadPartUrl: jest
        .fn()
        .mockResolvedValue('https://minio.example/presigned-part'),
      listUploadedParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    movieType = {
      assertExists: jest.fn().mockResolvedValue(undefined),
      buildKey: jest.fn(
        (resourceId: string, relativePath: string) =>
          `videos/${resourceId}/${relativePath}`,
      ),
    };
    resourceTypes = {
      assertPermission: jest.fn(),
      resolve: jest.fn().mockReturnValue(movieType),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultipartUploadService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: ResourceUploadTypeRegistry, useValue: resourceTypes },
      ],
    }).compile();

    service = module.get(MultipartUploadService);
  });

  describe('presignBatch', () => {
    const dto = {
      resourceType: 'movie',
      resourceId: 'movie-1',
      files: [
        { relativePath: 'hls/master.m3u8', filesize: 500 },
        { relativePath: 'subtitles/english.vtt', filesize: 1000 },
      ],
    };

    it('checks permission and resource existence before issuing any URL', async () => {
      await service.presignBatch(role, dto);

      expect(resourceTypes.assertPermission).toHaveBeenCalledWith(
        'movie',
        role,
      );
      expect(movieType.assertExists).toHaveBeenCalledWith('movie-1');
    });

    it("returns one presigned PUT URL per file, keyed via the resource type's buildKey", async () => {
      const result = await service.presignBatch(role, dto);

      expect(minioService.getPresignedPutUrl).toHaveBeenCalledWith(
        'videos/movie-1/hls/master.m3u8',
      );
      expect(minioService.getPresignedPutUrl).toHaveBeenCalledWith(
        'videos/movie-1/subtitles/english.vtt',
      );
      expect(result.files).toEqual([
        {
          relativePath: 'hls/master.m3u8',
          key: 'videos/movie-1/hls/master.m3u8',
          url: 'https://minio.example/presigned-put',
        },
        {
          relativePath: 'subtitles/english.vtt',
          key: 'videos/movie-1/subtitles/english.vtt',
          url: 'https://minio.example/presigned-put',
        },
      ]);
    });

    it('never creates a MultipartUploadSession row — small files have no server-side session', async () => {
      await service.presignBatch(role, dto);

      expect(prisma.multipartUploadSession.create).not.toHaveBeenCalled();
    });
  });

  describe('initMultipart', () => {
    const dto = {
      resourceType: 'movie',
      resourceId: 'movie-1',
      filename: 'original.mp4',
      filesize: 100_000_000,
      relativePath: 'original.mp4',
    };

    it('creates a fresh session and starts a MinIO multipart upload when none exists', async () => {
      prisma.multipartUploadSession.findFirst.mockResolvedValue(null);
      prisma.multipartUploadSession.create.mockResolvedValue({
        id: 'session-1',
      });

      const result = await service.initMultipart(role, dto);

      expect(minioService.createMultipartUpload).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
      );
      expect(prisma.multipartUploadSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resourceType: 'movie',
            resourceId: 'movie-1',
            objectKey: 'videos/movie-1/original.mp4',
            fileSize: BigInt(dto.filesize),
            partSize: MULTIPART_PART_SIZE,
            totalParts: Math.ceil(dto.filesize / MULTIPART_PART_SIZE),
            minioUploadId: 'minio-upload-1',
            status: UploadStatus.IN_PROGRESS,
          }),
        }),
      );
      expect(result).toEqual({
        sessionId: 'session-1',
        key: 'videos/movie-1/original.mp4',
        partSize: MULTIPART_PART_SIZE,
        totalParts: Math.ceil(dto.filesize / MULTIPART_PART_SIZE),
        uploadedParts: [],
      });
    });

    it(
      "resumes an existing in-progress session, returning MinIO's own ListPartsCommand result " +
        'rather than anything stored in Postgres',
      async () => {
        prisma.multipartUploadSession.findFirst.mockResolvedValue({
          id: 'session-existing',
          objectKey: 'videos/movie-1/original.mp4',
          minioUploadId: 'minio-upload-existing',
          partSize: MULTIPART_PART_SIZE,
          totalParts: 4,
        });
        minioService.listUploadedParts.mockResolvedValue([
          { partNumber: 1, etag: 'etag-1', size: MULTIPART_PART_SIZE },
          { partNumber: 2, etag: 'etag-2', size: MULTIPART_PART_SIZE },
        ]);

        const result = await service.initMultipart(role, dto);

        expect(minioService.createMultipartUpload).not.toHaveBeenCalled();
        expect(minioService.listUploadedParts).toHaveBeenCalledWith(
          'videos/movie-1/original.mp4',
          'minio-upload-existing',
        );
        expect(result).toEqual({
          sessionId: 'session-existing',
          key: 'videos/movie-1/original.mp4',
          partSize: MULTIPART_PART_SIZE,
          totalParts: 4,
          uploadedParts: [
            { partNumber: 1, etag: 'etag-1', size: MULTIPART_PART_SIZE },
            { partNumber: 2, etag: 'etag-2', size: MULTIPART_PART_SIZE },
          ],
        });
      },
    );

    it(
      'fails the stale row and starts a genuinely new upload when MinIO reports the resumed ' +
        'UploadId no longer exists (e.g. lifecycle-expired)',
      async () => {
        prisma.multipartUploadSession.findFirst.mockResolvedValue({
          id: 'session-stale',
          objectKey: 'videos/movie-1/original.mp4',
          minioUploadId: 'minio-upload-gone',
          partSize: MULTIPART_PART_SIZE,
          totalParts: 4,
        });
        minioService.listUploadedParts.mockRejectedValue(
          Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
        );
        prisma.multipartUploadSession.create.mockResolvedValue({
          id: 'session-fresh',
        });

        const result = await service.initMultipart(role, dto);

        expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
          where: { id: 'session-stale' },
          data: { status: UploadStatus.FAILED },
        });
        expect(minioService.createMultipartUpload).toHaveBeenCalled();
        expect(result.sessionId).toBe('session-fresh');
      },
    );
  });

  describe('getPartUrls', () => {
    it("rejects a partNumber outside the session's known range", async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue({
        id: 'session-1',
        status: UploadStatus.IN_PROGRESS,
        resourceType: 'movie',
        objectKey: 'videos/movie-1/original.mp4',
        minioUploadId: 'minio-upload-1',
        totalParts: 3,
      });

      await expect(service.getPartUrls(role, 'session-1', [4])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('returns one presigned URL per requested part number', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue({
        id: 'session-1',
        status: UploadStatus.IN_PROGRESS,
        resourceType: 'movie',
        objectKey: 'videos/movie-1/original.mp4',
        minioUploadId: 'minio-upload-1',
        totalParts: 3,
      });

      const result = await service.getPartUrls(role, 'session-1', [1, 2]);

      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://minio.example/presigned-part' },
        { partNumber: 2, url: 'https://minio.example/presigned-part' },
      ]);
    });
  });

  describe('completeMultipart', () => {
    const session = {
      id: 'session-1',
      status: UploadStatus.IN_PROGRESS,
      resourceType: 'movie',
      objectKey: 'videos/movie-1/original.mp4',
      minioUploadId: 'minio-upload-1',
      totalParts: 2,
    };

    it('rejects when the part count does not match totalParts', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);

      await expect(
        service.completeMultipart(role, 'session-1', [
          { partNumber: 1, etag: 'etag-1' },
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('finalizes via MinIO and marks the session COMPLETED — no local temp file, no merge', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);
      const parts = [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ];

      const result = await service.completeMultipart(role, 'session-1', parts);

      expect(minioService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        'minio-upload-1',
        parts,
      );
      expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: UploadStatus.COMPLETED },
      });
      expect(result).toEqual({
        relativePath: 'videos/movie-1/original.mp4',
        status: UploadStatus.COMPLETED,
      });
    });
  });

  describe('abortMultipart', () => {
    it('aborts on MinIO and marks the session FAILED', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue({
        id: 'session-1',
        resourceType: 'movie',
        objectKey: 'videos/movie-1/original.mp4',
        minioUploadId: 'minio-upload-1',
      });

      await service.abortMultipart(role, 'session-1');

      expect(minioService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        'minio-upload-1',
      );
      expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: UploadStatus.FAILED },
      });
    });
  });
});
