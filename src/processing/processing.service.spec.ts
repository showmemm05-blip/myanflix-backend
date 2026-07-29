import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ProcessingService } from './processing.service';
import { VideosService } from '../videos/videos.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
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
void writeFile; // imported only so jest.mock('node:fs/promises') covers it; processVideo() calls it internally

describe('ProcessingService', () => {
  let service: ProcessingService;
  let videosService: { markProcessing: jest.Mock; markFailed: jest.Mock; updateOriginalPath: jest.Mock; markReady: jest.Mock };
  let prisma: { movie: { update: jest.Mock } };
  let minioService: { objectExists: jest.Mock; uploadFile: jest.Mock; uploadDirectory: jest.Mock };
  let storageService: {
    hlsDir: jest.Mock;
    ensureDir: jest.Mock;
    originalObjectKey: jest.Mock;
    hlsRenditionKeyPrefix: jest.Mock;
    hlsMasterKey: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
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
    prisma = { movie: { update: jest.fn().mockResolvedValue(undefined) } };
    minioService = {
      objectExists: jest.fn().mockResolvedValue(false),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      uploadDirectory: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      hlsDir: jest.fn((movieId: string) => `/storage/videos/${movieId}/hls`),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      originalObjectKey: jest.fn((movieId: string, ext: string) => `videos/${movieId}/original${ext}`),
      hlsRenditionKeyPrefix: jest.fn((movieId: string, name: string) => `videos/${movieId}/hls/${name}`),
      hlsMasterKey: jest.fn((movieId: string) => `videos/${movieId}/hls/master.m3u8`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessingService,
        { provide: VideosService, useValue: videosService },
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storageService },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(ProcessingService);
  });

  describe('archiving the original', () => {
    beforeEach(() => {
      // height: 240 -> pickRenditions() selects exactly one tier (240p),
      // keeping this focused on the archive-skip behavior rather than
      // exercising every rendition.
      probeVideoMock.mockResolvedValue({ durationSeconds: 120, width: 426, height: 240 });
      transcodeToHlsMock.mockResolvedValue(undefined);
    });

    it('uploads the original when it is not already archived', async () => {
      minioService.objectExists.mockResolvedValue(false);

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(minioService.uploadFile).toHaveBeenCalledWith(
        'videos/movie-1/original.mp4',
        '/storage/videos/movie-1/original.mp4',
      );
      expect(videosService.updateOriginalPath).toHaveBeenCalledWith('video-1', 'videos/movie-1/original.mp4');
    });

    /**
     * A reprocess() run re-downloads an already-archived original from MinIO
     * to feed ffmpeg — without this, every retry would re-upload that same
     * multi-GB file straight back to the storage server for no reason.
     */
    it('skips re-uploading the original when it is already archived', async () => {
      minioService.objectExists.mockResolvedValue(true);

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      const originalUploadCalls = minioService.uploadFile.mock.calls.filter(
        ([key]) => key === 'videos/movie-1/original.mp4',
      );
      expect(originalUploadCalls).toHaveLength(0);
      // Still recorded as the video's original location either way.
      expect(videosService.updateOriginalPath).toHaveBeenCalledWith('video-1', 'videos/movie-1/original.mp4');
    });

    it('still uploads the master playlist and renditions when only the original is already archived', async () => {
      // Only the original's own object exists — the rendition itself does not.
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/original.mp4',
      );

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

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

  describe('resuming a partially-completed transcode', () => {
    beforeEach(() => {
      // height: 480 -> pickRenditions() selects 480p, 360p, 240p (three
      // tiers), giving room to prove "the first tier is skipped, later ones
      // still run" rather than a single-tier test that can't distinguish
      // "skipped everything" from "skipped nothing."
      probeVideoMock.mockResolvedValue({ durationSeconds: 300, width: 854, height: 480 });
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);
    });

    it('skips transcoding and uploading a rendition that already finished uploading', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(transcodeToHlsMock).not.toHaveBeenCalledWith(expect.objectContaining({ targetHeight: 480 }));
      expect(minioService.uploadDirectory).not.toHaveBeenCalledWith(
        expect.any(String),
        'videos/movie-1/hls/480p',
      );
    });

    it('still transcodes and uploads renditions that are not yet done', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(transcodeToHlsMock).toHaveBeenCalledWith(expect.objectContaining({ targetHeight: 360 }));
      expect(transcodeToHlsMock).toHaveBeenCalledWith(expect.objectContaining({ targetHeight: 240 }));
      expect(minioService.uploadDirectory).toHaveBeenCalledWith(expect.any(String), 'videos/movie-1/hls/360p');
      expect(minioService.uploadDirectory).toHaveBeenCalledWith(expect.any(String), 'videos/movie-1/hls/240p');
    });

    it('clears any stale partial local output before re-transcoding a tier that was interrupted', async () => {
      minioService.objectExists.mockResolvedValue(false); // nothing finished — everything gets redone

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(rmMock).toHaveBeenCalledWith(
        expect.stringContaining('480p'),
        expect.objectContaining({ recursive: true, force: true }),
      );
    });

    it('produces a master playlist listing every tier, including skipped ones', async () => {
      minioService.objectExists.mockImplementation(
        async (key) => key === 'videos/movie-1/hls/480p/index.m3u8',
      );

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

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

  describe('isActivelyProcessing / active-job tracking', () => {
    it('reports a video as actively processing only while processVideo() is still running', async () => {
      probeVideoMock.mockResolvedValue({ durationSeconds: 60, width: 320, height: 240 });
      transcodeToHlsMock.mockResolvedValue(undefined);
      minioService.objectExists.mockResolvedValue(false);

      expect(service.isActivelyProcessing('video-1')).toBe(false);

      const promise = service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');
      // Still resolving at this point — mocked async calls haven't settled.
      expect(service.isActivelyProcessing('video-1')).toBe(true);

      await promise;
      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });

    it('clears the active-job flag even when processing fails', async () => {
      probeVideoMock.mockRejectedValue(new Error('boom'));

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(service.isActivelyProcessing('video-1')).toBe(false);
    });
  });

  describe('when processing fails', () => {
    beforeEach(() => {
      probeVideoMock.mockRejectedValue(new Error('ffprobe blew up'));
    });

    it('records the failure and cleans up scratch files', async () => {
      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(videosService.markFailed).toHaveBeenCalledWith('video-1', 'ffprobe blew up');
      expect(rmMock).toHaveBeenCalledWith('/storage/videos/movie-1/hls', {
        recursive: true,
        force: true,
      });
      expect(rmMock).toHaveBeenCalledWith('/storage/videos/movie-1/original.mp4', { force: true });
    });

    /**
     * The production crash: deleting a movie mid-processing cascade-deletes
     * its Video row, so markFailed() throws P2025 from inside the error
     * handler. That rejection escaped and killed the whole container, since
     * an unhandled rejection is fatal in Node.
     */
    it('does not reject when the records were deleted mid-processing', async () => {
      const notFound = Object.assign(new Error('No record was found for an update.'), {
        code: 'P2025',
      });
      videosService.markFailed.mockRejectedValue(notFound);

      await expect(
        service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4'),
      ).resolves.toBeUndefined();
    });

    it('still cleans up scratch files even when the records are gone', async () => {
      videosService.markFailed.mockRejectedValue(
        Object.assign(new Error('No record was found for an update.'), { code: 'P2025' }),
      );

      await service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4');

      expect(rmMock).toHaveBeenCalledWith('/storage/videos/movie-1/original.mp4', { force: true });
    });

    it('does not reject when scratch cleanup itself fails', async () => {
      rmMock.mockRejectedValue(new Error('EBUSY'));

      await expect(
        service.processVideo('video-1', 'movie-1', '/storage/videos/movie-1/original.mp4'),
      ).resolves.toBeUndefined();
    });
  });
});
