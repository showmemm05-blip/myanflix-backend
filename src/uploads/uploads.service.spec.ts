import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { access } from 'node:fs/promises';
import { UploadsService } from './uploads.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { ProcessingService } from '../processing/processing.service';
import { UploadStatus, VideoStatus } from '../generated/prisma/client';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  access: jest.fn(),
}));

const accessMock = access as jest.Mock;

describe('UploadsService', () => {
  let service: UploadsService;
  let prisma: { movie: { findUnique: jest.Mock }; uploadSession: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let storageService: {
    uploadSessionDir: jest.Mock;
    ensureDir: jest.Mock;
    videoDir: jest.Mock;
    originalVideoPath: jest.Mock;
  };
  let minioService: { downloadFile: jest.Mock };
  let videosService: { findLatestForMovie: jest.Mock };
  let processingService: { processVideo: jest.Mock; isActivelyProcessing: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { findUnique: jest.fn() },
      uploadSession: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    storageService = {
      uploadSessionDir: jest.fn((id: string) => `/storage/uploads/${id}`),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      videoDir: jest.fn((movieId: string) => `/storage/videos/${movieId}`),
      originalVideoPath: jest.fn((movieId: string, ext: string) => `/storage/videos/${movieId}/original${ext}`),
    };
    minioService = { downloadFile: jest.fn().mockResolvedValue(undefined) };
    videosService = { findLatestForMovie: jest.fn() };
    processingService = { processVideo: jest.fn(), isActivelyProcessing: jest.fn().mockReturnValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storageService },
        { provide: MinioService, useValue: minioService },
        { provide: VideosService, useValue: videosService },
        { provide: ProcessingService, useValue: processingService },
      ],
    }).compile();

    service = module.get(UploadsService);
  });

  describe('initUpload', () => {
    const dto = { movieId: 'movie-1', filename: 'movie.mp4', filesize: 10_000_000 };

    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(service.initUpload(dto)).rejects.toThrow(NotFoundException);
    });

    it('creates a brand-new session when no in-progress one matches', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      prisma.uploadSession.findFirst.mockResolvedValue(null);
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-1' });
      prisma.uploadSession.update.mockResolvedValue({});

      const result = await service.initUpload(dto);

      expect(prisma.uploadSession.create).toHaveBeenCalled();
      expect(result.uploadId).toBe('session-1');
      expect(result.uploadedChunks).toEqual([]);
    });

    it(
      'resumes an existing in-progress session for the same movie/filename/size instead of ' +
        'starting a new one — this is what lets a retry skip chunks it already sent',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        prisma.uploadSession.findFirst.mockResolvedValue({
          id: 'session-existing',
          chunkSize: 5 * 1024 * 1024,
          totalChunks: 3,
          uploadedChunks: [2, 0],
        });

        const result = await service.initUpload(dto);

        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
        expect(result.uploadId).toBe('session-existing');
        expect(result.uploadedChunks).toEqual([0, 2]); // sorted
      },
    );

    it('only matches sessions with an exact filename+filesize match (a different file for the same movie starts fresh)', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      prisma.uploadSession.findFirst.mockResolvedValue(null); // Prisma's own where clause enforces the match
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-2' });
      prisma.uploadSession.update.mockResolvedValue({});

      await service.initUpload(dto);

      expect(prisma.uploadSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            movieId: dto.movieId,
            filename: dto.filename,
            fileSize: BigInt(dto.filesize),
            status: UploadStatus.IN_PROGRESS,
          }),
        }),
      );
    });
  });

  describe('reprocessVideo', () => {
    it('throws NotFoundException when no video exists for the movie', async () => {
      videosService.findLatestForMovie.mockResolvedValue(null);

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the video is not FAILED', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
        originalPath: 'videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(BadRequestException);
      expect(processingService.processVideo).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when no original file was ever recorded', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: null,
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(BadRequestException);
    });

    it('reprocesses directly from the local scratch file when the archive-to-MinIO step never ran', async () => {
      accessMock.mockResolvedValue(undefined); // local file exists
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      const result = await service.reprocessVideo('movie-1');

      expect(minioService.downloadFile).not.toHaveBeenCalled();
      expect(processingService.processVideo).toHaveBeenCalledWith(
        'video-1',
        'movie-1',
        '/storage/videos/movie-1/original.mp4',
      );
      expect(result).toEqual({ videoId: 'video-1', status: VideoStatus.PROCESSING });
    });

    it(
      'downloads the original back from MinIO when the local scratch copy is gone ' +
        '(the archive step already succeeded before a later failure)',
      async () => {
        accessMock.mockRejectedValue(new Error('ENOENT')); // local file no longer exists
        videosService.findLatestForMovie.mockResolvedValue({
          id: 'video-1',
          status: VideoStatus.FAILED,
          originalPath: 'videos/movie-1/original.mp4', // MinIO object key
          originalFilename: 'movie.mp4',
        });

        await service.reprocessVideo('movie-1');

        expect(minioService.downloadFile).toHaveBeenCalledWith(
          'videos/movie-1/original.mp4',
          '/storage/videos/movie-1/original.mp4',
        );
        expect(processingService.processVideo).toHaveBeenCalledWith(
          'video-1',
          'movie-1',
          '/storage/videos/movie-1/original.mp4',
        );
      },
    );

    it('never re-uploads from the client — reprocessing only ever calls processVideo, never any upload-session logic', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await service.reprocessVideo('movie-1');

      expect(prisma.uploadSession.create).not.toHaveBeenCalled();
    });

    describe('a video stuck at PROCESSING (orphaned by a crash/restart, or genuinely still running)', () => {
      const processingVideo = {
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        originalPath: '/storage/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      };

      it(
        'allows reprocessing when this process is not actually working on it ' +
          '(orphaned by a crash or restart — the whole point of not waiting out a timeout)',
        async () => {
          accessMock.mockResolvedValue(undefined);
          videosService.findLatestForMovie.mockResolvedValue(processingVideo);
          processingService.isActivelyProcessing.mockReturnValue(false);

          const result = await service.reprocessVideo('movie-1');

          expect(processingService.isActivelyProcessing).toHaveBeenCalledWith('video-1');
          expect(processingService.processVideo).toHaveBeenCalledWith(
            'video-1',
            'movie-1',
            '/storage/videos/movie-1/original.mp4',
          );
          expect(result).toEqual({ videoId: 'video-1', status: VideoStatus.PROCESSING });
        },
      );

      it(
        'refuses with ConflictException when this process is genuinely still working on it — ' +
          'prevents two processVideo() runs racing on the same scratch files and DB rows',
        async () => {
          videosService.findLatestForMovie.mockResolvedValue(processingVideo);
          processingService.isActivelyProcessing.mockReturnValue(true);

          await expect(service.reprocessVideo('movie-1')).rejects.toThrow(ConflictException);
          expect(processingService.processVideo).not.toHaveBeenCalled();
        },
      );
    });
  });
});
