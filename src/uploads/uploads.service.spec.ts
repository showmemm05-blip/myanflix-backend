import { Test, TestingModule } from '@nestjs/testing';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  access,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import sharp from 'sharp';
import {
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
  UploadsService,
  expectedChunkSize,
} from './uploads.service';
import { DEFAULT_MAX_VIDEO_UPLOAD_BYTES } from './upload-limits';
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
  rename: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
  statfs: jest.fn(),
  writeFile: jest.fn(),
}));
// The merge streams every chunk file into the destination; the fakes below
// (see fakeMergeStreams) stand in for the disk so a complete can run end to
// end without one.
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(),
}));

const accessMock = access as jest.Mock;
const readdirMock = readdir as jest.Mock;
const rmMock = rm as unknown as jest.Mock;
const statfsMock = statfs as unknown as jest.Mock;
const writeFileMock = writeFile as unknown as jest.Mock;
const renameMock = rename as unknown as jest.Mock;
const statMock = stat as unknown as jest.Mock;
const createReadStreamMock = createReadStream as unknown as jest.Mock;
const createWriteStreamMock = createWriteStream as unknown as jest.Mock;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
/** statfs result for `bytes` free, in 4 KB blocks. */
const freeBytes = (bytes: number) => ({
  bavail: BigInt(Math.floor(bytes / 4096)),
  bsize: 4096n,
});

/** Every chunk read yields one byte; the destination swallows everything and finishes on end(). */
function fakeMergeStreams() {
  createReadStreamMock.mockImplementation(() => {
    const stream = new PassThrough();
    process.nextTick(() => stream.end(Buffer.from('x')));
    return stream;
  });
  createWriteStreamMock.mockImplementation(
    () =>
      new Writable({
        write: (_chunk, _encoding, callback) => callback(),
      }),
  );
}

describe('UploadsService', () => {
  let service: UploadsService;
  let prisma: {
    movie: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    video: { update: jest.Mock; create: jest.Mock };
    subtitle: { findMany: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
    uploadSession: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let storageService: {
    root: string;
    chunkPath?: jest.Mock;
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
    listObjects: jest.Mock;
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
  let subtitlesService: {
    createFromExistingKey: jest.Mock;
    publishQuietly: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let resourceTypes: { resolve: jest.Mock; assertFileSizeAllowed: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    // A roomy scratch disk by default — 1 TB free in 4 KB blocks.
    statfsMock.mockResolvedValue({ bavail: 268_435_456n, bsize: 4096n });

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
        findUnique: jest.fn(),
        // No other session open for the movie unless a case says so.
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
    );
    storageService = {
      root: '/storage',
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
      listObjects: jest.fn().mockResolvedValue([]),
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
      // A promise, as the real one returns: both fire-and-forget call sites
      // hang their STR-009 catch on it.
      processVideo: jest.fn().mockResolvedValue(undefined),
      isActivelyProcessing: jest.fn().mockReturnValue(false),
      reserve: jest.fn().mockReturnValue(true),
      release: jest.fn(),
    };
    subtitlesService = {
      createFromExistingKey: jest.fn().mockResolvedValue({ id: 'subtitle-1' }),
      publishQuietly: jest.fn().mockResolvedValue(true),
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
      // The real budget is proven in resource-upload-type.registry.spec.ts;
      // this mirrors its movie rule so initUpload's refusal is observable.
      assertFileSizeAllowed: jest.fn((_type: string, filesize: number) => {
        if (filesize > DEFAULT_MAX_VIDEO_UPLOAD_BYTES)
          throw new BadRequestException('too big');
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

      await expect(service.initUpload(ACTOR, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('creates a brand-new session when no in-progress one matches', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        status: MovieStatus.DRAFT,
      });
      prisma.uploadSession.findFirst.mockResolvedValue(null);
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-1' });
      prisma.uploadSession.update.mockResolvedValue({});

      const result = await service.initUpload(ACTOR, dto);

      expect(prisma.uploadSession.create).toHaveBeenCalled();
      expect(result.uploadId).toBe('session-1');
      expect(result.uploadedChunks).toEqual([]);
    });

    it(
      'resumes an existing in-progress session for the same movie/filename/size instead of ' +
        'starting a new one — this is what lets a retry skip chunks it already sent',
      async () => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.DRAFT,
        });
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

        const result = await service.initUpload(ACTOR, dto);

        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
        expect(result.uploadId).toBe('session-existing');
        expect(result.uploadedChunks).toEqual([0, 2]); // sorted, 'merged' excluded
      },
    );

    it('reports no uploaded chunks yet when the session folder does not exist on disk (e.g. right after creation)', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        status: MovieStatus.DRAFT,
      });
      prisma.uploadSession.findFirst.mockResolvedValue({
        id: 'session-existing',
        chunkSize: 5 * 1024 * 1024,
        totalChunks: 3,
      });
      readdirMock.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await service.initUpload(ACTOR, dto);

      expect(result.uploadedChunks).toEqual([]);
    });

    it('only matches sessions with an exact filename+filesize match (a different file for the same movie starts fresh)', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        status: MovieStatus.DRAFT,
      });
      prisma.uploadSession.findFirst.mockResolvedValue(null); // Prisma's own where clause enforces the match
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-2' });
      prisma.uploadSession.update.mockResolvedValue({});

      await service.initUpload(ACTOR, dto);

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
        // A bundle file only ever lands on a placeholder still being filled.
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.UPLOADING,
        });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-3' });
        prisma.uploadSession.update.mockResolvedValue({});

        await service.initUpload(ACTOR, {
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

    describe('state gate — a direct upload only ever targets a title nobody can watch yet (M-22)', () => {
      const session = () => {
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-new' });
        prisma.uploadSession.update.mockResolvedValue({});
      };

      it.each([
        MovieStatus.PUBLISHED,
        MovieStatus.READY_TO_PUBLISH,
        MovieStatus.ARCHIVED,
        MovieStatus.PROCESSING,
      ])(
        'refuses a classic upload for a %s movie with 409 pointing at movie-replace — no session, no directory',
        async (status) => {
          prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
          session();

          const attempt = service.initUpload(ACTOR, dto);
          await expect(attempt).rejects.toThrow(ConflictException);
          await expect(attempt).rejects.toThrow(/movie-replace/);
          expect(prisma.uploadSession.create).not.toHaveBeenCalled();
          expect(storageService.ensureDir).not.toHaveBeenCalled();
        },
      );

      it.each([MovieStatus.DRAFT, MovieStatus.UPLOADING, MovieStatus.FAILED])(
        'lets the classic flow start for a %s movie (DRAFT is where POST /movies leaves a new title)',
        async (status) => {
          prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
          session();

          await expect(service.initUpload(ACTOR, dto)).resolves.toMatchObject({
            uploadId: 'session-new',
          });
        },
      );

      it.each([
        MovieStatus.PUBLISHED,
        MovieStatus.DRAFT,
        MovieStatus.READY_TO_PUBLISH,
      ])(
        'refuses a BUNDLE file (relativePath) for a %s movie — it would land on the live keys',
        async (status) => {
          prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
          session();

          await expect(
            service.initUpload(ACTOR, {
              ...dto,
              relativePath: 'hls/master.m3u8',
            }),
          ).rejects.toThrow(ConflictException);
          expect(prisma.uploadSession.create).not.toHaveBeenCalled();
        },
      );

      it.each([MovieStatus.UPLOADING, MovieStatus.FAILED])(
        'lets a bundle file through for a %s movie',
        async (status) => {
          prisma.movie.findUnique.mockResolvedValue({ id: 'movie-1', status });
          session();

          await expect(
            service.initUpload(ACTOR, {
              ...dto,
              relativePath: 'hls/master.m3u8',
            }),
          ).resolves.toMatchObject({ uploadId: 'session-new' });
        },
      );
    });

    describe('size budget and disk room (M-23)', () => {
      beforeEach(() => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.DRAFT,
        });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-new' });
        prisma.uploadSession.update.mockResolvedValue({});
      });

      it('refuses a filesize over the video budget before any session exists — the chunk count can no longer run into the millions', async () => {
        await expect(
          service.initUpload(ACTOR, {
            ...dto,
            filesize: DEFAULT_MAX_VIDEO_UPLOAD_BYTES + 1,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(resourceTypes.assertFileSizeAllowed).toHaveBeenCalledWith(
          'movie',
          DEFAULT_MAX_VIDEO_UPLOAD_BYTES + 1,
          'movie.mp4',
        );
        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
      });

      it('refuses with 507 when the scratch disk could not hold the file plus the reserve', async () => {
        // 1 GB free; the file is 500 MB and 2 GB must stay spare.
        statfsMock.mockResolvedValue({ bavail: 262_144n, bsize: 4096n });

        const attempt = service.initUpload(ACTOR, {
          ...dto,
          filesize: 500 * 1024 * 1024,
        });
        await expect(attempt).rejects.toThrow(HttpException);
        await expect(attempt).rejects.toMatchObject({ status: 507 });
        expect(statfsMock).toHaveBeenCalledWith('/storage');
        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
      });

      it('lets the session through when the disk has room for the file and the reserve', async () => {
        // 3 GB free, 500 MB file, 2 GB reserve.
        statfsMock.mockResolvedValue({ bavail: 786_432n, bsize: 4096n });

        await expect(
          service.initUpload(ACTOR, { ...dto, filesize: 500 * 1024 * 1024 }),
        ).resolves.toMatchObject({ uploadId: 'session-new' });
      });

      it('checks the session PEAK — chunks plus the merged copy — so a file the disk could hold once but not twice is refused with 507', async () => {
        // 3 GB free, 700 MB file: 700 MB + 2 GB fits, 2 x 700 MB + 2 GB does
        // not. The chunks are still on disk while the merge writes its
        // copy, so the single-size check used to pass this and then die
        // with ENOSPC in the merge.
        statfsMock.mockResolvedValue(freeBytes(3 * GB));

        const attempt = service.initUpload(ACTOR, {
          ...dto,
          filesize: 700 * MB,
        });
        await expect(attempt).rejects.toMatchObject({ status: 507 });
        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
      });

      it('fails open (with a warning) when the free space cannot be read at all', async () => {
        statfsMock.mockRejectedValue(
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );

        await expect(service.initUpload(ACTOR, dto)).resolves.toMatchObject({
          uploadId: 'session-new',
        });
      });

      it('does not re-check the disk for a resumed session', async () => {
        prisma.uploadSession.findFirst.mockResolvedValue({
          id: 'session-existing',
          chunkSize: 5 * 1024 * 1024,
          totalChunks: 3,
        });
        readdirMock.mockResolvedValue([]);
        statfsMock.mockResolvedValue({ bavail: 0n, bsize: 4096n });

        await expect(service.initUpload(ACTOR, dto)).resolves.toMatchObject({
          uploadId: 'session-existing',
        });
        expect(statfsMock).not.toHaveBeenCalled();
      });
    });

    describe('open-session cap per movie (M-23)', () => {
      beforeEach(() => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.UPLOADING,
        });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-new' });
      });

      it('refuses the 33rd open session for one movie with 409 — before the disk is even looked at', async () => {
        prisma.uploadSession.count.mockResolvedValue(32);

        const attempt = service.initUpload(ACTOR, dto);
        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.toThrow(/limit is 32/);
        expect(prisma.uploadSession.count).toHaveBeenCalledWith({
          where: {
            movieId: 'movie-1',
            status: UploadStatus.IN_PROGRESS,
            createdAt: { gte: expect.any(Date) },
          },
        });
        expect(statfsMock).not.toHaveBeenCalled();
        expect(prisma.uploadSession.create).not.toHaveBeenCalled();
      });

      it('only counts sessions younger than the abandoned-session window (48 h) — an old IN_PROGRESS row never blocks a new upload', async () => {
        prisma.uploadSession.count.mockResolvedValue(31);
        const before = Date.now();

        await expect(service.initUpload(ACTOR, dto)).resolves.toMatchObject({
          uploadId: 'session-new',
        });
        const { gte } = prisma.uploadSession.count.mock.calls[0][0].where
          .createdAt as { gte: Date };
        const windowMs = before - gte.getTime();
        expect(windowMs).toBeGreaterThanOrEqual(48 * 60 * 60 * 1000 - 1000);
        expect(windowMs).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 5000);
      });

      it('can be raised or lowered through UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE', async () => {
        const previous = process.env.UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE;
        process.env.UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE = '2';
        try {
          prisma.uploadSession.count.mockResolvedValue(2);
          await expect(service.initUpload(ACTOR, dto)).rejects.toThrow(
            /limit is 2/,
          );
        } finally {
          if (previous === undefined)
            delete process.env.UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE;
          else process.env.UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE = previous;
        }
      });

      it('never applies to a RESUMED session — picking an upload back up opens nothing new', async () => {
        prisma.uploadSession.findFirst.mockResolvedValue({
          id: 'session-existing',
          chunkSize: 5 * MB,
          totalChunks: 3,
        });
        readdirMock.mockResolvedValue([]);
        prisma.uploadSession.count.mockResolvedValue(999);

        await expect(service.initUpload(ACTOR, dto)).resolves.toMatchObject({
          uploadId: 'session-existing',
        });
        expect(prisma.uploadSession.count).not.toHaveBeenCalled();
      });
    });

    describe('a bundle-file session is recorded the moment it opens (M-22)', () => {
      beforeEach(() => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.UPLOADING,
          title: 'Big Film',
          seriesId: null,
        });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-new' });
      });

      it('writes one movie.upload_chunked row per file — who, which title, which key — never per chunk', async () => {
        await service.initUpload(ACTOR, {
          ...dto,
          filename: 'index.m3u8',
          relativePath: 'hls/720p/index.m3u8',
        });

        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledWith({
          action: 'movie.upload_chunked',
          actor: ACTOR,
          target: { type: 'movie', id: 'movie-1', label: 'Big Film' },
          metadata: {
            uploadId: 'session-new',
            relativePath: 'hls/720p/index.m3u8',
            key: 'videos/movie-1/hls/720p/index.m3u8',
            fileSize: dto.filesize,
            totalChunks: 2,
          },
        });
      });

      it('carries the seriesId for an episode, like every other movie row', async () => {
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.UPLOADING,
          title: 'Ep 1',
          seriesId: 'series-9',
        });

        await service.initUpload(ACTOR, {
          ...dto,
          relativePath: 'subtitles/english.vtt',
        });

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              seriesId: 'series-9',
              key: 'subtitles/movie-1/english.vtt',
            }),
          }),
        );
      });

      it('records nothing for a CLASSIC session — its row is movie.upload at complete, as before', async () => {
        await service.initUpload(ACTOR, dto);

        expect(audit.record).not.toHaveBeenCalled();
      });

      it('records nothing when an existing session is resumed — the row was written when it opened', async () => {
        prisma.uploadSession.findFirst.mockResolvedValue({
          id: 'session-existing',
          chunkSize: 5 * MB,
          totalChunks: 3,
        });
        readdirMock.mockResolvedValue([]);

        await service.initUpload(ACTOR, {
          ...dto,
          relativePath: 'hls/720p/index.m3u8',
        });

        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    it('classic single-file requests (no relativePath) match null, not undefined — unchanged behavior', async () => {
      prisma.movie.findUnique.mockResolvedValue({
        id: 'movie-1',
        status: MovieStatus.DRAFT,
      });
      prisma.uploadSession.findFirst.mockResolvedValue(null);
      prisma.uploadSession.create.mockResolvedValue({ id: 'session-4' });
      prisma.uploadSession.update.mockResolvedValue({});

      await service.initUpload(ACTOR, dto); // no relativePath

      expect(prisma.uploadSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ relativePath: null }),
        }),
      );
    });
  });

  describe('saveChunk — every chunk must be exactly as long as the session says (M-23)', () => {
    const chunkSize = 5 * 1024 * 1024;
    const session = {
      id: 'session-1',
      status: UploadStatus.IN_PROGRESS,
      fileSize: BigInt(2 * chunkSize + 1234),
      chunkSize,
      totalChunks: 3,
    };

    beforeEach(() => {
      prisma.uploadSession.findUnique = jest.fn().mockResolvedValue(session);
      storageService.chunkPath = jest.fn(
        (id: string, n: number) => `/storage/temp/uploads/${id}/chunk_${n}`,
      );
      writeFileMock.mockResolvedValue(undefined);
    });

    it('rejects a 10 MB body for a 5 MB chunk — the disk can no longer hold more than the declared filesize', async () => {
      await expect(
        service.saveChunk('session-1', 0, Buffer.alloc(10 * 1024 * 1024)),
      ).rejects.toThrow(/Chunk 0 is \d+ bytes — expected exactly 5242880/);
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('rejects a short middle chunk too — the merged file would be corrupt', async () => {
      await expect(
        service.saveChunk('session-1', 1, Buffer.alloc(chunkSize - 1)),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a full-size chunk and, for the LAST chunk, exactly the remainder', async () => {
      await expect(
        service.saveChunk('session-1', 0, Buffer.alloc(chunkSize)),
      ).resolves.toBeUndefined();
      await expect(
        service.saveChunk('session-1', 2, Buffer.alloc(1234)),
      ).resolves.toBeUndefined();
      expect(writeFileMock).toHaveBeenCalledTimes(2);
    });

    it('rejects a last chunk that is longer than the remainder', async () => {
      await expect(
        service.saveChunk('session-1', 2, Buffer.alloc(1235)),
      ).rejects.toThrow(/expected exactly 1234/);
    });

    describe('the disk is checked before EVERY chunk write (M-23)', () => {
      it('refuses with 507 — nothing written — once the disk is down to the reserve, so sessions that each passed init cannot fill it between them', async () => {
        // Five 20 GB sessions open while 100 GB is free: each one sees the
        // same 100 GB and passes init (2 x 20 GB + 2 GB fits five times
        // over). Before the fix their chunks could then write 100 GB of
        // chunks against 100 GB of disk and take Postgres down with it.
        prisma.movie.findUnique.mockResolvedValue({
          id: 'movie-1',
          status: MovieStatus.UPLOADING,
          title: 'Big Film',
          seriesId: null,
        });
        prisma.uploadSession.findFirst.mockResolvedValue(null);
        prisma.uploadSession.create.mockResolvedValue({ id: 'session-x' });
        statfsMock.mockResolvedValue(freeBytes(100 * GB));
        for (let i = 0; i < 5; i += 1) {
          await expect(
            service.initUpload(ACTOR, {
              movieId: 'movie-1',
              filename: `part-${i}.mkv`,
              filesize: 20 * GB,
              relativePath: `hls/1080p/part-${i}.ts`,
            }),
          ).resolves.toMatchObject({ uploadId: 'session-x' });
        }

        // Now the disk is at 2 GB + 4 MB free: a 5 MB chunk would eat into
        // the 2 GB reserve.
        statfsMock.mockResolvedValue(freeBytes(2 * GB + 4 * MB));

        const attempt = service.saveChunk(
          'session-1',
          0,
          Buffer.alloc(chunkSize),
        );
        await expect(attempt).rejects.toThrow(HttpException);
        await expect(attempt).rejects.toMatchObject({ status: 507 });
        expect(writeFileMock).not.toHaveBeenCalled();
      });

      it('writes the chunk while it still fits above the reserve — one statfs per chunk, nothing else', async () => {
        statfsMock.mockResolvedValue(freeBytes(2 * GB + 6 * MB));

        await expect(
          service.saveChunk('session-1', 0, Buffer.alloc(chunkSize)),
        ).resolves.toBeUndefined();
        expect(statfsMock).toHaveBeenCalledTimes(1);
        expect(statfsMock).toHaveBeenCalledWith('/storage');
        expect(writeFileMock).toHaveBeenCalledTimes(1);
      });

      it('checks the disk only AFTER the length check — a tampered chunk never reaches statfs', async () => {
        statfsMock.mockResolvedValue(freeBytes(0));

        await expect(
          service.saveChunk('session-1', 0, Buffer.alloc(chunkSize + 1)),
        ).rejects.toThrow(BadRequestException);
        expect(statfsMock).not.toHaveBeenCalled();
      });

      it('fails open (with a warning) when the free space cannot be read, exactly like init', async () => {
        statfsMock.mockRejectedValue(
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );

        await expect(
          service.saveChunk('session-1', 0, Buffer.alloc(chunkSize)),
        ).resolves.toBeUndefined();
        expect(writeFileMock).toHaveBeenCalledTimes(1);
      });
    });

    it('expectedChunkSize: the chunk size for all but the last, the remainder for the last', () => {
      expect(expectedChunkSize(session, 0)).toBe(chunkSize);
      expect(expectedChunkSize(session, 1)).toBe(chunkSize);
      expect(expectedChunkSize(session, 2)).toBe(1234);
      expect(
        expectedChunkSize({ fileSize: 100, chunkSize, totalChunks: 1 }, 0),
      ).toBe(100);
    });
  });

  describe('completeUpload — the title is re-checked and the merge needs room (M-22, M-23)', () => {
    const chunkSize = 5 * MB;
    const fileSize = 2 * chunkSize + 1234;
    const bundleSession = {
      id: 'session-1',
      status: UploadStatus.IN_PROGRESS,
      movieId: 'movie-1',
      filename: 'index.m3u8',
      fileSize: BigInt(fileSize),
      chunkSize,
      totalChunks: 3,
      relativePath: 'hls/720p/index.m3u8',
    };
    const classicSession = {
      ...bundleSession,
      filename: 'movie.mp4',
      relativePath: null,
    };
    const movie = (status: MovieStatus) => ({
      title: 'Big Film',
      seriesId: null,
      status,
    });

    beforeEach(() => {
      prisma.uploadSession.findUnique.mockResolvedValue(bundleSession);
      // The merged file is the size the session was opened for.
      statMock.mockResolvedValue({ size: fileSize });
      readdirMock.mockResolvedValue(['chunk_0', 'chunk_1', 'chunk_2']);
      rmMock.mockResolvedValue(undefined);
      storageService.chunkPath = jest.fn(
        (id: string, n: number) => `/storage/temp/uploads/${id}/chunk_${n}`,
      );
      fakeMergeStreams();
    });

    it.each([
      MovieStatus.PUBLISHED,
      MovieStatus.READY_TO_PUBLISH,
      MovieStatus.DRAFT,
    ])(
      'refuses a BUNDLE complete with 409 when the movie is %s by now — nothing merged, nothing uploaded, the session failed and its chunks removed',
      async (status) => {
        prisma.movie.findUnique.mockResolvedValue(movie(status));

        const attempt = service.completeUpload('session-1', ACTOR);
        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.toThrow(/movie-replace/);
        expect(createWriteStreamMock).not.toHaveBeenCalled();
        expect(minioService.uploadFile).not.toHaveBeenCalled();
        expect(prisma.uploadSession.update).toHaveBeenCalledWith({
          where: { id: 'session-1' },
          data: { status: UploadStatus.FAILED },
        });
        expect(rmMock).toHaveBeenCalledWith('/storage/temp/uploads/session-1', {
          recursive: true,
          force: true,
        });
      },
    );

    it('refuses a CLASSIC complete with 409 when the movie went live since init — no Video row, no transcode started', async () => {
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.PUBLISHED));

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        ConflictException,
      );
      expect(videosService.create).not.toHaveBeenCalled();
      expect(processingService.processVideo).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses the merge with 507 — and keeps the session resumable — while the merged copy would eat into the reserve', async () => {
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.UPLOADING));
      // 2 GB + 1 MB free for a ~10 MB merged copy on top of a 2 GB reserve.
      statfsMock.mockResolvedValue(freeBytes(2 * GB + 1 * MB));

      const attempt = service.completeUpload('session-1', ACTOR);
      await expect(attempt).rejects.toMatchObject({ status: 507 });
      expect(createWriteStreamMock).not.toHaveBeenCalled();
      expect(minioService.uploadFile).not.toHaveBeenCalled();
      expect(prisma.uploadSession.update).not.toHaveBeenCalled();
      expect(rmMock).not.toHaveBeenCalled();
    });

    it('completes a bundle file for a movie still UPLOADING: merges, uploads to the bundle key, marks COMPLETED, removes the chunks — no second audit row', async () => {
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.UPLOADING));

      await expect(service.completeUpload('session-1', ACTOR)).resolves.toEqual(
        {
          relativePath: 'hls/720p/index.m3u8',
          status: UploadStatus.COMPLETED,
        },
      );
      expect(statfsMock).toHaveBeenCalledTimes(1);
      expect(createReadStreamMock).toHaveBeenCalledTimes(3);
      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/hls/720p/index.m3u8',
        '/storage/temp/uploads/session-1/merged',
      );
      expect(prisma.uploadSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: UploadStatus.COMPLETED },
      });
      expect(rmMock).toHaveBeenCalledWith('/storage/temp/uploads/session-1', {
        recursive: true,
        force: true,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('completes a classic upload for a DRAFT movie as before: Video row, transcode kicked off, movie.upload recorded with the title', async () => {
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.DRAFT));
      videosService.create.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.UPLOADING,
      });

      await expect(service.completeUpload('session-1', ACTOR)).resolves.toEqual(
        { videoId: 'video-1', status: VideoStatus.UPLOADING },
      );
      expect(videosService.create).toHaveBeenCalledWith({
        movieId: 'movie-1',
        originalFilename: 'movie.mp4',
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
      });
      expect(processingService.processVideo).toHaveBeenCalledWith(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'movie.upload',
          actor: ACTOR,
          target: { type: 'movie', id: 'movie-1', label: 'Big Film' },
          metadata: expect.objectContaining({ flow: 'classic', fileSize }),
        }),
      );
    });

    /**
     * The pipeline resumes per tier on object existence, so a classic
     * upload onto a DRAFT/FAILED title that still had an earlier file's
     * archived original and finished tiers under videos/<movieId>/ either
     * published a MIXED package (tiers from two files) or never used the
     * new file at all (STR-003). A fresh upload now starts from an empty
     * prefix; reprocess (below) must keep relying on the resume.
     */
    it('a second classic upload clears the previous package under videos/<movieId>/ before the Video row and the transcode (STR-003)', async () => {
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.DRAFT));

      await service.completeUpload('session-1', ACTOR);

      expect(minioService.deleteByPrefix).toHaveBeenCalledTimes(1);
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(
        'videos/movie-1/',
      );
      const clearedAt = minioService.deleteByPrefix.mock.invocationCallOrder[0];
      expect(clearedAt).toBeLessThan(
        videosService.create.mock.invocationCallOrder[0],
      );
      expect(clearedAt).toBeLessThan(
        processingService.processVideo.mock.invocationCallOrder[0],
      );
    });

    it('a BUNDLE file complete never clears the prefix — it is one file of the package being assembled there', async () => {
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.UPLOADING));

      await service.completeUpload('session-1', ACTOR);

      expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
    });

    it('a storage error while clearing the previous package fails the complete before anything durable changes — the session stays resumable', async () => {
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.DRAFT));
      minioService.deleteByPrefix.mockRejectedValue(new Error('minio down'));

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        'minio down',
      );

      expect(videosService.create).not.toHaveBeenCalled();
      expect(prisma.uploadSession.update).not.toHaveBeenCalled();
      expect(processingService.processVideo).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // The chunks are still there for the retried complete.
      expect(rmMock).not.toHaveBeenCalledWith(
        '/storage/temp/uploads/session-1',
        expect.anything(),
      );
    });

    it("refuses a classic complete with 409 while the title's previous video is still transcoding here — nothing merged, nothing cleared, the session stays resumable", async () => {
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      // The movie stays DRAFT for the whole of a transcode, so the status
      // gate alone lets this through.
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.DRAFT));
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-0',
        status: VideoStatus.PROCESSING,
      });
      processingService.isActivelyProcessing.mockReturnValue(true);

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        ConflictException,
      );

      expect(processingService.isActivelyProcessing).toHaveBeenCalledWith(
        'video-0',
      );
      expect(createWriteStreamMock).not.toHaveBeenCalled();
      expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      expect(videosService.create).not.toHaveBeenCalled();
      expect(prisma.uploadSession.update).not.toHaveBeenCalled();
      expect(rmMock).not.toHaveBeenCalled();
    });

    /**
     * processVideo() is fired and forgotten; a rejection that escaped it
     * used to be an unhandled rejection, which is fatal in Node — the whole
     * API process went down with every other upload in flight (STR-009).
     */
    it('a transcode that rejects after the response is logged, never an unhandled rejection (STR-009)', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      prisma.uploadSession.findUnique.mockResolvedValue(classicSession);
      prisma.movie.findUnique.mockResolvedValue(movie(MovieStatus.DRAFT));
      processingService.processVideo.mockRejectedValue(new Error('db down'));

      await expect(service.completeUpload('session-1', ACTOR)).resolves.toEqual(
        { videoId: 'video-1', status: undefined },
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('escaped the pipeline: db down'),
      );
    });
  });

  // The structure rules validate-external used to report are enforced by
  // finalize itself (the validate-external route was removed as unused —
  // perf audit 2026-10-07); these keep every rule covered.
  describe('bundle structure rules — enforced by finalize', () => {
    const uploadingMovie = {
      id: 'movie-1',
      status: MovieStatus.UPLOADING,
      title: 'Big Film',
      seriesId: null,
    };
    beforeEach(() => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);
    });

    it('refuses a bundle missing its master and every rendition', async () => {
      await expect(
        service.finalizeExternalUpload(
          'movie-1',
          { relativePaths: ['original.mp4'] },
          ACTOR,
        ),
      ).rejects.toThrow(
        'master.m3u8 is missing; no valid rendition folder (240p, 360p, 480p, 720p, or 1080p) with an index.m3u8 was found',
      );
      expect(videosService.create).not.toHaveBeenCalled();
    });

    it('refuses subtitle files that share a filename — both would be stored at the same key', async () => {
      await expect(
        service.finalizeExternalUpload(
          'movie-1',
          {
            relativePaths: [
              'original.mp4',
              'hls/master.m3u8',
              'hls/720p/index.m3u8',
              'subtitles/english.vtt',
              'subtitles/extra/English.vtt',
            ],
          },
          ACTOR,
        ),
      ).rejects.toThrow(
        'subtitle filenames must be unique — "subtitles/extra/English.vtt" and "subtitles/english.vtt" would both be stored as english.vtt',
      );
    });

    it('reports a missing original whatever container the operator used', async () => {
      await expect(
        service.finalizeExternalUpload(
          'movie-1',
          { relativePaths: ['hls/master.m3u8', 'hls/720p/index.m3u8'] },
          ACTOR,
        ),
      ).rejects.toThrow('original.<ext> is missing from the bundle root');
    });

    it('looks a subtitle source up where it was actually uploaded — subtitles/<movieId>/<filename>', async () => {
      videosService.findLatestForMovie.mockResolvedValue(null);
      await service.finalizeExternalUpload(
        'movie-1',
        {
          relativePaths: [
            'original.mp4',
            'hls/master.m3u8',
            'hls/720p/index.m3u8',
            'subtitles/english.vtt',
          ],
        },
        ACTOR,
      );

      expect(minioService.objectExists).toHaveBeenCalledWith(
        'subtitles/movie-1/english.vtt',
      );
      expect(minioService.objectExists).not.toHaveBeenCalledWith(
        'videos/movie-1/subtitles/english.vtt',
      );
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

      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith(
        {
          videoId: 'video-1',
          language: 'en',
          label: 'English',
          format: 'VTT',
          objectKey: 'subtitles/movie-1/english.vtt',
        },
        { publish: false },
      );
      expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith(
        {
          videoId: 'video-1',
          language: 'my',
          label: 'Myanmar',
          format: 'VTT',
          objectKey: 'subtitles/movie-1/myanmar.vtt',
        },
        { publish: false },
      );
      // ONE publish after both rows exist, not one per track.
      expect(subtitlesService.publishQuietly).toHaveBeenCalledTimes(1);
      expect(subtitlesService.publishQuietly).toHaveBeenCalledWith('video-1');
      expect(
        subtitlesService.publishQuietly.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        subtitlesService.createFromExistingKey.mock.invocationCallOrder[1],
      );
    });

    it('does not publish when the bundle carries no subtitles (same as before)', async () => {
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

      expect(subtitlesService.publishQuietly).not.toHaveBeenCalled();
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

    /**
     * The variant order of a master is decided by whoever WRITES it — the
     * Transcoder for a bundle (480p first since 2026-10-12, the same rule
     * as the classic flow's buildMasterPlaylist). Finalize only checks the
     * uploaded master exists and reads its runtime; regenerating it from
     * KNOWN_RENDITIONS would have to invent RESOLUTION and BANDWIDTH values.
     */
    it("trusts the bundle's own master.m3u8 — never writes, regenerates or re-orders one", async () => {
      prisma.movie.findUnique.mockResolvedValue(uploadingMovie);
      minioService.objectExists.mockResolvedValue(true);

      await service.finalizeExternalUpload('movie-1', dto, ACTOR);

      expect(minioService.objectExists).toHaveBeenCalledWith(
        'videos/movie-1/hls/master.m3u8',
      );
      expect(
        videoDurationService.recoverHlsDurationSeconds,
      ).toHaveBeenCalledWith('videos/movie-1/hls/master.m3u8');
      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      expect(minioService.uploadFile).not.toHaveBeenCalled();
      expect(minioService.copyObject).not.toHaveBeenCalled();
      expect(writeFileMock).not.toHaveBeenCalled();
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

    it('never clears videos/<movieId>/ the way a fresh classic upload does — only the versioned folder, when there is one (STR-003)', async () => {
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
        hlsMasterPath: 'videos/movie-1/hls/v-abc123/master.m3u8',
      });

      await service.reprocessVideo('movie-1', ACTOR);

      expect(minioService.deleteByPrefix).toHaveBeenCalledTimes(1);
      expect(minioService.deleteByPrefix).not.toHaveBeenCalledWith(
        'videos/movie-1/',
      );
      expect(processingService.processVideo).toHaveBeenCalledWith(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );
    });

    it('a transcode that rejects after the reprocess response is logged, never an unhandled rejection (STR-009)', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      accessMock.mockResolvedValue(undefined);
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });
      processingService.processVideo.mockRejectedValue(new Error('db down'));

      await expect(service.reprocessVideo('movie-1', ACTOR)).resolves.toEqual({
        videoId: 'video-1',
        status: VideoStatus.PROCESSING,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('escaped the pipeline: db down'),
      );
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

    it('answers 400, not a NoSuchKey 500, when the kept local original has since been swept (STR-004)', async () => {
      accessMock.mockRejectedValue(new Error('ENOENT')); // swept after 24 h
      videosService.findLatestForMovie.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.FAILED,
        // Never archived: a local path, not an object key.
        originalPath: '/storage/temp/videos/movie-1/original.mp4',
        originalFilename: 'movie.mp4',
      });

      await expect(service.reprocessVideo('movie-1', ACTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(minioService.downloadFile).not.toHaveBeenCalled();
      expect(processingService.processVideo).not.toHaveBeenCalled();
      // The claim goes back, so a later reprocess is not refused as "active".
      expect(processingService.release).toHaveBeenCalledWith('video-1');
    });

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
      stageFiles(replacePaths);
    };

    /** What the ONE listing of the staging prefix returns: these files, each with a size. */
    const stageFiles = (relativePaths: string[]) => {
      minioService.listObjects.mockImplementation(async (prefix: string) =>
        prefix === STAGING
          ? relativePaths.map((relativePath, i) => ({
              key: `${STAGING}${relativePath}`,
              lastModified: undefined,
              size: 1000 + i,
            }))
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
      // Opening or abandoning a replace is itself recorded (M-22); what must
      // NOT exist is a swap row — nothing was replaced.
      expect(
        audit.record.mock.calls.filter(
          ([input]) =>
            (input as { action: string }).action === 'movie.video_replace',
        ),
      ).toHaveLength(0);
    };

    describe('beginReplace', () => {
      it('throws NotFoundException when the movie does not exist', async () => {
        prisma.movie.findUnique.mockResolvedValue(null);

        await expect(service.beginReplace('movie-1', ACTOR)).rejects.toThrow(
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

          const result = await service.beginReplace('movie-1', ACTOR);

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

        await expect(service.beginReplace('movie-1', ACTOR)).rejects.toThrow(
          ConflictException,
        );
        expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      });

      it('refuses with ConflictException while the current video is actively transcoding', async () => {
        liveTitle();
        processingService.isActivelyProcessing.mockReturnValue(true);

        await expect(service.beginReplace('movie-1', ACTOR)).rejects.toThrow(
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

        await expect(
          service.beginReplace('movie-1', ACTOR),
        ).resolves.toMatchObject({
          resourceType: 'movie-replace',
        });
      });

      it('records who opened the replace on which title (M-22) — nothing is recorded on a refusal', async () => {
        liveTitle();

        await service.beginReplace('movie-1', ACTOR);

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'movie.video_replace_begin',
            actor: ACTOR,
            target: { type: 'movie', id: 'movie-1', label: 'Movie 1' },
            metadata: expect.objectContaining({
              flow: 'replace',
              stagingPrefix: STAGING,
            }),
          }),
        );

        audit.record.mockClear();
        liveTitle(MovieStatus.DRAFT);
        await expect(service.beginReplace('movie-1', ACTOR)).rejects.toThrow(
          ConflictException,
        );
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    describe('cancelReplace', () => {
      it('deletes only the staging prefix', async () => {
        liveTitle();

        await service.cancelReplace('movie-1', ACTOR);

        expect(minioService.deleteByPrefix).toHaveBeenCalledWith(STAGING);
        expectOldTitleUntouched();
      });

      it('records the abandoned attempt against the staff member (M-22)', async () => {
        liveTitle();

        await service.cancelReplace('movie-1', ACTOR);

        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'movie.video_replace_cancel',
            actor: ACTOR,
            target: { type: 'movie', id: 'movie-1', label: 'Movie 1' },
          }),
        );
      });

      it('throws NotFoundException when the movie does not exist', async () => {
        prisma.movie.findUnique.mockResolvedValue(null);

        await expect(service.cancelReplace('movie-1', ACTOR)).rejects.toThrow(
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
          stageFiles(
            replacePaths.filter((path) => path !== 'hls/480p/index.m3u8'),
          );

          await expect(
            service.finalizeReplace('movie-1', dto, ACTOR),
          ).rejects.toThrow('missing staged files: hls/480p/index.m3u8');

          // The check is ONE listing of the staging, never the live keys,
          // and no per-file HEAD.
          expect(minioService.listObjects).toHaveBeenCalledTimes(1);
          expect(minioService.listObjects).toHaveBeenCalledWith(STAGING);
          expect(minioService.objectExists).not.toHaveBeenCalled();
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

        it('copies the staged master.m3u8 as it was uploaded — a server-side CopyObject, never a rewrite or a re-order', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(minioService.copyObject).toHaveBeenCalledWith(
            `${STAGING}hls/master.m3u8`,
            NEW_MASTER,
            expect.any(Number),
          );
          expect(minioService.uploadBuffer).not.toHaveBeenCalled();
          expect(minioService.uploadFile).not.toHaveBeenCalled();
          expect(writeFileMock).not.toHaveBeenCalled();
        });

        it('copies the HLS package into a FRESH hls/v-<tag>/ folder and the rest to the key a fresh upload would get, with the master strictly LAST', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          const copies = (
            minioService.copyObject.mock.calls as [string, string, number][]
          ).map(([src, dst]) => [src, dst]);
          // Every copy carries the size from the staging listing, so
          // copyObject sends no HEAD of its own.
          for (const [src, , size] of minioService.copyObject.mock.calls as [
            string,
            string,
            number,
          ][]) {
            expect(size).toBe(
              1000 + replacePaths.indexOf(src.slice(STAGING.length)),
            );
          }
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
          expect(subtitlesService.createFromExistingKey).toHaveBeenCalledWith(
            {
              videoId: 'video-1',
              language: 'en',
              label: 'English',
              format: 'VTT',
              objectKey: 'subtitles/movie-1/english.vtt',
            },
            { publish: false },
          );
          expect(
            prisma.subtitle.deleteMany.mock.invocationCallOrder[0],
          ).toBeLessThan(
            subtitlesService.createFromExistingKey.mock.invocationCallOrder[0],
          );
          // The new master is published ONCE, after every track exists.
          expect(subtitlesService.publishQuietly).toHaveBeenCalledTimes(1);
          expect(subtitlesService.publishQuietly).toHaveBeenCalledWith(
            'video-1',
          );
          expect(
            subtitlesService.publishQuietly.mock.invocationCallOrder[0],
          ).toBeGreaterThan(
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

        /**
         * The stale delete used to run BEFORE the row swap, so for the
         * length of the delete batches /stream still signed the old master
         * — now gone — and a process dying in between left the title
         * pointing at deleted keys until an admin retried (STR-002).
         */
        it('deletes the stale package only AFTER the Video row points at the new one (STR-002)', async () => {
          await service.finalizeReplace('movie-1', dto, ACTOR);

          expect(prisma.video.update).toHaveBeenCalledTimes(1);
          expect(minioService.deleteKeys).toHaveBeenCalledTimes(1);
          const swappedAt = prisma.video.update.mock.invocationCallOrder[0];
          const deletedAt = minioService.deleteKeys.mock.invocationCallOrder[0];
          expect(swappedAt).toBeLessThan(deletedAt);
          expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
            deletedAt,
          );
          // Every copy still precedes the swap: the row never names a key
          // that is not there yet.
          for (const at of minioService.copyObject.mock.invocationCallOrder) {
            expect(at).toBeLessThan(swappedAt);
          }
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
        stageFiles(replacePaths);

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
          { publish: false },
        );
        expect(subtitlesService.publishQuietly).toHaveBeenCalledWith(
          'video-new',
        );
        expect(result.videoId).toBe('video-new');
        expect(minioService.deleteKeys).toHaveBeenCalledWith([]);
        // Same order as the update path (STR-002): the row first.
        expect(prisma.video.create.mock.invocationCallOrder[0]).toBeLessThan(
          minioService.deleteKeys.mock.invocationCallOrder[0],
        );
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
    // The type is read off the first bytes (see save-image-magic-bytes.spec),
    // so each stub starts like the image it stands for; sharp's refusal to
    // resize a bare header is logged and the bytes are stored as uploaded.
    const PNG_STUB = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const WEBP_STUB = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('files the image in the folder its purpose names — the purpose is never guessed or defaulted', async () => {
      const url = await service.saveImage(
        'actor',
        'portrait.png',
        PNG_STUB,
        ACTOR,
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
      await service.saveImage('payment', 'kbzpay.webp', WEBP_STUB, ACTOR);

      expect(minioService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining('images/payment/'),
        expect.any(Buffer),
      );
    });

    it('records the upload against the staff member with the purpose, key and size (M-22)', async () => {
      await service.saveImage(
        'actor',
        'portrait.png',
        Buffer.concat([PNG_STUB, Buffer.alloc(321 - PNG_STUB.length)]),
        ACTOR,
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'image.upload',
          actor: ACTOR,
          target: expect.objectContaining({ type: 'image', id: null }),
          metadata: expect.objectContaining({
            purpose: 'actor',
            key: expect.stringMatching(/^images\/actor\/[0-9a-f-]{36}\.png$/),
            originalFilename: 'portrait.png',
            fileSize: 321,
          }),
        }),
      );
    });

    it('takes the EXTENSION from the bytes, never from the filename — a JPEG is .jpg whether it was named poster, poster.png or poster.svg', async () => {
      for (const filename of ['poster', 'poster.png', 'poster.svg']) {
        await service.saveImage('movie', filename, JPEG_STUB, ACTOR);
      }

      expect(storageService.imageObjectKey).toHaveBeenCalledTimes(3);
      for (const [purpose, , extension] of storageService.imageObjectKey.mock
        .calls as [string, string, string][]) {
        expect(purpose).toBe('movie');
        expect(extension).toBe('.jpg');
      }
    });

    it('refuses bytes that are not a JPEG / PNG / WebP / GIF with a 400 and stores nothing (SEC-019)', async () => {
      await expect(
        service.saveImage('movie', 'poster.jpg', Buffer.from('bytes'), ACTOR),
      ).rejects.toMatchObject({
        code: IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
        status: 400,
      });

      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('saveImage — artwork is shrunk to a display size before it is stored', () => {
    /** A real encoded image of the given size, made with sharp itself. */
    const makeImage = (
      width: number,
      height: number,
      format: 'jpeg' | 'png' | 'webp',
    ) =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 200, g: 40, b: 40 },
        },
      })
        .toFormat(format)
        .toBuffer();
    const stored = () => minioService.uploadBuffer.mock.calls[0][1] as Buffer;

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('a 4000 px wide portrait JPEG poster comes out at most 1300 px wide (phone title page width) and still JPEG, at the same key and URL', async () => {
      const original = await makeImage(4000, 6000, 'jpeg');

      const url = await service.saveImage(
        'movie',
        'poster.jpg',
        original,
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(1300);
      expect(meta.height).toBe(1950);
      expect(stored().length).toBeLessThan(original.length);
      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(key).toMatch(/^images\/movie\/[0-9a-f-]{36}\.jpg$/);
      expect(url).toBe(`https://cdn.example/${key}`);
      // The audit row keeps both sizes.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            fileSize: stored().length,
            originalSize: original.length,
          }),
        }),
      );
    });

    it('a square 5000 px WebP poster becomes 1300 x 1300 WebP', async () => {
      await service.saveImage(
        'series',
        'poster.webp',
        await makeImage(5000, 5000, 'webp'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 1300, height: 1300 });
    });

    it('a landscape cover keeps up to 1920 px (it fills a desktop hero), and PNG stays PNG', async () => {
      await service.saveImage(
        'movie',
        'cover.png',
        await makeImage(3840, 2160, 'png'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 1920, height: 1080 });
    });

    it('a 3600 x 1880 lottery ticket frame (the 2x print size) is stored byte for byte; wider than 4000 px is brought to 4000', async () => {
      const frame = await makeImage(3600, 1880, 'png');
      await service.saveImage('lottery_frame', 'frame.png', frame, ACTOR);
      expect(stored().equals(frame)).toBe(true);
      const [key] = minioService.uploadBuffer.mock.calls[0] as [string];
      expect(key).toMatch(/^images\/lottery_frame\/[0-9a-f-]{36}\.png$/);

      minioService.uploadBuffer.mockClear();
      await service.saveImage(
        'lottery_frame',
        'frame.png',
        await makeImage(4800, 2507, 'png'),
        ACTOR,
      );
      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 4000, height: 2089 });

      // A draw picture (purpose "lottery") keeps its small cap: the frame's
      // size is the frame folder's alone.
      minioService.uploadBuffer.mockClear();
      await service.saveImage(
        'lottery',
        'picture.png',
        await makeImage(1280, 976, 'png'),
        ACTOR,
      );
      expect((await sharp(stored()).metadata()).width).toBe(1000);
    });

    it('a 4000 px wide portrait actor photo still stops at 1000 px (shown small / blurred, never edge to edge)', async () => {
      await service.saveImage(
        'actor',
        'headshot.jpg',
        await makeImage(4000, 6000, 'jpeg'),
        ACTOR,
      );

      const meta = await sharp(stored()).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: 1000, height: 1500 });
    });

    it('stores an image that is already small enough byte-for-byte as uploaded', async () => {
      const original = await makeImage(800, 1200, 'jpeg');

      await service.saveImage('movie', 'poster.jpg', original, ACTOR);

      expect(stored()).toBe(original);
    });

    it('falls back to the original bytes when sharp cannot read the image (broken file)', async () => {
      const broken = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from('definitely not the rest of a jpeg'),
      ]);

      await expect(
        service.saveImage('movie', 'poster.jpg', broken, ACTOR),
      ).resolves.toMatch(/^https:\/\/cdn\.example\/images\/movie\//);

      expect(stored()).toBe(broken);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            fileSize: broken.length,
            originalSize: broken.length,
          }),
        }),
      );
    });

    it('never touches a purpose that is not artwork (payment logos and QR codes keep every pixel)', async () => {
      const original = await makeImage(3000, 3000, 'png');

      await service.saveImage('payment', 'qr.png', original, ACTOR);

      expect(stored()).toBe(original);
    });

    it('leaves formats other than JPEG / PNG / WebP alone (e.g. GIF)', async () => {
      const gif = await makeImage(3000, 3000, 'png').then((png) =>
        sharp(png).gif().toBuffer(),
      );

      await service.saveImage('movie', 'poster.gif', gif, ACTOR);

      expect(stored()).toBe(gif);
    });
  });

  describe('chunk files are written atomically and the merge is size-checked (media-14)', () => {
    const chunkSize = 5 * MB;
    const fileSize = 2 * chunkSize + 1234;
    const session = {
      id: 'session-1',
      status: UploadStatus.IN_PROGRESS,
      movieId: 'movie-1',
      filename: 'movie.mp4',
      fileSize: BigInt(fileSize),
      chunkSize,
      totalChunks: 3,
      relativePath: null as string | null,
    };

    beforeEach(() => {
      prisma.uploadSession.findUnique.mockResolvedValue(session);
      storageService.chunkPath = jest.fn(
        (id: string, n: number) => `/storage/temp/uploads/${id}/chunk_${n}`,
      );
      statfsMock.mockResolvedValue(freeBytes(100 * GB));
      writeFileMock.mockResolvedValue(undefined);
      renameMock.mockResolvedValue(undefined);
      rmMock.mockResolvedValue(undefined);
      prisma.movie.findUnique.mockResolvedValue({
        title: 'Big Film',
        seriesId: null,
        status: MovieStatus.DRAFT,
      });
    });

    const PART =
      /^\/storage\/temp\/uploads\/session-1\/chunk_1\.[0-9a-f-]{36}\.part$/;

    it('writes chunk_<n>.<id>.part first and renames it to chunk_<n> only after the write finished', async () => {
      await service.saveChunk('session-1', 1, Buffer.alloc(chunkSize));

      const [partPath] = writeFileMock.mock.calls[0] as [string];
      expect(partPath).toMatch(PART);
      expect(renameMock).toHaveBeenCalledWith(
        partPath,
        '/storage/temp/uploads/session-1/chunk_1',
      );
      expect(writeFileMock.mock.invocationCallOrder[0]).toBeLessThan(
        renameMock.mock.invocationCallOrder[0],
      );
    });

    it('two overlapping requests for the same chunk each use their own temporary file (no rename race)', async () => {
      await Promise.all([
        service.saveChunk('session-1', 1, Buffer.alloc(chunkSize)),
        service.saveChunk('session-1', 1, Buffer.alloc(chunkSize)),
      ]);

      const parts = writeFileMock.mock.calls.map(([p]) => p as string);
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatch(PART);
      expect(parts[1]).toMatch(PART);
      expect(parts[0]).not.toBe(parts[1]);
      expect(renameMock.mock.calls.map(([from]) => from as string)).toEqual(
        parts,
      );
    });

    it('a write that fails half-way never becomes a received chunk (no rename) and its temporary file is removed', async () => {
      writeFileMock.mockRejectedValue(new Error('EIO'));

      await expect(
        service.saveChunk('session-1', 1, Buffer.alloc(chunkSize)),
      ).rejects.toThrow('EIO');
      expect(renameMock).not.toHaveBeenCalled();
      const [partPath] = writeFileMock.mock.calls[0] as [string];
      expect(rmMock).toHaveBeenCalledWith(partPath, { force: true });
    });

    it('a leftover .part file does not count as received — the upload is still incomplete', async () => {
      readdirMock.mockResolvedValue([
        'chunk_0',
        'chunk_1',
        'chunk_2.0b5e7c1a-3d2f-4e8a-9b6c-1f2e3d4c5b6a.part',
      ]);

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        'Upload incomplete: 2/3 chunks received',
      );
    });

    it('refuses a merged file whose size is not the declared size: 400, session FAILED, files removed, nothing uploaded or transcoded', async () => {
      readdirMock.mockResolvedValue(['chunk_0', 'chunk_1', 'chunk_2']);
      fakeMergeStreams();
      statMock.mockResolvedValue({ size: fileSize - 100 });

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.uploadSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: UploadStatus.FAILED },
      });
      expect(rmMock).toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        { force: true },
      );
      expect(rmMock).toHaveBeenCalledWith('/storage/temp/uploads/session-1', {
        recursive: true,
        force: true,
      });
      expect(videosService.create).not.toHaveBeenCalled();
      expect(processingService.processVideo).not.toHaveBeenCalled();
    });

    it('refuses a short merged BUNDLE file before it is pushed to storage', async () => {
      prisma.uploadSession.findUnique.mockResolvedValue({
        ...session,
        relativePath: 'hls/720p/index.m3u8',
      });
      prisma.movie.findUnique.mockResolvedValue({
        title: 'Big Film',
        seriesId: null,
        status: MovieStatus.UPLOADING,
      });
      readdirMock.mockResolvedValue(['chunk_0', 'chunk_1', 'chunk_2']);
      fakeMergeStreams();
      statMock.mockResolvedValue({ size: 3 });

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        /a piece of it was damaged/,
      );
      expect(minioService.uploadFile).not.toHaveBeenCalled();
    });

    it('closes the destination file when a chunk cannot be read during the merge', async () => {
      readdirMock.mockResolvedValue(['chunk_0', 'chunk_1', 'chunk_2']);
      const output = new Writable({
        write: (_chunk, _encoding, callback) => callback(),
      });
      const destroy = jest.spyOn(output, 'destroy');
      createWriteStreamMock.mockReturnValue(output);
      createReadStreamMock.mockImplementation(() => {
        const stream = new PassThrough();
        process.nextTick(() => stream.destroy(new Error('ENOENT chunk')));
        return stream;
      });

      await expect(service.completeUpload('session-1', ACTOR)).rejects.toThrow(
        'ENOENT chunk',
      );
      expect(destroy).toHaveBeenCalled();
    });
  });
});
