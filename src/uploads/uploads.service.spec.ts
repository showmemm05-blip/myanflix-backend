import { Test, TestingModule } from '@nestjs/testing';
import {
  BadGatewayException,
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
import { VideoDurationService } from '../videos/video-duration.service';
import { ProcessingService } from '../processing/processing.service';
import { SubtitlesService } from '../subtitles/subtitles.service';
import { AuditService } from '../audit/audit.service';
import { ResourceUploadTypeRegistry } from './resource-upload-type.registry';
import {
  MovieStatus,
  Role,
  UploadStatus,
  VideoStatus,
} from '../generated/prisma/client';

/** A staff actor for the audit calls — the mocked AuditService records nothing. */
const ACTOR = {
  id: 'admin-1',
  username: 'boss',
  role: Role.ADMIN,
  appRoleId: null,
} as const;

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
    movie: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    video: { update: jest.Mock; create: jest.Mock };
    subtitle: { findMany: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
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
    hlsPackagePrefix: jest.Mock;
    hlsMasterKey: jest.Mock;
    hlsRenditionKeyPrefix: jest.Mock;
    imageObjectKey: jest.Mock;
    videoKeyPrefix: jest.Mock;
    subtitleSourcePrefix: jest.Mock;
    videoReplaceStagingPrefix: jest.Mock;
    videoReplaceStagingKey: jest.Mock;
  };
  let minioService: {
    downloadFile: jest.Mock;
    objectExists: jest.Mock;
    uploadFile: jest.Mock;
    uploadBuffer: jest.Mock;
    publicUrl: jest.Mock;
    listKeys: jest.Mock;
    copyObject: jest.Mock;
    deleteKeys: jest.Mock;
    deleteByPrefix: jest.Mock;
  };
  let videosService: {
    findLatestForMovie: jest.Mock;
    create: jest.Mock;
    markReady: jest.Mock;
  };
  let videoDurationService: {
    recoverHlsDurationSeconds: jest.Mock;
    fillMovieDurationIfUnknown: jest.Mock;
  };
  let processingService: {
    processVideo: jest.Mock;
    isActivelyProcessing: jest.Mock;
    reserve: jest.Mock;
    release: jest.Mock;
  };
  let subtitlesService: { createFromExistingKey: jest.Mock };
  let audit: { record: jest.Mock };
  let resourceTypes: { resolve: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    prisma = {
      movie: {
        findUnique: jest.fn(),
        update: jest.fn(),
        // The compare-and-set status flips win by default; a case that
        // wants a lost race overrides this with { count: 0 }.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      video: {
        update: jest.fn().mockResolvedValue({ id: 'video-1' }),
        create: jest.fn().mockResolvedValue({ id: 'video-new' }),
      },
      subtitle: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // The interactive transaction of the replace swap runs its callback
      // against the same mocks, so the spec sees every write it makes.
      $transaction: jest.fn(),
      uploadSession: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    storageService = {
      videoKeyPrefix: jest.fn((movieId: string) => `videos/${movieId}`),
      subtitleSourcePrefix: jest.fn(
        (movieId: string) => `subtitles/${movieId}`,
      ),
      videoReplaceStagingPrefix: jest.fn(
        (movieId: string) => `temp/video-replace/${movieId}`,
      ),
      videoReplaceStagingKey: jest.fn(
        (movieId: string, rel: string) =>
          `temp/video-replace/${movieId}/${rel}`,
      ),
      uploadSessionDir: jest.fn((id: string) => `/storage/temp/uploads/${id}`),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      videoDir: jest.fn((movieId: string) => `/storage/temp/videos/${movieId}`),
      originalVideoPath: jest.fn(
        (movieId: string, ext: string) =>
          `/storage/temp/videos/${movieId}/original${ext}`,
      ),
      originalObjectKey: jest.fn(
        (movieId: string, ext: string) => `videos/${movieId}/original${ext}`,
      ),
      // Mirrors the real builders (asserted for real in
      // storage.service.spec.ts): a tag, passed only by the replace flow,
      // moves the whole package one folder deeper into hls/v-<tag>/.
      hlsPackagePrefix: jest.fn((movieId: string, tag?: string) =>
        tag ? `videos/${movieId}/hls/v-${tag}` : `videos/${movieId}/hls`,
      ),
      hlsMasterKey: jest.fn(
        (movieId: string, tag?: string) =>
          `${storageService.hlsPackagePrefix(movieId, tag)}/master.m3u8`,
      ),
      hlsRenditionKeyPrefix: jest.fn(
        (movieId: string, name: string, tag?: string) =>
          `${storageService.hlsPackagePrefix(movieId, tag)}/${name}`,
      ),
      imageObjectKey: jest.fn(
        (purpose: string, imageId: string, ext: string) =>
          `images/${purpose}/${imageId}${ext}`,
      ),
    };
    minioService = {
      downloadFile: jest.fn().mockResolvedValue(undefined),
      objectExists: jest.fn().mockResolvedValue(true),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      publicUrl: jest.fn((key: string) => `https://cdn.example/${key}`),
      listKeys: jest.fn().mockResolvedValue([]),
      copyObject: jest.fn().mockResolvedValue(undefined),
      deleteKeys: jest.fn().mockResolvedValue(undefined),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    };
    videosService = {
      findLatestForMovie: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'video-1' }),
      markReady: jest.fn().mockResolvedValue(undefined),
    };
    // Unknown by default so every pre-existing finalize case keeps the
    // behaviour it was written against (duration: null, no movie write).
    videoDurationService = {
      recoverHlsDurationSeconds: jest.fn().mockResolvedValue(null),
      fillMovieDurationIfUnknown: jest.fn().mockResolvedValue(true),
    };
    processingService = {
      processVideo: jest.fn(),
      isActivelyProcessing: jest.fn().mockReturnValue(false),
      reserve: jest.fn().mockReturnValue(true),
      release: jest.fn(),
    };
    subtitlesService = {
      createFromExistingKey: jest.fn().mockResolvedValue({ id: 'subtitle-1' }),
    };
    // Mirrors the real ResourceUploadTypeRegistry routing (asserted for real
    // in resource-upload-type.registry.spec.ts): every bundle file keeps the
    // movie's video namespace except an uploaded subtitle SOURCE, which
    // moves to subtitles/<movieId>/<filename>.
    resourceTypes = {
      resolve: jest.fn().mockReturnValue({
        buildKey: (resourceId: string, relativePath: string) =>
          relativePath.startsWith('subtitles/')
            ? `subtitles/${resourceId}/${relativePath.slice('subtitles/'.length)}`
            : `videos/${resourceId}/${relativePath}`,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storageService },
        { provide: MinioService, useValue: minioService },
        { provide: VideosService, useValue: videosService },
        { provide: VideoDurationService, useValue: videoDurationService },
        { provide: ProcessingService, useValue: processingService },
        { provide: SubtitlesService, useValue: subtitlesService },
        { provide: AuditService, useValue: audit },
        { provide: ResourceUploadTypeRegistry, useValue: resourceTypes },
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

    it(
      'looks a subtitle source up where it was actually uploaded — subtitles/<movieId>/<filename>, ' +
        'not beside the video assets',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        minioService.objectExists.mockResolvedValue(true);

        await service.validateExternalBundle('movie-1', {
          relativePaths: [
            'original.mp4',
            'hls/master.m3u8',
            'hls/720p/index.m3u8',
            'subtitles/english.vtt',
          ],
        });

        expect(minioService.objectExists).toHaveBeenCalledWith(
          'subtitles/movie-1/english.vtt',
        );
        expect(minioService.objectExists).not.toHaveBeenCalledWith(
          'videos/movie-1/subtitles/english.vtt',
        );
      },
    );

    it(
      'rejects a bundle whose subtitle files share a filename — both would be stored at the same ' +
        'key, so the second would silently overwrite the first',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
        minioService.objectExists.mockResolvedValue(true);

        const result = await service.validateExternalBundle('movie-1', {
          relativePaths: [
            'original.mp4',
            'hls/master.m3u8',
            'hls/720p/index.m3u8',
            'subtitles/english.vtt',
            'subtitles/extra/English.vtt',
          ],
        });

        expect(result.valid).toBe(false);
        expect(result.structureErrors).toEqual([
          'subtitle filenames must be unique — "subtitles/extra/English.vtt" and "subtitles/english.vtt" would both be stored as english.vtt',
        ]);
      },
    );

    it('reports a missing original whatever container the operator used', async () => {
      prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1' });
      minioService.objectExists.mockResolvedValue(true);

      const result = await service.validateExternalBundle('movie-1', {
        relativePaths: ['hls/master.m3u8', 'hls/720p/index.m3u8'],
      });

      expect(result.structureErrors).toEqual([
        'original.<ext> is missing from the bundle root',
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
    /** The bulk flow's source state — what every finalize normally starts from. */
    const uploadingMovie = {
      id: 'movie-1',
      title: 'Movie 1',
      status: MovieStatus.UPLOADING,
      seriesId: null,
    };
    const movieWithStatus = (status: MovieStatus) => ({
      ...uploadingMovie,
      status,
    });

    it('throws NotFoundException when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(
        service.finalizeExternalUpload('movie-1', dto, ACTOR),
      ).rejects.toThrow(NotFoundException);
    });

    it(
      'rejects and marks the movie FAILED — not touching MinIO or creating anything — when the ' +
        'uploaded set violates the fixed folder structure',
      async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);

        await expect(
          service.finalizeExternalUpload(
            'movie-1',
            {
              relativePaths: ['hls/master.m3u8'],
            },
            ACTOR,
          ), // no original.mp4, no rendition
        ).rejects.toThrow(BadRequestException);
        expect(minioService.objectExists).not.toHaveBeenCalled();
        expect(videosService.create).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
        expect(prisma.movie.updateMany).toHaveBeenCalledWith({
          where: { id: 'movie-1', status: 'UPLOADING' },
          data: { status: 'FAILED' },
        });
      },
    );

    it(
      're-validates server-side, marks the movie FAILED, and refuses to finalize when a required ' +
        'file is actually missing from MinIO',
      async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        minioService.objectExists.mockImplementation(
          async (key: string) => key !== 'videos/movie-1/hls/480p/index.m3u8',
        );

        await expect(
          service.finalizeExternalUpload('movie-1', dto, ACTOR),
        ).rejects.toThrow(BadRequestException);
        expect(videosService.create).not.toHaveBeenCalled();
        expect(videosService.markReady).not.toHaveBeenCalled();
        expect(prisma.movie.updateMany).toHaveBeenCalledWith({
          where: { id: 'movie-1', status: 'UPLOADING' },
          data: { status: 'FAILED' },
        });
      },
    );

    it(
      'creates the Video row and calls markReady() with the exact same hlsMasterKey() the ' +
        'transcode-based flow would produce — the assertion that proves streaming stays unchanged',
      async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        minioService.objectExists.mockResolvedValue(true);

        const result = await service.finalizeExternalUpload(
          'movie-1',
          dto,
          ACTOR,
        );

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
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        minioService.objectExists.mockResolvedValue(true);

        await service.finalizeExternalUpload('movie-1', dto, ACTOR);

        expect(prisma.movie.updateMany).toHaveBeenCalledWith({
          where: { id: 'movie-1', status: 'UPLOADING' },
          data: { status: 'READY_TO_PUBLISH' },
        });
        expect(prisma.movie.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: 'PUBLISHED' } }),
        );
        expect(prisma.movie.update).not.toHaveBeenCalled();
      },
    );

    it('ignores unrecognized top-level folder names instead of publishing them as renditions', async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload(
        'movie-1',
        {
          relativePaths: [
            'original.mp4',
            'hls/master.m3u8',
            'hls/720p/index.m3u8',
            'hls/weird-name/index.m3u8',
          ],
        },
        ACTOR,
      );

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
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', dto, ACTOR);

      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith({
        videoId: 'video-1',
        language: 'en',
        label: 'English',
        format: 'VTT',
        objectKey: 'subtitles/movie-1/english.vtt',
      });
      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith({
        videoId: 'video-1',
        language: 'my',
        label: 'Myanmar',
        format: 'VTT',
        objectKey: 'subtitles/movie-1/myanmar.vtt',
      });
    });

    it(
      'takes the original\'s extension from the bundle instead of assuming ".mp4" — an .mkv master ' +
        'is a normal bundle and used to be impossible to finalize at all',
      async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        minioService.objectExists.mockResolvedValue(true);

        await service.finalizeExternalUpload(
          'movie-1',
          {
            relativePaths: [
              'original.mkv',
              'hls/master.m3u8',
              'hls/720p/index.m3u8',
            ],
          },
          ACTOR,
        );

        expect(minioService.objectExists).toHaveBeenCalledWith(
          'videos/movie-1/original.mkv',
        );
        expect(videosService.create).toHaveBeenCalledWith({
          movieId: 'movie-1',
          originalFilename: 'original.mkv',
          originalPath: 'videos/movie-1/original.mkv',
        });
      },
    );

    it('refuses a bundle carrying two originals — only one of them could ever be the Video row', async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);

      await expect(
        service.finalizeExternalUpload(
          'movie-1',
          {
            relativePaths: [
              'original.mp4',
              'original.mkv',
              'hls/master.m3u8',
              'hls/720p/index.m3u8',
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.objectExists).not.toHaveBeenCalled();
      expect(videosService.create).not.toHaveBeenCalled();
    });

    it('finalizes fine with zero subtitle files — subtitles are optional', async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload(
        'movie-1',
        {
          relativePaths: [
            'original.mp4',
            'hls/master.m3u8',
            'hls/720p/index.m3u8',
          ],
        },
        ACTOR,
      );

      expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
    });

    it('never touches processingService — finalizing an external upload never runs ffmpeg', async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', dto, ACTOR);

      expect(processingService.processVideo).not.toHaveBeenCalled();
    });

    it(
      'records the runtime recovered from the HLS master on the Video row and offers it to the ' +
        'Movie — conditionally, through fillMovieDurationIfUnknown, never a blind write',
      async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        minioService.objectExists.mockResolvedValue(true);
        videoDurationService.recoverHlsDurationSeconds.mockResolvedValue(5430);

        await service.finalizeExternalUpload('movie-1', dto, ACTOR);

        expect(
          videoDurationService.recoverHlsDurationSeconds,
        ).toHaveBeenCalledWith('videos/movie-1/hls/master.m3u8');
        expect(videosService.markReady).toHaveBeenCalledWith(
          'video-1',
          expect.objectContaining({ duration: 5430 }),
        );
        expect(
          videoDurationService.fillMovieDurationIfUnknown,
        ).toHaveBeenCalledWith('movie-1', 5430);
        // Only ever the status flip — the runtime never goes through a blind
        // prisma.movie.update that could clobber an admin-typed value.
        expect(prisma.movie.update).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ duration: expect.anything() }),
          }),
        );
      },
    );

    it("leaves Video.duration null and never touches the Movie runtime when nothing could be recovered — today's behaviour preserved", async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);
      videoDurationService.recoverHlsDurationSeconds.mockResolvedValue(null);

      const result = await service.finalizeExternalUpload(
        'movie-1',
        dto,
        ACTOR,
      );

      expect(videosService.markReady).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({ duration: null }),
      );
      expect(
        videoDurationService.fillMovieDurationIfUnknown,
      ).not.toHaveBeenCalled();
      expect(result).toEqual({ videoId: 'video-1', status: VideoStatus.READY });
    });

    describe('state guard — only an UPLOADING or FAILED bundle movie is ever finalized', () => {
      it.each([
        MovieStatus.PUBLISHED,
        MovieStatus.ARCHIVED,
        MovieStatus.DRAFT,
        MovieStatus.PROCESSING,
      ])(
        'refuses with ConflictException and writes nothing when the movie is %s',
        async (status) => {
          prisma.movie.findUnique.mockResolvedValue(movieWithStatus(status));

          await expect(
            service.finalizeExternalUpload('movie-1', dto, ACTOR),
          ).rejects.toThrow(ConflictException);

          expect(videosService.create).not.toHaveBeenCalled();
          expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
        },
      );

      it(
        'never fails a live title: an invalid bundle on a PUBLISHED movie is a 409 (not a 400) ' +
          'and the movie keeps its status',
        async () => {
          prisma.movie.findUnique.mockResolvedValue(
            movieWithStatus(MovieStatus.PUBLISHED),
          );

          await expect(
            service.finalizeExternalUpload(
              'movie-1',
              { relativePaths: ['nope.txt'] },
              ACTOR,
            ),
          ).rejects.toThrow(ConflictException);

          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
        },
      );

      it(
        'replays idempotently on a READY_TO_PUBLISH movie — returns the existing READY video, ' +
          'creates nothing and records nothing',
        async () => {
          prisma.movie.findUnique.mockResolvedValue(
            movieWithStatus(MovieStatus.READY_TO_PUBLISH),
          );
          videosService.findLatestForMovie.mockResolvedValue({
            id: 'video-9',
            status: VideoStatus.READY,
          });

          const result = await service.finalizeExternalUpload(
            'movie-1',
            dto,
            ACTOR,
          );

          expect(result).toEqual({
            videoId: 'video-9',
            status: VideoStatus.READY,
          });
          expect(minioService.objectExists).not.toHaveBeenCalled();
          expect(videosService.create).not.toHaveBeenCalled();
          expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
        },
      );

      it('refuses with ConflictException when a READY_TO_PUBLISH movie has no READY video', async () => {
        prisma.movie.findUnique.mockResolvedValue(
          movieWithStatus(MovieStatus.READY_TO_PUBLISH),
        );
        videosService.findLatestForMovie.mockResolvedValue({
          id: 'video-9',
          status: VideoStatus.FAILED,
        });

        await expect(
          service.finalizeExternalUpload('movie-1', dto, ACTOR),
        ).rejects.toThrow(ConflictException);
        expect(videosService.create).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('retries a FAILED movie: flips it with a compare-and-set on FAILED and records movie.upload', async () => {
        prisma.movie.findUnique.mockResolvedValue(
          movieWithStatus(MovieStatus.FAILED),
        );

        const result = await service.finalizeExternalUpload(
          'movie-1',
          dto,
          ACTOR,
        );

        expect(result).toEqual({
          videoId: 'video-1',
          status: VideoStatus.READY,
        });
        expect(prisma.movie.updateMany).toHaveBeenCalledWith({
          where: { id: 'movie-1', status: 'FAILED' },
          data: { status: 'READY_TO_PUBLISH' },
        });
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'movie.upload',
            before: { status: 'FAILED' },
            after: { status: 'READY_TO_PUBLISH' },
          }),
        );
      });

      it(
        'invalid bundle on an UPLOADING movie is still a 400 that marks it FAILED via compare-and-set ' +
          'and records movie.status_change (trigger finalize_failed)',
        async () => {
          prisma.movie.findUnique.mockResolvedValue(uploadingMovie);

          await expect(
            service.finalizeExternalUpload(
              'movie-1',
              { relativePaths: ['nope.txt'] },
              ACTOR,
            ),
          ).rejects.toThrow(BadRequestException);

          expect(prisma.movie.updateMany).toHaveBeenCalledWith({
            where: { id: 'movie-1', status: 'UPLOADING' },
            data: { status: 'FAILED' },
          });
          expect(audit.record).toHaveBeenCalledTimes(1);
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'movie.status_change',
              before: { status: 'UPLOADING' },
              after: { status: 'FAILED' },
              metadata: expect.objectContaining({ trigger: 'finalize_failed' }),
            }),
          );
        },
      );

      it('records no status_change row when the FAILED compare-and-set finds the movie already moved on', async () => {
        prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
        prisma.movie.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          service.finalizeExternalUpload(
            'movie-1',
            { relativePaths: ['nope.txt'] },
            ACTOR,
          ),
        ).rejects.toThrow(BadRequestException);

        expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('concurrency', () => {
      it(
        'three parallel finalizes for one movie join a single run — one Video, one subtitle set, ' +
          'one audit row, and every caller gets the same answer',
        async () => {
          prisma.movie.findUnique.mockResolvedValue(uploadingMovie);

          const results = await Promise.all([
            service.finalizeExternalUpload('movie-1', dto, ACTOR),
            service.finalizeExternalUpload('movie-1', dto, ACTOR),
            service.finalizeExternalUpload('movie-1', dto, ACTOR),
          ]);

          expect(videosService.create).toHaveBeenCalledTimes(1);
          // Two subtitle files in the bundle — once each, not once per caller.
          expect(subtitlesService.createFromExistingKey).toHaveBeenCalledTimes(
            2,
          );
          expect(audit.record).toHaveBeenCalledTimes(1);
          expect(results).toEqual([
            { videoId: 'video-1', status: VideoStatus.READY },
            { videoId: 'video-1', status: VideoStatus.READY },
            { videoId: 'video-1', status: VideoStatus.READY },
          ]);
        },
      );

      it(
        'keeps the READY video and only skips the status flip when the compare-and-set loses ' +
          '(an admin changed the status mid-run) — recorded as movie.upload with statusFlipSkipped',
        async () => {
          prisma.movie.findUnique
            .mockResolvedValueOnce(uploadingMovie)
            .mockResolvedValueOnce({ status: MovieStatus.PUBLISHED });
          prisma.movie.updateMany.mockResolvedValue({ count: 0 });

          const result = await service.finalizeExternalUpload(
            'movie-1',
            dto,
            ACTOR,
          );

          expect(result).toEqual({
            videoId: 'video-1',
            status: VideoStatus.READY,
          });
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(audit.record).toHaveBeenCalledTimes(1);
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'movie.upload',
              before: { status: 'UPLOADING' },
              after: { status: 'PUBLISHED' },
              metadata: expect.objectContaining({
                videoId: 'video-1',
                statusFlipSkipped: true,
              }),
            }),
          );
        },
      );
    });
  });

  describe('reprocessVideo', () => {
    it('throws NotFoundException when no video exists for the movie', async () => {
      videosService.findLatestForMovie.mockResolvedValue(null);

      await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the video is READY and its master playlist is present', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
        originalPath: 'videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
        hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
      });
      minioService.objectExists.mockResolvedValue(true);

      await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(minioService.objectExists).toHaveBeenCalledWith(
        'videos/movie-1/hls/master.m3u8',
      );
      expect(processingService.processVideo).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an UPLOADING video — it is not stuck, it is still arriving', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.UPLOADING,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(minioService.objectExists).not.toHaveBeenCalled();
    });

    it(
      'accepts a READY video whose master playlist is GONE from the store — functionally failed, ' +
        'exactly the case the playback diagnosis suggests a reprocess for',
      async () => {
        accessMock.mockRejectedValue(new Error('ENOENT'));
        videosService.findLatestForMovie.mockResolvedValue({
          id: 'video-1',
          status: VideoStatus.READY,
          originalPath: 'videos/movie-1/original.mp4',
          originalFilename: 'original.mp4',
          hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
        });
        minioService.objectExists.mockResolvedValue(false);

        const result = await service.reprocessVideo('movie-1', ACTOR);

        expect(minioService.objectExists).toHaveBeenCalledWith(
          'videos/movie-1/hls/master.m3u8',
        );
        expect(minioService.downloadFile).toHaveBeenCalledWith(
          'videos/movie-1/original.mp4',
          '/storage/temp/videos/movie-1/original.mp4',
        );
        expect(processingService.processVideo).toHaveBeenCalledWith(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        );
        expect(result).toEqual({
          videoId: 'video-1',
          status: VideoStatus.PROCESSING,
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'movie.reprocess',
            metadata: { videoId: 'video-1', previousVideoStatus: 'READY' },
          }),
        );
      },
    );

    it('sweeps a replaced hls/v-<tag>/ package before re-transcoding, so the un-versioned output does not orphan it', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
        hlsMasterPath: 'videos/movie-1/hls/v-abc123/master.m3u8',
      });

      await service.reprocessVideo('movie-1', ACTOR);

      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(
        'videos/movie-1/hls/v-abc123/',
      );
      expect(processingService.processVideo).toHaveBeenCalled();
    });

    it('leaves the un-versioned package alone before re-transcoding (the pipeline resumes per tier on those keys)', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
        hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
      });

      await service.reprocessVideo('movie-1', ACTOR);

      expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      expect(processingService.processVideo).toHaveBeenCalled();
    });

    it('treats a READY video with no master path at all as master-missing too', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.READY,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
        hlsMasterPath: null,
      });

      await service.reprocessVideo('movie-1', ACTOR);

      expect(minioService.objectExists).not.toHaveBeenCalled();
      expect(processingService.processVideo).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException when no original file was ever recorded', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: null,
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reprocesses directly from the local scratch file when the archive-to-MinIO step never ran', async () => {
      accessMock.mockResolvedValue(undefined); // local file exists
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      const result = await service.reprocessVideo('movie-1', ACTOR);

      expect(minioService.downloadFile).not.toHaveBeenCalled();
      expect(processingService.processVideo).toHaveBeenCalledWith(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
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

        await service.reprocessVideo('movie-1', ACTOR);

        expect(minioService.downloadFile).toHaveBeenCalledWith(
          'videos/movie-1/original.mp4',
          '/storage/temp/videos/movie-1/original.mp4',
        );
        expect(processingService.processVideo).toHaveBeenCalledWith(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        );
      },
    );

    it('never re-uploads from the client — reprocessing only ever calls processVideo, never any upload-session logic', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await service.reprocessVideo('movie-1', ACTOR);

      expect(prisma.uploadSession.create).not.toHaveBeenCalled();
    });

    describe('a video stuck at PROCESSING (orphaned by a crash/restart, or genuinely still running)', () => {
      const processingVideo = {
        id: 'video-1',
        status: VideoStatus.PROCESSING,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      };

      it(
        'allows reprocessing when this process is not actually working on it ' +
          '(orphaned by a crash or restart — the whole point of not waiting out a timeout)',
        async () => {
          accessMock.mockResolvedValue(undefined);
          videosService.findLatestForMovie.mockResolvedValue(processingVideo);
          processingService.isActivelyProcessing.mockReturnValue(false);

          const result = await service.reprocessVideo('movie-1', ACTOR);

          expect(processingService.isActivelyProcessing).toHaveBeenCalledWith(
            'video-1',
          );
          expect(processingService.processVideo).toHaveBeenCalledWith(
            'video-1',
            'movie-1',
            '/storage/temp/videos/movie-1/original.mp4',
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

          await expect(
            service.reprocessVideo('movie-1', ACTOR),
          ).rejects.toThrow(ConflictException);
          expect(processingService.processVideo).not.toHaveBeenCalled();
        },
      );
    });

    describe('the synchronous reservation — one of N simultaneous presses starts the pipeline', () => {
      const failedVideo = {
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: 'videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      };

      it('refuses with ConflictException when the video is already reserved, without starting or logging anything', async () => {
        videosService.findLatestForMovie.mockResolvedValue(failedVideo);
        processingService.reserve.mockReturnValue(false);

        await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
          ConflictException,
        );

        expect(processingService.reserve).toHaveBeenCalledWith('video-1');
        expect(minioService.downloadFile).not.toHaveBeenCalled();
        expect(processingService.processVideo).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('gives the reservation back when the original cannot be brought back from MinIO', async () => {
        accessMock.mockRejectedValue(new Error('ENOENT'));
        videosService.findLatestForMovie.mockResolvedValue(failedVideo);
        minioService.downloadFile.mockRejectedValue(new Error('minio down'));

        await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
          'minio down',
        );

        expect(processingService.release).toHaveBeenCalledWith('video-1');
        expect(processingService.processVideo).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('never releases after a successful start — the pipeline owns the reservation from then on', async () => {
        accessMock.mockResolvedValue(undefined);
        videosService.findLatestForMovie.mockResolvedValue({
          ...failedVideo,
          originalPath: '/storage/temp/videos/movie-1/original.mp4',
        });

        await service.reprocessVideo('movie-1', ACTOR);

        expect(processingService.release).not.toHaveBeenCalled();
        expect(processingService.processVideo).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('video replace — a new bundle for a title that already has a video', () => {
    /** Original in a different container than the old one, one rendition dropped (1080p), one subtitle. */
    const replacePaths = [
      'original.mkv',
      'hls/master.m3u8',
      'hls/720p/index.m3u8',
      'hls/720p/segment_000.ts',
      'hls/480p/index.m3u8',
      'hls/480p/segment_000.ts',
      'subtitles/english.vtt',
    ];
    const dto = { relativePaths: replacePaths };
    const publishedMovie = {
      id: 'movie-1',
      title: 'Movie 1',
      status: MovieStatus.PUBLISHED,
      seriesId: null,
      duration: 90,
    };
    const movieWithStatus = (status: MovieStatus) => ({
      ...publishedMovie,
      status,
    });
    const servedVideo = {
      id: 'video-1',
      movieId: 'movie-1',
      status: VideoStatus.READY,
      originalFilename: 'original.mp4',
      originalPath: 'videos/movie-1/original.mp4',
      hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
      renditions: [
        {
          resolution: '1080p',
          playlistPath: 'videos/movie-1/hls/1080p/index.m3u8',
        },
        {
          resolution: '720p',
          playlistPath: 'videos/movie-1/hls/720p/index.m3u8',
        },
      ],
      duration: 5400,
      resolution: null,
      failureReason: null,
    };
    /** What the title holds in MinIO before the swap. */
    const oldVideoKeys = [
      'videos/movie-1/original.mp4',
      'videos/movie-1/hls/master.m3u8',
      'videos/movie-1/hls/720p/index.m3u8',
      'videos/movie-1/hls/720p/segment_000.ts',
      'videos/movie-1/hls/1080p/index.m3u8',
      'videos/movie-1/hls/1080p/segment_000.ts',
      'videos/movie-1/hls/subs/old-sub.vtt',
      'videos/movie-1/hls/subs/old-sub.m3u8',
    ];
    const oldSubtitleKeys = ['subtitles/movie-1/old-sub.srt'];
    const STAGING = 'temp/video-replace/movie-1/';
    /**
     * The package tag every replace below mints — pinned so the versioned
     * keys are literal. Where the new package lands: never the old keys.
     */
    const TAG = 'test01';
    const PACKAGE = `videos/movie-1/hls/v-${TAG}`;
    const NEW_MASTER = `${PACKAGE}/master.m3u8`;
    let tagSpy: jest.SpyInstance<string, []>;

    beforeEach(() => {
      tagSpy = jest
        .spyOn(
          service as unknown as { hlsVersionTag: () => string },
          'hlsVersionTag',
        )
        .mockReturnValue(TAG);
    });

    /** A movie with a served video and its current objects — the normal starting point. */
    const liveTitle = (status: MovieStatus = MovieStatus.PUBLISHED) => {
      prisma.movie.findUnique.mockResolvedValue(movieWithStatus(status));
      videosService.findLatestForMovie.mockResolvedValue(servedVideo);
      prisma.subtitle.findMany.mockResolvedValue([
        {
          id: 'old-sub',
          language: 'my',
          label: 'Myanmar',
          format: 'SRT',
          objectKey: 'subtitles/movie-1/old-sub.srt',
          isDefault: true,
        },
      ]);
      minioService.listKeys.mockImplementation(async (prefix: string) =>
        prefix === 'videos/movie-1/'
          ? oldVideoKeys
          : prefix === 'subtitles/movie-1/'
            ? oldSubtitleKeys
            : [],
      );
    };

    /** Nothing about the title — objects, Video, Subtitle, Movie — was written. */
    const expectOldTitleUntouched = () => {
      expect(minioService.copyObject).not.toHaveBeenCalled();
      expect(minioService.deleteKeys).not.toHaveBeenCalled();
      expect(prisma.video.update).not.toHaveBeenCalled();
      expect(prisma.video.create).not.toHaveBeenCalled();
      expect(prisma.subtitle.deleteMany).not.toHaveBeenCalled();
      expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
      expect(prisma.movie.update).not.toHaveBeenCalled();
      expect(prisma.movie.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    };

    describe('beginReplace', () => {
      it('throws NotFoundException when the movie does not exist', async () => {
        prisma.movie.findUnique.mockResolvedValue(null);

        await expect(service.beginReplace('movie-1')).rejects.toThrow(
          NotFoundException,
        );
        expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      });

      it.each([
        MovieStatus.PUBLISHED,
        MovieStatus.READY_TO_PUBLISH,
        MovieStatus.FAILED,
      ])(
        'opens for a %s movie: clears the staging prefix, hands back the resourceType, writes nothing',
        async (status) => {
          liveTitle(status);

          const result = await service.beginReplace('movie-1');

          expect(result).toEqual({
            movieId: 'movie-1',
            resourceType: 'movie-replace',
            stagingPrefix: STAGING,
          });
          expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
          expectOldTitleUntouched();
        },
      );

      it.each([
        MovieStatus.UPLOADING,
        MovieStatus.PROCESSING,
        MovieStatus.DRAFT,
        MovieStatus.ARCHIVED,
      ])('refuses with ConflictException for a %s movie', async (status) => {
        liveTitle(status);

        await expect(service.beginReplace('movie-1')).rejects.toThrow(
          ConflictException,
        );
        expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      });

      it('refuses with ConflictException while the current video is actively transcoding', async () => {
        liveTitle();
        processingService.isActivelyProcessing.mockReturnValue(true);

        await expect(service.beginReplace('movie-1')).rejects.toThrow(
          ConflictException,
        );
        expect(processingService.isActivelyProcessing).toHaveBeenCalledWith(
          'video-1',
        );
        expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      });

      it('opens for a title that has no Video row yet at all', async () => {
        prisma.movie.findUnique.mockResolvedValue(publishedMovie);
        videosService.findLatestForMovie.mockResolvedValue(null);

        await expect(service.beginReplace('movie-1')).resolves.toMatchObject({
          resourceType: 'movie-replace',
        });
      });
    });

    describe('cancelReplace', () => {
      it('deletes only the staging prefix', async () => {
        liveTitle();

        await service.cancelReplace('movie-1');

        expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
        expectOldTitleUntouched();
      });

      it('throws NotFoundException when the movie does not exist', async () => {
        prisma.movie.findUnique.mockResolvedValue(null);

        await expect(service.cancelReplace('movie-1')).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe('finalizeReplace', () => {
      it('throws NotFoundException when the movie does not exist', async () => {
        prisma.movie.findUnique.mockResolvedValue(null);

        await expect(
          service.finalizeReplace('movie-1', dto, ACTOR),
        ).rejects.toThrow(NotFoundException);
      });

      it.each([
        MovieStatus.UPLOADING,
        MovieStatus.PROCESSING,
        MovieStatus.DRAFT,
        MovieStatus.ARCHIVED,
      ])(
        'refuses with ConflictException and touches nothing when the movie is %s',
        async (status) => {
          liveTitle(status);

          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow(ConflictException);

          expect(minioService.objectExists).not.toHaveBeenCalled();
          expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
          expectOldTitleUntouched();
        },
      );

      it('refuses with ConflictException while the current video is actively transcoding', async () => {
        liveTitle();
        processingService.isActivelyProcessing.mockReturnValue(true);

        await expect(
          service.finalizeReplace('movie-1', dto, ACTOR),
        ).rejects.toThrow(ConflictException);
        expectOldTitleUntouched();
      });

      it(
        'an invalid bundle structure is a 400 that cleans the staging and leaves the old video, ' +
          'its subtitles and the movie status exactly as they were',
        async () => {
          liveTitle();

          await expect(
            service.finalizeReplace(
              'movie-1',
              { relativePaths: ['hls/master.m3u8'] }, // no original, no rendition
              ACTOR,
            ),
          ).rejects.toThrow(BadRequestException);

          expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
          expect(minioService.objectExists).not.toHaveBeenCalled();
          expect(minioService.listKeys).not.toHaveBeenCalled();
          expectOldTitleUntouched();
        },
      );

      it(
        'a required file missing from the STAGING prefix is a 400 that cleans the staging and ' +
          'leaves the old video untouched — the client is never trusted about what it uploaded',
        async () => {
          liveTitle();
          minioService.objectExists.mockImplementation(
            async (key: string) =>
              key !== 'temp/video-replace/movie-1/hls/480p/index.m3u8',
          );

          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow('missing staged files: hls/480p/index.m3u8');

          // Every check is against the staging, never the live keys.
          for (const key of minioService.objectExists.mock.calls.map(
            ([k]) => k as string,
          )) {
            expect(key.startsWith(STAGING)).toBe(true);
          }
          expect(minioService.objectExists).toHaveBeenCalledWith(
            'temp/video-replace/movie-1/subtitles/english.vtt',
          );
          expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
          expect(minioService.listKeys).not.toHaveBeenCalled();
          expectOldTitleUntouched();
        },
      );

      describe('the swap on a PUBLISHED title', () => {
        beforeEach(() => {
          liveTitle();
          videoDurationService.recoverHlsDurationSeconds.mockResolvedValue(
            6120,
          );
          subtitlesService.createFromExistingKey.mockResolvedValue({
            id: 'sub-new',
          });
        });

        it('copies the HLS package into a FRESH hls/v-<tag>/ folder and the rest to the key a fresh upload would get, with the master strictly LAST', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          const copies = minioService.copyObject.mock.calls as [
            string,
            string,
          ][];
          expect(copies).toHaveLength(replacePaths.length);
          // Staged key -> final key. hls/** is re-rooted under the versioned
          // package (the cache servers hold the OLD segment keys for 7 days,
          // so a same-named 720p/segment_000.ts must never be reused);
          // the original and the subtitle source keep their un-versioned
          // keys, subtitles leaving videos/ for subtitles/.
          expect(copies).toContainEqual([
            'temp/video-replace/movie-1/original.mkv',
            'videos/movie-1/original.mkv',
          ]);
          expect(copies).toContainEqual([
            'temp/video-replace/movie-1/hls/720p/segment_000.ts',
            `${PACKAGE}/720p/segment_000.ts`,
          ]);
          expect(copies).toContainEqual([
            'temp/video-replace/movie-1/hls/720p/index.m3u8',
            `${PACKAGE}/720p/index.m3u8`,
          ]);
          expect(copies).toContainEqual([
            'temp/video-replace/movie-1/subtitles/english.vtt',
            'subtitles/movie-1/english.vtt',
          ]);
          // Not one HLS object lands on the un-versioned keys the old
          // package (and the cache) still hold.
          for (const [, dst] of copies) {
            expect(dst).not.toMatch(/^videos\/movie-1\/hls\/(?!v-test01\/)/);
          }
          // Order is by PHASE: every segment, subtitle source and the
          // original land before any rendition playlist, and the master
          // comes strictly last — so a playlist never names a file that is
          // not at its final key yet.
          const finals = copies.map(([, dst]) => dst);
          expect(finals.at(-1)).toBe(NEW_MASTER);
          const isPlaylist = (key: string) =>
            key.includes('/hls/') && key.endsWith('/index.m3u8');
          const firstPlaylist = finals.findIndex(isPlaylist);
          const lastNonPlaylist = finals
            .slice(0, -1) // the master
            .reduce((last, key, i) => (isPlaylist(key) ? last : i), -1);
          expect(firstPlaylist).toBeGreaterThan(-1);
          expect(lastNonPlaylist).toBeLessThan(firstPlaylist);
        });

        it('deletes the WHOLE old HLS package (master, every rendition, subs/) plus the old original and subtitle source — nothing of it is reused', async () => {
          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(minioService.listKeys).toHaveBeenCalledWith('videos/movie-1/');
          expect(minioService.listKeys).toHaveBeenCalledWith(
            'subtitles/movie-1/',
          );
          expect(minioService.deleteKeys).toHaveBeenCalledTimes(1);
          // The un-versioned hls/ keys go in full — the 720p the new bundle
          // ALSO carries included, because the new 720p lives in v-test01/.
          // That is what stops a cache server's 7-day copy of the old
          // segment_000.ts from ever being served for the new playlist.
          expect(minioService.deleteKeys.mock.calls[0][0]).toEqual([
            'videos/movie-1/original.mp4',
            'videos/movie-1/hls/master.m3u8',
            'videos/movie-1/hls/720p/index.m3u8',
            'videos/movie-1/hls/720p/segment_000.ts',
            'videos/movie-1/hls/1080p/index.m3u8',
            'videos/movie-1/hls/1080p/segment_000.ts',
            'videos/movie-1/hls/subs/old-sub.vtt',
            'videos/movie-1/hls/subs/old-sub.m3u8',
            'subtitles/movie-1/old-sub.srt',
          ]);
          expect(result.deletedObjects).toBe(9);
          expect(result.copiedObjects).toBe(replacePaths.length);
        });

        it('snapshots the old keys BEFORE copying, so a same-named key that was overwritten (original, subtitle source) is never deleted', async () => {
          // Same container and the same subtitle filename as the new bundle:
          // both are copied over in place, and must survive the sweep.
          minioService.listKeys.mockImplementation(async (prefix: string) =>
            prefix === 'videos/movie-1/'
              ? [
                  'videos/movie-1/original.mkv',
                  'videos/movie-1/hls/master.m3u8',
                ]
              : prefix === 'subtitles/movie-1/'
                ? ['subtitles/movie-1/english.vtt']
                : [],
          );

          await service.finalizeReplace('movie-1', dto, ACTOR);

          const listOrder = minioService.listKeys.mock.invocationCallOrder[0];
          const firstCopyOrder =
            minioService.copyObject.mock.invocationCallOrder[0];
          expect(listOrder).toBeLessThan(firstCopyOrder);
          expect(minioService.deleteKeys.mock.calls[0][0]).toEqual([
            'videos/movie-1/hls/master.m3u8',
          ]);
        });

        it('a SECOND replace mints a new tag: the previous v-<tag> package is deleted as stale and the new one is untouched', async () => {
          const previous = 'videos/movie-1/hls/v-old111';
          videosService.findLatestForMovie.mockResolvedValue({
            ...servedVideo,
            hlsMasterPath: `${previous}/master.m3u8`,
            renditions: [
              {
                resolution: '720p',
                playlistPath: `${previous}/720p/index.m3u8`,
              },
            ],
          });
          minioService.listKeys.mockImplementation(async (prefix: string) =>
            prefix === 'videos/movie-1/'
              ? [
                  'videos/movie-1/original.mkv',
                  `${previous}/master.m3u8`,
                  `${previous}/720p/index.m3u8`,
                  `${previous}/720p/segment_000.ts`,
                  `${previous}/subs/sub-a.vtt`,
                  `${previous}/subs/sub-a.m3u8`,
                ]
              : [],
          );

          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(minioService.deleteKeys.mock.calls[0][0]).toEqual([
            `${previous}/master.m3u8`,
            `${previous}/720p/index.m3u8`,
            `${previous}/720p/segment_000.ts`,
            `${previous}/subs/sub-a.vtt`,
            `${previous}/subs/sub-a.m3u8`,
          ]);
          expect(result.deletedObjects).toBe(5);
          expect(prisma.video.update).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({ hlsMasterPath: NEW_MASTER }),
            }),
          );
        });

        it('mints the tag ONCE per swap — every HLS key of the run shares it', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(tagSpy).toHaveBeenCalledTimes(1);
          const hlsFinals = (
            minioService.copyObject.mock.calls as [string, string][]
          )
            .map(([, dst]) => dst)
            .filter((key) => key.includes('/hls/'));
          expect(hlsFinals.length).toBeGreaterThan(0);
          for (const key of hlsFinals) {
            expect(key.startsWith(`${PACKAGE}/`)).toBe(true);
          }
        });

        it('rewrites the served Video row IN PLACE — same id, READY, new paths/renditions/duration, failureReason cleared', async () => {
          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(prisma.$transaction).toHaveBeenCalledTimes(1);
          expect(prisma.video.update).toHaveBeenCalledWith({
            where: { id: 'video-1' },
            data: {
              status: VideoStatus.READY,
              originalFilename: 'original.mkv',
              originalPath: 'videos/movie-1/original.mkv',
              // The row is the ONLY record of which package is live:
              // playback, diagnosis and the subtitle publisher read these.
              hlsMasterPath: NEW_MASTER,
              renditions: [
                {
                  resolution: '480p',
                  playlistPath: `${PACKAGE}/480p/index.m3u8`,
                },
                {
                  resolution: '720p',
                  playlistPath: `${PACKAGE}/720p/index.m3u8`,
                },
              ],
              resolution: null,
              duration: 6120,
              failureReason: null,
            },
          });
          expect(prisma.video.create).not.toHaveBeenCalled();
          expect(videosService.create).not.toHaveBeenCalled();
          expect(result).toEqual({
            videoId: 'video-1',
            status: VideoStatus.READY,
            renditions: ['480p', '720p'],
            subtitles: 1,
            durationSeconds: 6120,
            copiedObjects: replacePaths.length,
            deletedObjects: 9,
          });
        });

        it('replaces the Subtitle rows exactly as finalize creates them: deleteMany first, then one createFromExistingKey per staged track', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(prisma.subtitle.deleteMany).toHaveBeenCalledWith({
            where: { videoId: 'video-1' },
          });
          expect(subtitlesService.createFromExistingKey).toHaveBeenCalledTimes(
            1,
          );
          expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith({
            videoId: 'video-1',
            language: 'en',
            label: 'English',
            format: 'VTT',
            objectKey: 'subtitles/movie-1/english.vtt',
          });
          expect(
            prisma.subtitle.deleteMany.mock.invocationCallOrder[0],
          ).toBeLessThan(
            subtitlesService.createFromExistingKey.mock.invocationCallOrder[0],
          );
        });

        it('NEVER writes the Movie row — a PUBLISHED title stays PUBLISHED through the whole swap', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        });

        it('refreshes the runtime from the FINAL (versioned) master and offers it to the Movie through the duration-0 guard, never a blind write', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(
            videoDurationService.recoverHlsDurationSeconds,
          ).toHaveBeenCalledWith(NEW_MASTER);
          // Read after the copy — the duration comes from what viewers will play.
          expect(
            videoDurationService.recoverHlsDurationSeconds.mock
              .invocationCallOrder[0],
          ).toBeGreaterThan(
            minioService.copyObject.mock.invocationCallOrder.at(-1)!,
          );
          expect(
            videoDurationService.fillMovieDurationIfUnknown,
          ).toHaveBeenCalledWith('movie-1', 6120);
        });

        it('leaves the Movie runtime alone when nothing could be recovered', async () => {
          videoDurationService.recoverHlsDurationSeconds.mockResolvedValue(
            null,
          );

          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(
            videoDurationService.fillMovieDurationIfUnknown,
          ).not.toHaveBeenCalled();
          expect(prisma.video.update).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({ duration: null }),
            }),
          );
          expect(result.durationSeconds).toBeNull();
        });

        it('clears the staging once the swap is done', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
          expect(
            minioService.deleteByPrefix.mock.invocationCallOrder[0],
          ).toBeGreaterThan(
            minioService.copyObject.mock.invocationCallOrder.at(-1)!,
          );
        });

        it('records ONE movie.video_replace row with the old and new Video + Subtitle snapshots', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(audit.record).toHaveBeenCalledTimes(1);
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'movie.video_replace',
              actor: ACTOR,
              target: { type: 'movie', id: 'movie-1', label: 'Movie 1' },
              before: {
                video: {
                  id: 'video-1',
                  status: VideoStatus.READY,
                  originalFilename: 'original.mp4',
                  originalPath: 'videos/movie-1/original.mp4',
                  hlsMasterPath: 'videos/movie-1/hls/master.m3u8',
                  renditions: servedVideo.renditions,
                  duration: 5400,
                  resolution: null,
                  failureReason: null,
                },
                subtitles: [
                  expect.objectContaining({ id: 'old-sub', label: 'Myanmar' }),
                ],
                movieDuration: 90,
              },
              after: expect.objectContaining({
                video: expect.objectContaining({
                  id: 'video-1',
                  status: VideoStatus.READY,
                  originalPath: 'videos/movie-1/original.mkv',
                  hlsMasterPath: NEW_MASTER,
                  duration: 6120,
                }),
                subtitles: [
                  { id: 'sub-new', language: 'en', label: 'English' },
                ],
              }),
              metadata: expect.objectContaining({
                flow: 'replace',
                outcome: 'replaced',
                renditions: ['480p', '720p'],
                durationSeconds: 6120,
                copiedObjects: replacePaths.length,
                deletedObjects: 9,
                stagingPrefix: STAGING,
                hlsPackagePrefix: PACKAGE,
              }),
            }),
          );
        });

        it('never runs ffmpeg', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(processingService.processVideo).not.toHaveBeenCalled();
        });

        it('a failed stale-delete is a logged leak, not a failed swap', async () => {
          minioService.deleteKeys.mockRejectedValue(new Error('minio hiccup'));

          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(result.status).toBe(VideoStatus.READY);
          expect(result.deletedObjects).toBe(0);
          expect(prisma.video.update).toHaveBeenCalledTimes(1);
        });
      });

      it('works the same on a READY_TO_PUBLISH and a FAILED movie, and the status still never changes', async () => {
        for (const status of [
          MovieStatus.READY_TO_PUBLISH,
          MovieStatus.FAILED,
        ]) {
          jest.clearAllMocks();
          prisma.$transaction.mockImplementation(
            async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
          );
          prisma.video.update.mockResolvedValue({ id: 'video-1' });
          liveTitle(status);

          const result = await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(result.videoId).toBe('video-1');
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        }
      });

      it('creates the Video row when the title never had one (READY, same fields), instead of updating', async () => {
        prisma.movie.findUnique.mockResolvedValue(publishedMovie);
        videosService.findLatestForMovie.mockResolvedValue(null);
        minioService.listKeys.mockResolvedValue([]);

        const result = await service.finalizeReplace('movie-1', dto, ACTOR);

        expect(prisma.video.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            movieId: 'movie-1',
            status: VideoStatus.READY,
            originalPath: 'videos/movie-1/original.mkv',
            hlsMasterPath: NEW_MASTER,
          }),
        });
        expect(prisma.video.update).not.toHaveBeenCalled();
        expect(prisma.subtitle.findMany).not.toHaveBeenCalled();
        expect(prisma.subtitle.deleteMany).toHaveBeenCalledWith({
          where: { videoId: 'video-new' },
        });
        expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith(
          expect.objectContaining({ videoId: 'video-new' }),
        );
        expect(result.videoId).toBe('video-new');
        expect(minioService.deleteKeys).toHaveBeenCalledWith([]);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            before: expect.objectContaining({ video: null, subtitles: [] }),
          }),
        );
      });

      describe('a copy failing mid-swap — the one partial-state case', () => {
        beforeEach(() => {
          liveTitle();
          minioService.copyObject.mockImplementation(
            async (src: string, dst: string) => {
              if (dst === `${PACKAGE}/480p/segment_000.ts`) {
                throw new Error('connection reset');
              }
            },
          );
        });

        it('answers 502, leaves the served Video untouched (the old package still plays), sweeps the half-written folder, and touches nothing else', async () => {
          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow(BadGatewayException);

          // The old package is intact in its own folder and the row still
          // points at it — nothing is marked FAILED any more.
          expect(prisma.video.update).not.toHaveBeenCalled();
          // The orphan-to-be is swept; the staging is not.
          expect(minioService.deleteByPrefix).toHaveBeenCalledWith(
            `${PACKAGE}/`,
          );
          expect(minioService.deleteByPrefix).not.toHaveBeenCalledWith(STAGING);
          // The master was never written, no stale delete, no row rewrite,
          // no subtitles, no movie write.
          expect(minioService.copyObject).not.toHaveBeenCalledWith(
            expect.anything(),
            NEW_MASTER,
          );
          expect(minioService.deleteKeys).not.toHaveBeenCalled();
          expect(prisma.$transaction).not.toHaveBeenCalled();
          expect(prisma.subtitle.deleteMany).not.toHaveBeenCalled();
          expect(subtitlesService.createFromExistingKey).not.toHaveBeenCalled();
          expect(prisma.movie.update).not.toHaveBeenCalled();
          expect(prisma.movie.updateMany).not.toHaveBeenCalled();
        });

        it('KEEPS the staging so finalize-replace can be retried, and records the interruption', async () => {
          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow('replace interrupted during copy');

          expect(minioService.deleteByPrefix).not.toHaveBeenCalledWith(STAGING);
          expect(audit.record).toHaveBeenCalledTimes(1);
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'movie.video_replace',
              metadata: expect.objectContaining({
                flow: 'replace',
                outcome: 'interrupted',
                failedKey: `${PACKAGE}/480p/segment_000.ts`,
                copiedObjects: expect.any(Number),
              }),
            }),
          );
        });

        it('with no Video row — still 502, still audited, nothing written', async () => {
          videosService.findLatestForMovie.mockResolvedValue(null);

          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow(BadGatewayException);

          expect(prisma.video.update).not.toHaveBeenCalled();
          expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
              metadata: expect.objectContaining({ outcome: 'interrupted' }),
            }),
          );
        });
      });

      it('three parallel finalize-replace calls for one movie join a single run', async () => {
        liveTitle();

        const results = await Promise.all([
          service.finalizeReplace('movie-1', dto, ACTOR),
          service.finalizeReplace('movie-1', dto, ACTOR),
          service.finalizeReplace('movie-1', dto, ACTOR),
        ]);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(minioService.copyObject).toHaveBeenCalledTimes(
          replacePaths.length,
        );
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(results[0]).toBe(results[1]);
        expect(results[1]).toBe(results[2]);
      });
    });

    describe('hlsVersionTag — the real one, unpinned', () => {
      it('is 8 lowercase hex characters, different on every call', () => {
        tagSpy.mockRestore();
        const mint = () =>
          (
            service as unknown as { hlsVersionTag: () => string }
          ).hlsVersionTag();

        const tags = new Set(Array.from({ length: 50 }, mint));

        for (const tag of tags) expect(tag).toMatch(/^[0-9a-f]{8}$/);
        expect(tags.size).toBe(50);
      });
    });
  });

  describe('saveImage', () => {
    it('files the image in the folder its purpose names — the purpose is never guessed or defaulted', async () => {
      const url = await service.saveImage(
        'actor',
        'portrait.png',
        Buffer.from('bytes'),
      );

      expect(storageService.imageObjectKey).toHaveBeenCalledWith(
        'actor',
        expect.any(String),
        '.png',
      );
      expect(minioService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^images\/actor\/[0-9a-f-]{36}\.png$/),
        expect.any(Buffer),
      );
      expect(url).toMatch(/^https:\/\/cdn\.example\/images\/actor\//);
    });

    it('keeps every purpose in its own folder', async () => {
      await service.saveImage('payment', 'kbzpay.webp', Buffer.from('bytes'));

      expect(minioService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining('images/payment/'),
        expect.any(Buffer),
      );
    });

    it('falls back to .jpg only for the EXTENSION when the uploaded filename has none', async () => {
      await service.saveImage('movie', 'poster', Buffer.from('bytes'));

      expect(storageService.imageObjectKey).toHaveBeenCalledWith(
        'movie',
        expect.any(String),
        '.jpg',
      );
    });
  });
});
