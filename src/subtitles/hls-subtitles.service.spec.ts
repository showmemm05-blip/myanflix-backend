import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { HlsSubtitlesService } from './hls-subtitles.service';
import { hlsTimestampMap } from './srt-to-vtt';

const MOVIE_ID = 'ebfce557-db9f-4515-8329-f28fc10dd28f';
const VIDEO_ID = '0b94b5e5-7224-4dfd-99a3-4112bb09501c';
const SUBTITLE_ID = 'cc0ce210-d64a-4a83-ab24-33369b711e43';
const MASTER_KEY = `videos/${MOVIE_ID}/hls/master.m3u8`;

const MASTER =
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
    '720p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240',
    '240p/index.m3u8',
  ].join('\n') + '\n';

const SRT = ['1', '00:00:01,234 --> 00:00:03,456', 'Hello there.', ''].join(
  '\n',
);

/**
 * What ffmpeg's mpegts muxer actually starts this deployment's renditions at
 * (1.443s at 90kHz) — measured, and the value the timestamp map must carry.
 */
const INITIAL_PTS = 129_910;

/** A single transport packet whose PES header declares `pts`. */
function tsPacketWithPts(pts: number): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x41, 0x00, 0x10], 0); // sync, PID 256, payload start
  packet.set([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0x05], 4);
  packet.set(
    [
      0x21 | ((Math.floor(pts / 1_073_741_824) & 0x07) << 1),
      Math.floor(pts / 4_194_304) & 0xff,
      ((Math.floor(pts / 32_768) & 0x7f) << 1) | 0x01,
      Math.floor(pts / 128) & 0xff,
      ((pts & 0x7f) << 1) | 0x01,
    ],
    13,
  );
  return packet;
}

const englishRow = (overrides: Record<string, unknown> = {}) => ({
  id: SUBTITLE_ID,
  videoId: VIDEO_ID,
  language: 'en',
  label: 'English',
  format: 'SRT',
  objectKey: `subtitles/${SUBTITLE_ID}/original.srt`,
  isDefault: true,
  ...overrides,
});

describe('HlsSubtitlesService', () => {
  let service: HlsSubtitlesService;
  let prisma: {
    video: { findUnique: jest.Mock; findFirst: jest.Mock };
    subtitle: { findMany: jest.Mock };
  };
  let minioService: {
    readText: jest.Mock;
    readBytes: jest.Mock;
    uploadBuffer: jest.Mock;
    deleteObject: jest.Mock;
  };
  /** Object key -> the text last written there. */
  let written: Map<string, string>;
  /** Object key -> the text a read returns. */
  let stored: Map<string, string>;
  /** Object key -> the bytes a ranged read returns (media segments). */
  let segments: Map<string, Buffer>;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    written = new Map();
    stored = new Map([
      [MASTER_KEY, MASTER],
      [`subtitles/${SUBTITLE_ID}/original.srt`, SRT],
      [
        `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
        '#EXTM3U\n#EXTINF:6.000,\nsegment_000.ts\n#EXTINF:4.000,\nsegment_001.ts\n#EXT-X-ENDLIST\n',
      ],
    ]);

    segments = new Map([
      [`videos/${MOVIE_ID}/hls/720p/segment_000.ts`, tsPacketWithPts(INITIAL_PTS)],
    ]);

    prisma = {
      video: {
        findUnique: jest.fn().mockResolvedValue({
          id: VIDEO_ID,
          movieId: MOVIE_ID,
          status: 'READY',
          duration: null,
          hlsMasterPath: MASTER_KEY,
        }),
        findFirst: jest.fn().mockResolvedValue({ id: VIDEO_ID }),
      },
      subtitle: { findMany: jest.fn().mockResolvedValue([englishRow()]) },
    };

    minioService = {
      readText: jest.fn(async (key: string) => {
        const value = stored.get(key);
        if (value === undefined) throw new Error(`NoSuchKey: ${key}`);
        return value;
      }),
      readBytes: jest.fn(async (key: string) => {
        const value = segments.get(key);
        if (value === undefined) throw new Error(`NoSuchKey: ${key}`);
        return value;
      }),
      uploadBuffer: jest.fn(async (key: string, buffer: Buffer) => {
        const text = buffer.toString('utf-8');
        written.set(key, text);
        stored.set(key, text);
      }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HlsSubtitlesService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        {
          provide: StorageService,
          useValue: {
            hlsSubtitleVttKey: (movieId: string, id: string) =>
              `videos/${movieId}/hls/subs/${id}.vtt`,
            hlsSubtitlePlaylistKey: (movieId: string, id: string) =>
              `videos/${movieId}/hls/subs/${id}.m3u8`,
          },
        },
      ],
    }).compile();

    service = module.get(HlsSubtitlesService);
  });

  describe('publishForVideo writes both objects', () => {
    it('writes the converted WebVTT under the movie hls/subs prefix', async () => {
      await service.publishForVideo(VIDEO_ID);

      const vtt = written.get(`videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`);
      expect(vtt).toBeDefined();
      expect(vtt).toContain('00:00:01.234 --> 00:00:03.456');
      expect(vtt).toContain('Hello there.');
    });

    it('anchors X-TIMESTAMP-MAP to the media\'s real initial PTS', async () => {
      await service.publishForVideo(VIDEO_ID);

      // Probed off the first segment of the first variant, NOT a constant:
      // every player shifts cues by (MPEGTS - real initial PTS) / 90000, so
      // the conventional 900000 over ffmpeg output (~129900) would land every
      // cue 8.6s late while the manifest still looked perfectly valid.
      const vtt = written.get(`videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`);
      expect(vtt?.split('\n').slice(0, 2)).toEqual([
        'WEBVTT',
        hlsTimestampMap(INITIAL_PTS),
      ]);
      expect(vtt).not.toContain('MPEGTS:900000');
      expect(minioService.readBytes).toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
        expect.any(Number),
      );
    });

    it('falls back to MPEGTS:0 when the first segment cannot be probed', async () => {
      // Both hls.js and AVFoundation treat an absent map as MPEGTS:0, so this
      // is the same assumption they would make on their own — and it is the
      // truth for an fMP4 timeline, which starts at zero.
      segments.clear();

      await service.publishForVideo(VIDEO_ID);

      const vtt = written.get(`videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`);
      expect(vtt?.split('\n')[1]).toBe(hlsTimestampMap(0));
    });

    it('writes the single-segment media playlist next to it', async () => {
      await service.publishForVideo(VIDEO_ID);

      const playlist = written.get(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`,
      );
      expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
      expect(playlist).toContain(`${SUBTITLE_ID}.vtt`);
      expect(playlist).toContain('#EXT-X-ENDLIST');
    });

    it('recovers the unknown duration by summing the first variant playlist', async () => {
      await service.publishForVideo(VIDEO_ID);

      const playlist = written.get(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`,
      );
      expect(playlist).toContain('#EXT-X-TARGETDURATION:10');
      expect(playlist).toContain('#EXTINF:10.000,');
    });

    it('prefers the probed duration when the video has one', async () => {
      prisma.video.findUnique.mockResolvedValue({
        id: VIDEO_ID,
        movieId: MOVIE_ID,
        status: 'READY',
        duration: 372,
        hlsMasterPath: MASTER_KEY,
      });

      await service.publishForVideo(VIDEO_ID);

      expect(
        written.get(`videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`),
      ).toContain('#EXT-X-TARGETDURATION:372');
    });

    it('rewrites the master in place, in MinIO', async () => {
      const result = await service.publishForVideo(VIDEO_ID);

      const master = written.get(MASTER_KEY);
      expect(master).toContain(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs/${SUBTITLE_ID}.m3u8"`,
      );
      expect(result.masterUpdated).toBe(true);
      expect(result.published).toHaveLength(1);
    });
  });

  describe('idempotence against the real storage round-trip', () => {
    it('leaves the master byte-identical on a second publish and skips the write', async () => {
      await service.publishForVideo(VIDEO_ID);
      const afterFirst = stored.get(MASTER_KEY);

      written.clear();
      const second = await service.publishForVideo(VIDEO_ID);

      expect(stored.get(MASTER_KEY)).toBe(afterFirst);
      expect(second.masterUpdated).toBe(false);
      expect(written.has(MASTER_KEY)).toBe(false);
    });
  });

  describe('a movie with no subtitles', () => {
    it('leaves the master exactly as ffmpeg produced it and writes nothing', async () => {
      prisma.subtitle.findMany.mockResolvedValue([]);

      const result = await service.publishForVideo(VIDEO_ID);

      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      expect(stored.get(MASTER_KEY)).toBe(MASTER);
      expect(result.masterUpdated).toBe(false);
    });
  });

  describe('ASS', () => {
    it('is excluded from the manifest but reported, and its row is left alone', async () => {
      prisma.subtitle.findMany.mockResolvedValue([
        englishRow({
          format: 'ASS',
          objectKey: `subtitles/${SUBTITLE_ID}/original.ass`,
        }),
      ]);

      const result = await service.publishForVideo(VIDEO_ID);

      expect(result.published).toHaveLength(0);
      expect(result.excluded).toEqual([
        {
          id: SUBTITLE_ID,
          format: 'ASS',
          reason: expect.stringContaining('ASS/SSA cannot be converted'),
        },
      ]);
      expect(stored.get(MASTER_KEY)).toBe(MASTER);
    });

    it('does not stop the SRT tracks alongside it from publishing', async () => {
      prisma.subtitle.findMany.mockResolvedValue([
        englishRow(),
        englishRow({
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          format: 'ASS',
          label: 'Styled',
          isDefault: false,
          objectKey: 'subtitles/styled/original.ass',
        }),
      ]);

      const result = await service.publishForVideo(VIDEO_ID);

      expect(result.published.map((p) => p.id)).toEqual([SUBTITLE_ID]);
      expect(result.excluded).toHaveLength(1);
      expect(written.get(MASTER_KEY)?.match(/#EXT-X-MEDIA:/g)).toHaveLength(1);
    });
  });

  describe('robustness', () => {
    it('never advertises a track whose source file cannot be read', async () => {
      stored.delete(`subtitles/${SUBTITLE_ID}/original.srt`);

      const result = await service.publishForVideo(VIDEO_ID);

      expect(result.published).toHaveLength(0);
      expect(result.excluded[0].reason).toContain('could not be published');
      expect(stored.get(MASTER_KEY)).toBe(MASTER);
    });

    it('does nothing at all while the video is still transcoding', async () => {
      prisma.video.findUnique.mockResolvedValue({
        id: VIDEO_ID,
        movieId: MOVIE_ID,
        status: 'PROCESSING',
        duration: null,
        hlsMasterPath: null,
      });

      const result = await service.publishForVideo(VIDEO_ID);

      expect(result.skipped).toContain('not READY');
      expect(minioService.readText).not.toHaveBeenCalled();
      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
    });
  });

  describe('unpublishSubtitle', () => {
    it('deletes both published objects for the track', async () => {
      await service.unpublishSubtitle(MOVIE_ID, SUBTITLE_ID);

      expect(minioService.deleteObject).toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`,
      );
      expect(minioService.deleteObject).toHaveBeenCalledWith(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`,
      );
    });

    it('tolerates an object that was never published', async () => {
      minioService.deleteObject.mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        service.unpublishSubtitle(MOVIE_ID, SUBTITLE_ID),
      ).resolves.toBeUndefined();
    });
  });

  describe('publishForMovie', () => {
    it('resolves the movie latest video and publishes for it', async () => {
      await service.publishForMovie(MOVIE_ID);

      expect(prisma.video.findFirst).toHaveBeenCalledWith({
        where: { movieId: MOVIE_ID },
        orderBy: { createdAt: 'desc' },
      });
      expect(written.has(MASTER_KEY)).toBe(true);
    });

    it('reports a movie that has no video yet instead of throwing', async () => {
      prisma.video.findFirst.mockResolvedValue(null);

      const result = await service.publishForMovie(MOVIE_ID);

      expect(result.skipped).toBe('this movie has no video yet');
    });
  });
});
