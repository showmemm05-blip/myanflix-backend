import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  MultipartUploadService,
  MULTIPART_PART_SIZE,
  expectedPartSize,
} from './multipart-upload.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { AuditService } from '../audit/audit.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import { Role, UploadStatus } from '../generated/prisma/client';

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
  let resourceTypes: {
    assertPermission: jest.Mock;
    resolve: jest.Mock;
    assertFileSizeAllowed: jest.Mock;
  };
  let movieType: { assertExists: jest.Mock; buildKey: jest.Mock };
  let audit: { record: jest.Mock };

  /** The staff member on the request — every storage-writing step records them (M-22). */
  const role = {
    id: 'admin-1',
    username: 'boss',
    role: Role.ADMIN,
    appRoleId: null,
  };

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
      // Mirrors the real ResourceUploadTypeRegistry routing (asserted for
      // real in resource-upload-type.registry.spec.ts): a subtitle SOURCE
      // leaves the video namespace, everything else stays in it.
      buildKey: jest.fn((resourceId: string, relativePath: string) =>
        relativePath.startsWith('subtitles/')
          ? `subtitles/${resourceId}/${relativePath.slice('subtitles/'.length)}`
          : `videos/${resourceId}/${relativePath}`,
      ),
    };
    resourceTypes = {
      assertPermission: jest.fn(),
      resolve: jest.fn().mockReturnValue(movieType),
      // The real cap is proven in resource-upload-type.registry.spec.ts;
      // here it only matters that every route asks, before it signs.
      assertFileSizeAllowed: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MultipartUploadService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: ResourceUploadTypeRegistry, useValue: resourceTypes },
        { provide: AuditService, useValue: audit },
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
        500,
      );
      expect(minioService.getPresignedPutUrl).toHaveBeenCalledWith(
        'subtitles/movie-1/english.vtt',
        1000,
      );
      expect(result.files).toEqual([
        {
          relativePath: 'hls/master.m3u8',
          key: 'videos/movie-1/hls/master.m3u8',
          url: 'https://minio.example/presigned-put',
        },
        {
          relativePath: 'subtitles/english.vtt',
          key: 'subtitles/movie-1/english.vtt',
          url: 'https://minio.example/presigned-put',
        },
      ]);
    });

    it('never creates a MultipartUploadSession row — small files have no server-side session', async () => {
      await service.presignBatch(role, dto);

      expect(prisma.multipartUploadSession.create).not.toHaveBeenCalled();
    });

    it("checks every file's declared size against the type's budget before signing anything (M-23)", async () => {
      resourceTypes.assertFileSizeAllowed.mockImplementation(
        (_type: string, size: number) => {
          if (size > 600) throw new BadRequestException('too big');
        },
      );

      await expect(service.presignBatch(role, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(resourceTypes.assertFileSizeAllowed).toHaveBeenCalledWith(
        'movie',
        500,
        'hls/master.m3u8',
      );
      expect(minioService.getPresignedPutUrl).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('signs the declared size into each URL — the PUT can only carry exactly that many bytes (M-23)', async () => {
      await service.presignBatch(role, dto);

      for (const [, length] of minioService.getPresignedPutUrl.mock.calls) {
        expect(typeof length).toBe('number');
      }
    });

    it('records ONE audit row per batch naming the staff member, the title and the files (M-22)', async () => {
      await service.presignBatch(role, dto);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload_presign',
          actor: role,
          target: { type: 'movie', id: 'movie-1', label: null },
          metadata: expect.objectContaining({
            resourceType: 'movie',
            fileCount: 2,
            totalBytes: 1500,
            relativePaths: ['hls/master.m3u8', 'subtitles/english.vtt'],
          }),
        }),
      );
    });

    it('files a replacement bundle under the movie labels too, with the resourceType in metadata', async () => {
      await service.presignBatch(role, {
        ...dto,
        resourceType: 'movie-replace',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload_presign',
          target: expect.objectContaining({ type: 'movie' }),
          metadata: expect.objectContaining({ resourceType: 'movie-replace' }),
        }),
      );
    });

    it('files a book PDF batch under the book labels', async () => {
      await service.presignBatch(role, {
        ...dto,
        resourceType: 'book',
        resourceId: 'book-1',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'book.upload_presign',
          target: { type: 'book', id: 'book-1', label: null },
        }),
      );
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

    it('refuses a file over the type budget before any session or MinIO upload exists (M-23)', async () => {
      resourceTypes.assertFileSizeAllowed.mockImplementation(() => {
        throw new BadRequestException('too big');
      });

      await expect(service.initMultipart(role, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(resourceTypes.assertFileSizeAllowed).toHaveBeenCalledWith(
        'movie',
        dto.filesize,
        'original.mp4',
      );
      expect(minioService.createMultipartUpload).not.toHaveBeenCalled();
      expect(prisma.multipartUploadSession.create).not.toHaveBeenCalled();
    });

    it('records the opened session as a staff act on the title (M-22)', async () => {
      prisma.multipartUploadSession.findFirst.mockResolvedValue(null);
      prisma.multipartUploadSession.create.mockResolvedValue({
        id: 'session-1',
      });

      await service.initMultipart(role, dto);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload_multipart',
          actor: role,
          target: { type: 'movie', id: 'movie-1', label: null },
          metadata: expect.objectContaining({
            phase: 'init',
            sessionId: 'session-1',
            key: 'videos/movie-1/original.mp4',
            fileSize: dto.filesize,
          }),
        }),
      );
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

    it("signs each part's exact length: the part size, and the remainder for the last part (M-23)", async () => {
      const fileSize = 70 * 1024 * 1024;
      prisma.multipartUploadSession.findUnique.mockResolvedValue({
        id: 'session-1',
        status: UploadStatus.IN_PROGRESS,
        resourceType: 'movie',
        objectKey: 'videos/movie-1/original.mp4',
        minioUploadId: 'minio-upload-1',
        fileSize: BigInt(fileSize),
        partSize: MULTIPART_PART_SIZE,
        totalParts: 3,
      });

      await service.getPartUrls(role, 'session-1', [1, 3]);

      expect(minioService.getPresignedUploadPartUrl).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        'minio-upload-1',
        1,
        MULTIPART_PART_SIZE,
      );
      expect(minioService.getPresignedUploadPartUrl).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        'minio-upload-1',
        3,
        fileSize - 2 * MULTIPART_PART_SIZE,
      );
    });
  });

  describe('expectedPartSize', () => {
    it('is the part size for every part but the last, and the remainder for the last', () => {
      const session = { fileSize: 70, partSize: 32, totalParts: 3 };
      expect(expectedPartSize(session, 1)).toBe(32);
      expect(expectedPartSize(session, 2)).toBe(32);
      expect(expectedPartSize(session, 3)).toBe(6);
    });

    it('is the whole file for a single-part session', () => {
      expect(
        expectedPartSize({ fileSize: 10n, partSize: 32, totalParts: 1 }, 1),
      ).toBe(10);
    });
  });

  describe('completeMultipart', () => {
    const fileSize = MULTIPART_PART_SIZE + 1000;
    const session = {
      id: 'session-1',
      status: UploadStatus.IN_PROGRESS,
      resourceType: 'movie',
      resourceId: 'movie-1',
      objectKey: 'videos/movie-1/original.mp4',
      minioUploadId: 'minio-upload-1',
      fileSize: BigInt(fileSize),
      partSize: MULTIPART_PART_SIZE,
      totalParts: 2,
    };
    /** What MinIO holds when the browser sent exactly the file it declared. */
    const receivedExactly = () =>
      minioService.listUploadedParts.mockResolvedValue([
        { partNumber: 1, etag: 'etag-1', size: MULTIPART_PART_SIZE },
        { partNumber: 2, etag: 'etag-2', size: 1000 },
      ]);

    it('rejects when the part count does not match totalParts', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);

      await expect(
        service.completeMultipart(role, 'session-1', [
          { partNumber: 1, etag: 'etag-1' },
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws the upload away when the bytes MinIO holds do not add up to the declared filesize (M-23)', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);
      minioService.listUploadedParts.mockResolvedValue([
        { partNumber: 1, etag: 'etag-1', size: MULTIPART_PART_SIZE },
        { partNumber: 2, etag: 'etag-2', size: 5_000_000 },
      ]);

      await expect(
        service.completeMultipart(role, 'session-1', [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ]),
      ).rejects.toThrow(/Uploaded \d+ bytes but the session was opened for/);
      expect(minioService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(minioService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        'minio-upload-1',
      );
      expect(prisma.multipartUploadSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: UploadStatus.FAILED },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('re-runs the state gate at completion — a title finalized or published since init gets the same 409, and nothing is assembled (M-22)', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);
      receivedExactly();
      movieType.assertExists.mockRejectedValue(
        new ConflictException('PUBLISHED — use movie-replace'),
      );

      await expect(
        service.completeMultipart(role, 'session-1', [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ]),
      ).rejects.toThrow(ConflictException);
      expect(movieType.assertExists).toHaveBeenCalledWith('movie-1');
      expect(minioService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(prisma.multipartUploadSession.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('records the completed session as a staff act on the title (M-22)', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);
      receivedExactly();

      await service.completeMultipart(role, 'session-1', [
        { partNumber: 1, etag: 'etag-1' },
        { partNumber: 2, etag: 'etag-2' },
      ]);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload_multipart',
          actor: role,
          target: { type: 'movie', id: 'movie-1', label: null },
          metadata: expect.objectContaining({
            phase: 'complete',
            key: 'videos/movie-1/original.mp4',
            fileSize,
          }),
        }),
      );
    });

    it('finalizes via MinIO and marks the session COMPLETED — no local temp file, no merge', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);
      receivedExactly();
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
    const session = {
      id: 'session-1',
      resourceType: 'movie',
      resourceId: 'movie-1',
      objectKey: 'videos/movie-1/original.mp4',
      minioUploadId: 'minio-upload-1',
      fileSize: 10n,
      totalParts: 1,
    };

    it('aborts on MinIO and marks the session FAILED', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);

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

    it('records the abort as a staff act on the title (M-22)', async () => {
      prisma.multipartUploadSession.findUnique.mockResolvedValue(session);

      await service.abortMultipart(role, 'session-1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload_multipart',
          actor: role,
          metadata: expect.objectContaining({ phase: 'abort' }),
        }),
      );
    });
  });
});
