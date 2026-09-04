import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { VideoDurationService } from './video-duration.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { VideoStatus } from '../generated/prisma/client';

const MOVIE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIDEO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MASTER_KEY = `videos/${MOVIE_ID}/hls/master.m3u8`;

/** Two variants, highest first — the shape the transcoder writes. */
const MASTER =
  '#EXTM3U\n#EXT-X-VERSION:3\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720\n' +
  '720p/index.m3u8\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x480\n' +
  '480p/index.m3u8\n';

/** 6 + 6 + 2.25 = 14.25 s -> 14 s -> 1 min (floor at 1). */
const VARIANT_720 =
  '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' +
  '#EXTINF:6.000,\nsegment_000.ts\n' +
  '#EXTINF:6.000,\nsegment_001.ts\n' +
  '#EXTINF:2.250,\nsegment_002.ts\n#EXT-X-ENDLIST\n';

/** A different sum so a test can prove the FIRST variant was read, not this one. */
const VARIANT_480 =
  '#EXTM3U\n#EXTINF:100.000,\nsegment_000.ts\n#EXT-X-ENDLIST\n';

describe('VideoDurationService', () => {
  let service: VideoDurationService;
  let prisma: {
    movie: { updateMany: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    video: { updateMany: jest.Mock };
  };
  let minioService: { readText: jest.Mock };
  /** Object key -> the text a read returns. */
  let stored: Map<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    stored = new Map([
      [MASTER_KEY, MASTER],
      [`videos/${MOVIE_ID}/hls/720p/index.m3u8`, VARIANT_720],
      [`videos/${MOVIE_ID}/hls/480p/index.m3u8`, VARIANT_480],
    ]);

    prisma = {
      movie: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      video: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    minioService = {
      readText: jest.fn(async (key: string) => {
        const value = stored.get(key);
        if (value === undefined) throw new Error(`NoSuchKey: ${key}`);
        return value;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoDurationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
      ],
    }).compile();

    service = module.get(VideoDurationService);
  });

  describe('recoverHlsDurationSeconds', () => {
    it('sums the EXTINFs of the FIRST variant the master lists, rounded to whole seconds', async () => {
      await expect(service.recoverHlsDurationSeconds(MASTER_KEY)).resolves.toBe(
        14,
      );
      expect(minioService.readText).toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
      );
      expect(minioService.readText).not.toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/480p/index.m3u8`,
      );
    });

    it('tolerates a CRLF master and variant — externally authored bundles ship those', async () => {
      stored.set(MASTER_KEY, MASTER.replace(/\n/g, '\r\n'));
      stored.set(
        `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
        VARIANT_720.replace(/\n/g, '\r\n'),
      );

      await expect(service.recoverHlsDurationSeconds(MASTER_KEY)).resolves.toBe(
        14,
      );
    });

    it('resolves a ./-prefixed variant URI against the master directory', async () => {
      stored.set(
        MASTER_KEY,
        MASTER.replace('720p/index.m3u8', './720p/index.m3u8'),
      );

      await expect(service.recoverHlsDurationSeconds(MASTER_KEY)).resolves.toBe(
        14,
      );
      expect(minioService.readText).toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
      );
    });

    it('returns null — never throws — when MinIO cannot read the master', async () => {
      stored.delete(MASTER_KEY);

      await expect(
        service.recoverHlsDurationSeconds(MASTER_KEY),
      ).resolves.toBeNull();
    });

    it('returns null when the variant playlist declares no EXTINF', async () => {
      stored.set(
        `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
        '#EXTM3U\n#EXT-X-ENDLIST\n',
      );

      await expect(
        service.recoverHlsDurationSeconds(MASTER_KEY),
      ).resolves.toBeNull();
    });

    it('returns null for a master with no variants and never reads a second object', async () => {
      stored.set(MASTER_KEY, '#EXTM3U\n#EXT-X-VERSION:3\n');

      await expect(
        service.recoverHlsDurationSeconds(MASTER_KEY),
      ).resolves.toBeNull();
      expect(minioService.readText).toHaveBeenCalledTimes(1);
    });

    it('refuses to follow an absolute http(s) variant URI out of the bucket', async () => {
      stored.set(
        MASTER_KEY,
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://elsewhere.example/index.m3u8\n',
      );

      await expect(
        service.recoverHlsDurationSeconds(MASTER_KEY),
      ).resolves.toBeNull();
      expect(minioService.readText).toHaveBeenCalledTimes(1);
    });
  });

  describe('fillMovieDurationIfUnknown', () => {
    it('writes rounded minutes guarded by duration = 0 in the database predicate — human values are never clobbered', async () => {
      await expect(
        service.fillMovieDurationIfUnknown(MOVIE_ID, 5430),
      ).resolves.toBe(true);

      expect(prisma.movie.updateMany).toHaveBeenCalledWith({
        where: { id: MOVIE_ID, duration: 0 },
        data: { duration: 91 },
      });
    });

    it('reports false when the guard matched nothing (an admin already typed a runtime)', async () => {
      prisma.movie.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.fillMovieDurationIfUnknown(MOVIE_ID, 5430),
      ).resolves.toBe(false);
    });

    it('never writes an unusable value', async () => {
      await expect(
        service.fillMovieDurationIfUnknown(MOVIE_ID, 0),
      ).resolves.toBe(false);
      await expect(
        service.fillMovieDurationIfUnknown(MOVIE_ID, Number.NaN),
      ).resolves.toBe(false);
      expect(prisma.movie.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('fillVideoDurationIfUnknown', () => {
    it('writes whole seconds guarded by duration IS NULL', async () => {
      await expect(
        service.fillVideoDurationIfUnknown(VIDEO_ID, 5430.4),
      ).resolves.toBe(true);

      expect(prisma.video.updateMany).toHaveBeenCalledWith({
        where: { id: VIDEO_ID, duration: null },
        data: { duration: 5430 },
      });
    });
  });

  describe('backfill', () => {
    const movieRow = (id: string, masterKey: string) => ({
      id,
      videos: [{ id: `video-of-${id}`, hlsMasterPath: masterKey }],
    });

    it('caps take at 100 whatever the caller asks for, and selects only unknown-runtime movies with a READY HLS video', async () => {
      await service.backfill(5000);

      expect(prisma.movie.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          orderBy: { createdAt: 'asc' },
          where: {
            duration: 0,
            videos: {
              some: {
                status: VideoStatus.READY,
                hlsMasterPath: { not: null },
              },
            },
          },
        }),
      );
    });

    it('honours a smaller limit and floors nonsense at 1', async () => {
      await service.backfill(7);
      expect(prisma.movie.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 7 }),
      );

      await service.backfill(0);
      expect(prisma.movie.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });

    it('counts updated and failed titles separately and reports remaining from a second count', async () => {
      const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      prisma.movie.findMany.mockResolvedValue([
        movieRow(MOVIE_ID, MASTER_KEY),
        movieRow(other, `videos/${other}/hls/master.m3u8`), // not in MinIO
      ]);
      prisma.movie.count.mockResolvedValue(3);

      const result = await service.backfill(100);

      expect(result).toEqual({
        scanned: 2,
        updated: 1,
        failed: [
          {
            movieId: other,
            reason: 'no readable EXTINF in the first variant playlist',
          },
        ],
        remaining: 3,
      });
      expect(prisma.video.updateMany).toHaveBeenCalledWith({
        where: { id: `video-of-${MOVIE_ID}`, duration: null },
        data: { duration: 14 },
      });
      expect(prisma.movie.updateMany).toHaveBeenCalledWith({
        where: { id: MOVIE_ID, duration: 0 },
        data: { duration: 1 },
      });
      expect(prisma.movie.updateMany).toHaveBeenCalledTimes(1);
    });

    it('does not count a title whose runtime a human filled in mid-run — the guard, not the read, decides', async () => {
      prisma.movie.findMany.mockResolvedValue([movieRow(MOVIE_ID, MASTER_KEY)]);
      prisma.movie.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.backfill(100);

      expect(result.scanned).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toEqual([]);
    });

    it('is a no-op on an empty set — safe to click repeatedly', async () => {
      await expect(service.backfill(100)).resolves.toEqual({
        scanned: 0,
        updated: 0,
        failed: [],
        remaining: 0,
      });
      expect(minioService.readText).not.toHaveBeenCalled();
      expect(prisma.movie.updateMany).not.toHaveBeenCalled();
    });
  });
});
