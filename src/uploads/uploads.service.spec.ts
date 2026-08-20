import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { access, readdir } from 'node:fs/promises';
import { UploadsService } from './uploads.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { ProcessingService } from '../processing/processing.service';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { UploadStatus, VideoStatus } from '../generated/prisma/client';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  access: jest.fn(),
  readdir: jest.fn(),
}));

const accessMock = access as jest.Mock;
const readdirMock = readdir as jest.Mock;

describe('UploadsService', () => {
  let service: UploadsService;
  let prisma: {
    movie: { findUnique: jest.Mock; update: jest.Mock };
    uploadSession: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let storageService: {
    uploadSessionDir: jest.Mock;
    ensureDir: jest.Mock;
    videoDir: jest.Mock;
    originalVideoPath: jest.Mock;
    originalObjectKey: jest.Mock;
    hlsMasterKey: jest.Mock;
    hlsRenditionKeyPrefix: jest.Mock;
  };
  let minioService: {
    downloadFile: jest.Mock;
    objectExists: jest.Mock;
    uploadFile: jest.Mock;
  };
  let videosService: {
    findLatestForMovie: jest.Mock;
    create: jest.Mock;
    markReady: jest.Mock;
  };
  let processingService: {
    processVideo: jest.Mock;
    isActivelyProcessing: jest.Mock;
  };
  let subtitlesService: { createFromExistingKey: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { findUnique: jest.fn(), update: jest.fn() },
      uploadSession: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    storageService = {
      uploadSessionDir: jest.fn((id: string) => `/storage/uploads/${id}`),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      videoDir: jest.fn((movieId: string) => `/storage/videos/${movieId}`),
      originalVideoPath: jest.fn(
        (movieId: string, ext: string) =>
          `/storage/videos/${movieId}/original${ext}`,
      ),
      originalObjectKey: jest.fn(
        (movieId: string, ext: string) => `videos/${movieId}/original${ext}`,
      ),
      hlsMasterKey: jest.fn(
        (movieId: string) => `videos/${movieId}/hls/master.m3u8`,
      ),
      hlsRenditionKeyPrefix: jest.fn(
        (movieId: string, name: string) => `videos/${movieId}/hls/${name}`,
      ),
    };
    minioService = {
      downloadFile: jest.fn().mockResolvedValue(undefined),
      objectExists: jest.fn().mockResolvedValue(true),
      uploadFile: jest.fn().mockResolvedValue(undefined),
    };
    videosService = {
      findLatestForMovie: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'video-1' }),
      markReady: jest.fn().mockResolvedValue(undefined),
    };
    processingService = {
      processVideo: jest.fn(),
      isActivelyProcessing: jest.fn().mockReturnValue(false),
    };
    subtitlesService = {
      createFromExistingKey: jest.fn().mockResolvedValue({ id: 'subtitle-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storageService },
        { provide: MinioService, useValue: minioService },
        { provide: VideosService, useValue: videosService },
        { provide: ProcessingService, useValue: processingService },
        { provide: SubtitlesService, useValue: subtitlesService },
      ],
    }).compile();

    service = module.get(UploadsService);
  });

  describe('initUpload', () => {
    const dto = {
      movieId: 'movie-1',
      filename: 'movie.mp4',
      filesize: 10_000_000,
    };

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
        });
        // Uploaded-chunk bookkeeping is derived from which chunk files are
        // actually on disk (see listUploadedChunks) rather than a stored
        // list — 'merged' is the leftover temp file from a previous
        // completeUpload() attempt on this session and must be ignored.
        readdirMock.mockResolvedValue(['chunk_2', 'chunk_0', 'merged']);

        const result = await service.initUpload(dto);

        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
        expect(result.uploadId).toBe('session-existing');
        expect(result.uploadedChunks).toEqual([0, 2]); // sorted, 'merged' excluded
      },
    );

    it('reports no uploaded chunks yet when the session folder does not exist on disk (e.g. right after creation)', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      prisma.uploadSession.findFirst.mockResolvedValue({
        id: 'session-existing',
        chunkSize: 5 * 1024 * 1024,
        totalChunks: 3,
      });
      readdirMock.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await service.initUpload(dto);

      expect(result.uploadedChunks).toEqual([]);
    });

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

    it(
      'includes relativePath (or null) in the resume-match — two files sharing a bare filename ' +
        '(every HLS rendition\'s playlist is "index.m3u8") must never resume against each other',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-3' });
        prisma.uploadSession.update.mockResolvedValue({});

        await service.initUpload({
          ...dto,
          filename: 'index.m3u8',
          relativePath: 'hls/720p/index.m3u8',
        });

        expect(prisma.uploadSession.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              relativePath: 'hls/720p/index.m3u8',
            }),
          }),
        );
        expect(prisma.uploadSession.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              relativePath: 'hls/720p/index.m3u8',
            }),
          }),
        );
      },
    );

    it('classic single-file requests (no relativePath) match null, not undefined — unchanged behavior', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      prisma.uploadSession.findFirst.mockResolvedValue(null);
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-4' });
      prisma.uploadSession.update.mockResolvedValue({});

      await service.initUpload(dto); // no relativePath

      expect(prisma.uploadSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ relativePath: null }),
        }),
      );
    });
  });

  describe('validateExternalBundle', () => {
    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(
        service.validateExternalBundle('movie-1', {
          relativePaths: ['original.mp4'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('reports every relativePath that is not actually present in MinIO', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockImplementation(
        async (key: string) => key !== 'videos/movie-1/hls/master.m3u8',
      );

      const result = await service.validateExternalBundle('movie-1', {
        relativePaths: [
          'original.mp4',
          'hls/master.m3u8',
          'hls/720p/index.m3u8',
        ],
      });

      expect(result).toEqual({
        missing: ['hls/master.m3u8'],
        structureErrors: [],
        valid: false,
      });
    });

    it('reports valid:true and an empty missing list when every file is present and the structure is complete', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      const result = await service.validateExternalBundle('movie-1', {
        relativePaths: [
          'original.mp4',
          'hls/master.m3u8',
          'hls/720p/index.m3u8',
        ],
      });

      expect(result).toEqual({ missing: [], structureErrors: [], valid: true });
    });

    it('reports structureErrors when the uploaded set itself is missing required files — not just a MinIO existence problem', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      const result = await service.validateExternalBundle('movie-1', {
        relativePaths: ['original.mp4'], // no master.m3u8, no rendition at all
      });

      expect(result.valid).toBe(false);
      expect(result.structureErrors).toEqual([
        'master.m3u8 is missing',
        'no valid rendition folder (240p, 360p, 480p, 720p, or 1080p) with an index.m3u8 was found',
      ]);
    });
  });

  describe('finalizeExternalUpload', () => {
    const bundlePaths = [
      'original.mp4',
      'hls/master.m3u8',
      'hls/720p/index.m3u8',
      'hls/480p/index.m3u8',
      'subtitles/english.vtt',
      'subtitles/myanmar.vtt',
    ];
    const dto = { relativePaths: bundlePaths };

    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(
        service.finalizeExternalUpload('movie-1', dto),
      ).rejects.toThrow(NotFoundException);
    });

    it(
      'rejects and marks the movie FAILED — not touching MinIO or creating anything — when the ' +
        'uploaded set violates the fixed folder structure',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });

        await expect(
          service.finalizeExternalUpload('movie-1', {
            relativePaths: ['hls/master.m3u8'],
          }), // no original.mp4, no rendition
        ).rejects.toThrow(BadRequestException);
        expect(minioService.objectExists).not.toHaveBeenCalled();
        expect(videosService.create).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
        expect(prisma.movie.update).toHaveBeenCalledWith({
          where: { id: 'movie-1' },
          data: { status: 'FAILED' },
        });
      },
    );

    it(
      're-validates server-side, marks the movie FAILED, and refuses to finalize when a required ' +
        'file is actually missing from MinIO',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        minioService.objectExists.mockImplementation(
          async (key: string) => key !== 'videos/movie-1/hls/480p/index.m3u8',
        );

        await expect(
          service.finalizeExternalUpload('movie-1', dto),
        ).rejects.toThrow(BadRequestException);
        expect(videosService.create).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
        expect(prisma.movie.update).toHaveBeenCalledWith({
          where: { id: 'movie-1' },
          data: { status: 'FAILED' },
        });
      },
    );

    it(
      'creates the Video row and calls markReady() with the exact same hlsMasterKey() the ' +
        'transcode-based flow would produce — the assertion that proves streaming stays unchanged',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        minioService.objectExists.mockResolvedValue(true);

        const result = await service.finalizeExternalUpload('movie-1', dto);

        expect(videosService.create).toHaveBeenCalledWith({
          movieId: 'movie-1',
          originalFilename: 'original.mp4',
          originalPath: 'videos/movie-1/original.mp4',
        });
        expect(videosService.markReady).toHaveBeenCalledWith('video-1', {
          duration: null,
          resolution: null,
          hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
          renditions: [
            {
              resolution: '480p',
              playlistPath: 'videos/movie-1/hls/480p/index.m3u8',
            },
            {
              resolution: '720p',
              playlistPath: 'videos/movie-1/hls/720p/index.m3u8',
            },
          ],
        });
        expect(result).toEqual({
          videoId: 'video-1',
          status: VideoStatus.READY,
        });
      },
    );

    it(
      'flips the Movie itself to READY_TO_PUBLISH once the video is ready — a READY video alone ' +
        'leaves the movie stuck forever otherwise, mirroring how the classic ProcessingService ' +
        'flow flips its movie to PUBLISHED after transcoding, but stopping one step short: this ' +
        'flow must never publish automatically',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        minioService.objectExists.mockResolvedValue(true);

        await service.finalizeExternalUpload('movie-1', dto);

        expect(prisma.movie.update).toHaveBeenCalledWith({
          where: { id: 'movie-1' },
          data: { status: 'READY_TO_PUBLISH' },
        });
        expect(prisma.movie.update).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: 'PUBLISHED' } }),
        );
      },
    );

    it('ignores unrecognized top-level folder names instead of publishing them as renditions', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', {
        relativePaths: [
          'original.mp4',
          'hls/master.m3u8',
          'hls/720p/index.m3u8',
          'hls/weird-name/index.m3u8',
        ],
      });

      expect(videosService.markReady).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          renditions: [
            {
              resolution: '720p',
              playlistPath: 'videos/movie-1/hls/720p/index.m3u8',
            },
          ],
        }),
      );
    });

    it('auto-creates a Subtitle row for every subtitles/*.vtt|srt|ass file, inferring language/label/format from the filename', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', dto);

      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith({
        videoId: 'video-1',
        language: 'en',
        label: 'English',
        format: 'VTT',
        objectKey: 'videos/movie-1/subtitles/english.vtt',
      });
      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith({
        videoId: 'video-1',
        language: 'my',
        label: 'Myanmar',
        format: 'VTT',
        objectKey: 'videos/movie-1/subtitles/myanmar.vtt',
      });
    });

    it('finalizes fine with zero subtitle files — subtitles are optional', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', {
        relativePaths: [
          'original.mp4',
          'hls/master.m3u8',
          'hls/720p/index.m3u8',
        ],
      });

      expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
    });

    it('never touches processingService — finalizing an external upload never runs ffmpeg', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', dto);

      expect(processingService.processVideo).not.toHaveBeenCalled();
    });
  });

  describe('reprocessVideo', () => {
    it('throws NotFoundException when no video exists for the movie', async () => {
      videosService.findLatestForMovie.mockResolvedValue(null);

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the video is not FAILED', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
        originalPath: 'videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(processingService.processVideo).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when no original file was ever recorded', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: null,
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1')).rejects.toThrow(
        BadRequestException,
      );
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
      expect(result).toEqual({
        videoId: 'video-1',
        status: VideoStatus.PROCESSING,
      });
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

          expect(processingService.isActivelyProcessing).toHaveBeenCalledWith(
            'video-1',
          );
          expect(processingService.processVideo).toHaveBeenCalledWith(
            'video-1',
            'movie-1',
            '/storage/videos/movie-1/original.mp4',
          );
          expect(result).toEqual({
            videoId: 'video-1',
            status: VideoStatus.PROCESSING,
          });
        },
      );

      it(
        'refuses with ConflictException when this process is genuinely still working on it — ' +
          'prevents two processVideo() runs racing on the same scratch files and DB rows',
        async () => {
          videosService.findLatestForMovie.mockResolvedValue(processingVideo);
          processingService.isActivelyProcessing.mockReturnValue(true);

          await expect(service.reprocessVideo('movie-1')).rejects.toThrow(
            ConflictException,
          );
          expect(processingService.processVideo).not.toHaveBeenCalled();
        },
      );
    });
  });
});
