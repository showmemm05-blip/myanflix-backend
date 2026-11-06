import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ProcessingService } from './processing.service';
import { VideosService } from '../videos/videos.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { HlsSubtitlesService } from '../subtitles/hls-subtitles.service';
import { AuditService } from '../audit/audit.service';
import { probeVideo, transcodeToHls } from './ffmpeg.util';
import { rm, writeFile } from 'node:fs/promises';

jest.mock('./ffmpeg.util', () => ({
  probeVideo: jest.fn(),
  transcodeToHls: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  rm: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

const probeVideoMock = probeVideo as jest.Mock;
const transcodeToHlsMock = transcodeToHls as jest.Mock;
const rmMock = rm as unknown as jest.Mock;
/** processVideo() writes exactly one local file: the master playlist. */
const writeFileMock = writeFile as unknown as jest.Mock;

describe('ProcessingService', () => {
  let service: ProcessingService;
  let videosService: {
    markProcessing: jest.Mock;
    markFailed: jest.Mock;
    updateOriginalPath: jest.Mock;
    markReady: jest.Mock;
  };
  let prisma: {
    movie: { update: jest.Mock; findUnique: jest.Mock };
    video: { findUnique: jest.Mock };
  };
  let minioService: {
    objectExists: jest.Mock;
    uploadFile: jest.Mock;
    uploadDirectory: jest.Mock;
  };
  let hlsSubtitlesService: { publishForVideo: jest.Mock };
  let audit: { record: jest.Mock };
  let storageService: {
    hlsDir: jest.Mock;
    ensureDir: jest.Mock;
    originalObjectKey: jest.Mock;
    hlsRenditionKeyPrefix: jest.Mock;
    hlsMasterKey: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks() keeps a mockRejectedValue() a previous test installed
    // on the module-level rm mock — under --randomize that leaked rejection
    // broke whichever transcode test ran next (TEST-003). Every test starts
    // from a clean scratch disk.
    rmMock.mockReset().mockResolvedValue(undefined);
    // processVideo() logs the failure it is handling; keep test output readable.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    videosService = {
      markProcessing: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      updateOriginalPath: jest.fn().mockResolvedValue(undefined),
      markReady: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      movie: {
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest
          .fn()
          .mockResolvedValue({ title: 'A Movie', status: 'DRAFT' }),
      },
      video: {
        // As the classic flow creates the row: originalPath is the local
        // scratch file until the pipeline archives it (updateOriginalPath).
        findUnique: jest.fn().mockResolvedValue({
          originalPath: '/storage/temp/videos/movie-1/original.mp4',
        }),
      },
    };
    minioService = {
      objectExists: jest.fn().mockResolvedValue(false),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      uploadDirectory: jest.fn().mockResolvedValue(undefined),
    };
    hlsSubtitlesService = {
      publishForVideo: jest.fn().mockResolvedValue({ published: [] }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    storageService = {
      // Mirrors the real StorageService: every local file the pipeline
      // touches lives under <STORAGE_PATH>/temp/ so one sweep can clean it.
      hlsDir: jest.fn(
        (movieId: string) => `/storage/temp/videos/${movieId}/hls`,
      ),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      originalObjectKey: jest.fn(
        (movieId: string, ext: string) => `videos/${movieId}/original${ext}`,
      ),
      hlsRenditionKeyPrefix: jest.fn(
        (movieId: string, name: string) => `videos/${movieId}/hls/${name}`,
      ),
      hlsMasterKey: jest.fn(
        (movieId: string) => `videos/${movieId}/hls/master.m3u8`,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessingService,
        { provide: VideosService, useValue: videosService },
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storageService },
        { provide: MinioService, useValue: minioService },
        { provide: HlsSubtitlesService, useValue: hlsSubtitlesService },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(ProcessingService);
  });

  describe('archiving the original', () => {
    beforeEach(() => {
      // height: 240 -> pickRenditions() selects exactly one tier (240p),
      // keeping this focused on the archive-skip behavior rather than
      // exercising every rendition.
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);
    });

    it('uploads the original when it is not already archived', async () => {
      minioService.objectExists.mockResolvedValue(false);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        '/storage/temp/videos/movie-1/original.mp4',
      );
      expect(videosService.updateOriginalPath).toHaveBeenCalledWith(
        'video-1',
        'videos/movie-1/original.mp4',
      );
    });

    /**
     * A reprocess() run re-downloads an already-archived original from MinIO
     * to feed ffmpeg — without this, every retry would re-upload that same
     * multi-GB file straight back to the storage server for no reason.
     */
    it('skips re-uploading the original when it is already archived', async () => {
      minioService.objectExists.mockResolvedValue(true);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      const originalUploadCalls = minioService.uploadFile.mock.calls.filter(
        ([key]) => key === 'videos/movie-1/original.mp4',
      );
      expect(originalUploadCalls).toHaveLength(0);
      // Still recorded as the video's original location either way.
      expect(videosService.updateOriginalPath).toHaveBeenCalledWith(
        'video-1',
        'videos/movie-1/original.mp4',
      );
    });

    it('still uploads the master playlist and renditions when only the original is already archived', async () => {
      // Only the original's own object exists — the rendition itself does not.
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/original.mp4',
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(minioService.uploadDirectory).toHaveBeenCalledWith(
        expect.stringContaining('240p'),
        'videos/movie-1/hls/240p',
      );
      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/hls/master.m3u8',
        expect.any(String),
      );
      expect(videosService.markReady).toHaveBeenCalled();
      expect(prisma.movie.update).toHaveBeenCalledWith({
        where: { id: 'movie-1' },
        data: { status: 'PUBLISHED' },
      });
    });
  });

  /**
   * buildMasterPlaylist() writes master.m3u8 from scratch, so a re-transcode
   * of a movie that already has subtitle tracks would otherwise silently
   * drop their #EXT-X-MEDIA block and leave both players with no subtitles
   * again.
   */
  describe('republishing subtitles after a transcode', () => {
    beforeEach(() => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);
    });

    it('republishes the subtitle renditions once the new master is uploaded', async () => {
      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(hlsSubtitlesService.publishForVideo).toHaveBeenCalledWith(
        'video-1',
      );
    });

    it('does not fail the transcode when publishing them fails', async () => {
      hlsSubtitlesService.publishForVideo.mockRejectedValue(
        new Error('MinIO unreachable'),
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(videosService.markFailed).not.toHaveBeenCalled();
      expect(prisma.movie.update).toHaveBeenCalledWith({
        where: { id: 'movie-1' },
        data: { status: 'PUBLISHED' },
      });
    });
  });

  describe('resuming a partially-completed transcode', () => {
    beforeEach(() => {
      // height: 480 -> pickRenditions() selects 480p, 360p, 240p (three
      // tiers), giving room to prove "the first tier is skipped, later ones
      // still run" rather than a single-tier test that can't distinguish
      // "skipped everything" from "skipped nothing."
      probeVideoMock.mockResolvedValue({
        durationSeconds: 300,
        width: 854,
        height: 480,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);
    });

    it('skips transcoding and uploading a rendition that already finished uploading', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(transcodeToHlsMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ targetHeight: 480 }),
      );
      expect(minioService.uploadDirectory).not.toHaveBeenCalledWith(
        expect.any(String),
        'videos/movie-1/hls/480p',
      );
    });

    it('still transcodes and uploads renditions that are not yet done', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(transcodeToHlsMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetHeight: 360 }),
      );
      expect(transcodeToHlsMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetHeight: 240 }),
      );
      expect(minioService.uploadDirectory).toHaveBeenCalledWith(
        expect.any(String),
        'videos/movie-1/hls/360p',
      );
      expect(minioService.uploadDirectory).toHaveBeenCalledWith(
        expect.any(String),
        'videos/movie-1/hls/240p',
      );
    });

    it('clears any stale partial local output before re-transcoding a tier that was interrupted', async () => {
      minioService.objectExists.mockResolvedValue(false); // nothing finished — everything gets redone

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(rmMock).toHaveBeenCalledWith(
        expect.stringContaining('480p'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    });

    it('produces a master playlist listing every tier, including skipped ones', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(videosService.markReady).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          renditions: expect.arrayContaining([
            expect.objectContaining({ resolution: '480p' }),
            expect.objectContaining({ resolution: '360p' }),
            expect.objectContaining({ resolution: '240p' }),
          ]),
        }),
      );
    });
  });

  /**
   * The widescreen ladder and the 480p-first master (owner, 2026-10-12). A
   * rung is earned by the source's longer side reaching the box width (98%)
   * OR its shorter side reaching the tier height; each rung is scaled to fit
   * inside its 16:9 box; RESOLUTION states the real output size; and every
   * master lists the 480p rung first, because native phone players start
   * on the first variant.
   */
  describe('the rendition ladder and the master playlist', () => {
    const MASTER_PATH = '/storage/temp/videos/movie-1/hls/master.m3u8';
    const masterWritten = (): string => {
      const call = writeFileMock.mock.calls.find(
        ([path]) => path === MASTER_PATH,
      );
      expect(call).toBeDefined();
      return call![1] as string;
    };
    const boxesTranscoded = (): string[] =>
      transcodeToHlsMock.mock.calls.map(
        ([options]) =>
          `${(options as { targetWidth: number }).targetWidth}x${(options as { targetHeight: number }).targetHeight}`,
      );

    beforeEach(() => {
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);
    });

    it('a 1920x800 widescreen film gets a real 1080p rung, every tier scaled into its own 16:9 box', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 5400,
        width: 1920,
        height: 800,
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(boxesTranscoded()).toEqual([
        '1920x1080',
        '1280x720',
        '854x480',
        '640x360',
        '426x240',
      ]);
      expect(transcodeToHlsMock).toHaveBeenCalledWith({
        inputPath: '/storage/temp/videos/movie-1/original.mp4',
        outputDir: '/storage/temp/videos/movie-1/hls/1080p',
        segmentPattern:
          '/storage/temp/videos/movie-1/hls/1080p/segment_%03d.ts',
        playlistPath: '/storage/temp/videos/movie-1/hls/1080p/index.m3u8',
        targetWidth: 1920,
        targetHeight: 1080,
        videoBitrate: '5000k',
      });
      expect(videosService.markReady).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          resolution: '1920x800',
          renditions: expect.arrayContaining([
            {
              resolution: '1080p',
              playlistPath: 'videos/movie-1/hls/1080p/index.m3u8',
            },
          ]),
        }),
      );
    });

    it('writes the master with the 480p rung first and RESOLUTION as the real output size, then uploads it', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 5400,
        width: 1920,
        height: 800,
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(masterWritten()).toBe(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x356',
          '480p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=1920x800',
          '1080p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x534',
          '720p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x266',
          '360p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x178',
          '240p/index.m3u8',
        ].join('\n') + '\n',
      );
      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/hls/master.m3u8',
        MASTER_PATH,
      );
    });

    it('a 16:9 720p source still gets 720p to 240p at the sizes it always had — only the order changed', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 450,
        width: 1280,
        height: 720,
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(boxesTranscoded()).toEqual([
        '1280x720',
        '854x480',
        '640x360',
        '426x240',
      ]);
      expect(masterWritten()).toBe(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x480',
          '480p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
          '720p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360',
          '360p/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240',
          '240p/index.m3u8',
        ].join('\n') + '\n',
      );
    });

    it('a vertical 1080x1920 source earns its rungs by height exactly as before, and the master states its real portrait sizes', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 60,
        width: 1080,
        height: 1920,
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(transcodeToHlsMock).toHaveBeenCalledTimes(5);
      expect(masterWritten()).toContain(
        '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=270x480\n480p/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=608x1080\n1080p/index.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=406x720\n720p/index.m3u8\n',
      );
    });

    it('a source too small for every rung falls back to the single 240p rung, as before', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 30,
        width: 200,
        height: 100,
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(boxesTranscoded()).toEqual(['426x240']);
      expect(masterWritten()).toBe(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x214\n240p/index.m3u8\n',
      );
    });
  });

  describe('isActivelyProcessing / active-job tracking', () => {
    it('reports a video as actively processing only while processVideo() is still running', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 60,
        width: 320,
        height: 240,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);

      expect(service.isActivelyProcessing('video-1')).toBe(false);

      const promise = service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );
      // Still resolving at this point — mocked async calls haven't settled.
      expect(service.isActivelyProcessing('video-1')).toBe(true);

      await promise;
      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });

    it('clears the active-job flag even when processing fails', async () => {
      probeVideoMock.mockRejectedValue(new Error('boom'));

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });

    it('reserve() refuses a second reservation and release() clears it', () => {
      expect(service.reserve('video-1')).toBe(true);
      expect(service.isActivelyProcessing('video-1')).toBe(true);

      expect(service.reserve('video-1')).toBe(false);
      // Another video is unaffected.
      expect(service.reserve('video-2')).toBe(true);

      service.release('video-1');
      expect(service.isActivelyProcessing('video-1')).toBe(false);
      expect(service.reserve('video-1')).toBe(true);
    });

    it('a reservation handed to processVideo() is cleared by its finally, even when the run fails', async () => {
      probeVideoMock.mockRejectedValue(new Error('boom'));
      expect(service.reserve('video-1')).toBe(true);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });
  });

  describe('when processing fails', () => {
    beforeEach(() => {
      probeVideoMock.mockRejectedValue(new Error('ffprobe blew up'));
    });

    it('records the failure, clears the scratch renditions and KEEPS the un-archived original for Reprocess (STR-004)', async () => {
      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'ffprobe blew up',
      );
      expect(rmMock).toHaveBeenCalledWith('/storage/temp/videos/movie-1/hls', {
        recursive: true,
        force: true,
      });
      // The probe failed before the archive step, so the row still names
      // the local file: it is the only copy there is.
      expect(prisma.video.findUnique).toHaveBeenCalledWith({
        where: { id: 'video-1' },
        select: { originalPath: true },
      });
      expect(rmMock).not.toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        expect.anything(),
      );
    });

    /**
     * The STR-004 case proper: the archive upload (the first and longest
     * MinIO transfer) is what failed, which is exactly the "dropped
     * connection to the storage server" that Reprocess exists for — and
     * Reprocess reads the local file when the row still points at it.
     */
    it('keeps the local original when archiving it to MinIO failed', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      minioService.uploadFile.mockRejectedValue(new Error('minio down'));

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'minio down',
      );
      expect(videosService.updateOriginalPath).not.toHaveBeenCalled();
      expect(rmMock).toHaveBeenCalledWith('/storage/temp/videos/movie-1/hls', {
        recursive: true,
        force: true,
      });
      expect(rmMock).not.toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        expect.anything(),
      );
    });

    it('a later run over that kept local original archives it (Reprocess after STR-004)', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        '/storage/temp/videos/movie-1/original.mp4',
      );
      expect(videosService.updateOriginalPath).toHaveBeenCalledWith(
        'video-1',
        'videos/movie-1/original.mp4',
      );
      expect(videosService.markReady).toHaveBeenCalled();
    });

    it('deletes the local original once the row points at a MinIO key (archived; a later step failed)', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      transcodeToHlsMock.mockRejectedValue(new Error('ffmpeg exited with 1'));
      prisma.video.findUnique.mockResolvedValue({
        originalPath: 'videos/movie-1/original.mp4',
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'ffmpeg exited with 1',
      );
      expect(rmMock).toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        { force: true },
      );
    });

    it('keeps the local original when the row cannot be read — the safe side', async () => {
      prisma.video.findUnique.mockRejectedValue(new Error('pool timeout'));

      await expect(
        service.processVideo(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        ),
      ).resolves.toBeUndefined();

      expect(rmMock).toHaveBeenCalledWith('/storage/temp/videos/movie-1/hls', {
        recursive: true,
        force: true,
      });
      expect(rmMock).not.toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        expect.anything(),
      );
    });

    /**
     * The fire-and-forget callers used to see this rejection escape
     * processVideo() with no catch, and an unhandled rejection is fatal in
     * Node — one pool timeout on this first write took the API down
     * (STR-009). It is now a failure like any other step.
     */
    it('a markProcessing failure is handled like any other step — processVideo resolves and records it (STR-009)', async () => {
      videosService.markProcessing.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.processVideo(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        ),
      ).resolves.toBeUndefined();

      expect(probeVideoMock).not.toHaveBeenCalled();
      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'db down',
      );
      expect(prisma.movie.update).toHaveBeenCalledWith({
        where: { id: 'movie-1' },
        data: { status: 'DRAFT' },
      });
      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });

    /**
     * The production crash: deleting a movie mid-processing cascade-deletes
     * its Video row, so markFailed() throws P2025 from inside the error
     * handler. That rejection escaped and killed the whole container, since
     * an unhandled rejection is fatal in Node.
     */
    it('does not reject when the records were deleted mid-processing', async () => {
      const notFound = Object.assign(
        new Error('No record was found for an update.'),
        {
          code: 'P2025',
        },
      );
      videosService.markFailed.mockRejectedValue(notFound);

      await expect(
        service.processVideo(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        ),
      ).resolves.toBeUndefined();
    });

    it('still cleans up scratch files even when the records are gone', async () => {
      videosService.markFailed.mockRejectedValue(
        Object.assign(new Error('No record was found for an update.'), {
          code: 'P2025',
        }),
      );
      // The Video row went with its movie: nothing is left to reprocess, so
      // the local original goes too.
      prisma.video.findUnique.mockResolvedValue(null);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(rmMock).toHaveBeenCalledWith(
        '/storage/temp/videos/movie-1/original.mp4',
        { force: true },
      );
    });

    it('does not reject when scratch cleanup itself fails', async () => {
      rmMock.mockRejectedValue(new Error('EBUSY'));

      await expect(
        service.processVideo(
          'video-1',
          'movie-1',
          '/storage/temp/videos/movie-1/original.mp4',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('audit — SYSTEM rows with no actor', () => {
    it('auto-publish after a transcode is movie.publish by the system, after the status write', async () => {
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
      transcodeToHlsMock.mockResolvedValue(undefined);

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'movie.publish',
        actor: null,
        target: { type: 'movie', id: 'movie-1', label: 'A Movie' },
        before: { status: 'DRAFT' },
        after: { status: 'PUBLISHED' },
        metadata: { trigger: 'transcode_complete', videoId: 'video-1' },
      });
      expect(prisma.movie.update.mock.invocationCallOrder[0]).toBeLessThan(
        audit.record.mock.invocationCallOrder[0],
      );
    });

    it('a failed transcode is movie.status_change → DRAFT by the system with the error', async () => {
      probeVideoMock.mockRejectedValue(new Error('ffprobe blew up'));
      // A title mid-transcode sits at PROCESSING; falling back to DRAFT is a
      // real status change (DRAFT → DRAFT would be a dropped no-op row).
      prisma.movie.findUnique.mockResolvedValue({
        title: 'A Movie',
        status: 'PROCESSING',
      });

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'movie.status_change',
        actor: null,
        target: { type: 'movie', id: 'movie-1', label: 'A Movie' },
        before: { status: 'PROCESSING' },
        after: { status: 'DRAFT' },
        metadata: {
          trigger: 'transcode_failed',
          videoId: 'video-1',
          error: 'ffprobe blew up',
        },
      });
    });

    it('writes no row when the movie vanished mid-processing (nothing to change)', async () => {
      probeVideoMock.mockRejectedValue(new Error('boom'));
      videosService.markFailed.mockRejectedValue(
        Object.assign(new Error('No record was found for an update.'), {
          code: 'P2025',
        }),
      );

      await service.processVideo(
        'video-1',
        'movie-1',
        '/storage/temp/videos/movie-1/original.mp4',
      );

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('process-wide transcode limit (VIDEO_TRANSCODE_CONCURRENCY, default 1)', () => {
    const savedEnv = process.env.VIDEO_TRANSCODE_CONCURRENCY;
    afterEach(() => {
      if (savedEnv === undefined)
        delete process.env.VIDEO_TRANSCODE_CONCURRENCY;
      else process.env.VIDEO_TRANSCODE_CONCURRENCY = savedEnv;
    });

    beforeEach(() => {
      delete process.env.VIDEO_TRANSCODE_CONCURRENCY;
      probeVideoMock.mockResolvedValue({
        durationSeconds: 120,
        width: 426,
        height: 240,
      });
    });

    const flush = () => new Promise((r) => setImmediate(r));

    it('runs one transcode at a time: the second video waits (already PROCESSING and still "active") until the first finishes', async () => {
      let finishFirst!: () => void;
      transcodeToHlsMock
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => (finishFirst = resolve)),
        )
        .mockResolvedValue(undefined);

      const first = service.processVideo('video-1', 'movie-1', '/in/1.mp4');
      await flush();
      const second = service.processVideo('video-2', 'movie-2', '/in/2.mp4');
      await flush();

      // The waiting video is already marked PROCESSING and still counts as
      // active, so reprocess/replace keep answering 409 for it.
      expect(videosService.markProcessing).toHaveBeenCalledWith('video-2');
      expect(service.isActivelyProcessing('video-2')).toBe(true);
      expect(service.reserve('video-2')).toBe(false);
      // ...but its pipeline has not started.
      expect(probeVideoMock).toHaveBeenCalledTimes(1);
      expect(probeVideoMock).toHaveBeenCalledWith('/in/1.mp4');
      expect(service.transcodeLoad).toEqual({ active: 1, queued: 1 });

      finishFirst();
      await first;
      await second;

      expect(probeVideoMock).toHaveBeenCalledTimes(2);
      expect(probeVideoMock).toHaveBeenLastCalledWith('/in/2.mp4');
      expect(service.transcodeLoad).toEqual({ active: 0, queued: 0 });
      expect(service.isActivelyProcessing('video-2')).toBe(false);
    });

    it('frees the slot when a transcode fails, so the next video still runs', async () => {
      probeVideoMock
        .mockRejectedValueOnce(new Error('bad file'))
        .mockResolvedValue({ durationSeconds: 1, width: 426, height: 240 });
      transcodeToHlsMock.mockResolvedValue(undefined);

      await service.processVideo('video-1', 'movie-1', '/in/1.mp4');
      await service.processVideo('video-2', 'movie-2', '/in/2.mp4');

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'bad file',
      );
      expect(videosService.markReady).toHaveBeenCalledTimes(1);
      expect(service.transcodeLoad).toEqual({ active: 0, queued: 0 });
    });

    it('never releases a slot it did not take (markProcessing threw first — handled, no slot was held)', async () => {
      videosService.markProcessing.mockRejectedValueOnce(new Error('db down'));

      // Handled inside the pipeline since STR-009: resolves, records the
      // failure, and the slot it never acquired is not released either.
      await expect(
        service.processVideo('video-1', 'movie-1', '/in/1.mp4'),
      ).resolves.toBeUndefined();

      expect(videosService.markFailed).toHaveBeenCalledWith(
        'video-1',
        'db down',
      );
      expect(service.transcodeLoad).toEqual({ active: 0, queued: 0 });
      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });

    it('honours VIDEO_TRANSCODE_CONCURRENCY=2', async () => {
      process.env.VIDEO_TRANSCODE_CONCURRENCY = '2';
      const releases: Array<() => void> = [];
      transcodeToHlsMock.mockImplementation(
        () => new Promise<void>((resolve) => releases.push(resolve)),
      );

      const runs = ['1', '2', '3'].map((n) =>
        service.processVideo(`video-${n}`, `movie-${n}`, `/in/${n}.mp4`),
      );
      await flush();
      await flush();

      expect(service.transcodeLoad).toEqual({ active: 2, queued: 1 });
      expect(probeVideoMock).toHaveBeenCalledTimes(2);

      // Finishing one of the two running transcodes lets the third start.
      releases.shift()?.();
      for (let i = 0; i < 5 && releases.length < 2; i++) await flush();
      expect(probeVideoMock).toHaveBeenCalledTimes(3);
      releases.splice(0).forEach((release) => release());
      await Promise.all(runs);
      expect(probeVideoMock).toHaveBeenCalledTimes(3);
      expect(service.transcodeLoad).toEqual({ active: 0, queued: 0 });
    });
  });
});
