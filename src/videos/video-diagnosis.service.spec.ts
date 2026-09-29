import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoDiagnosisService } from './video-diagnosis.service';
import { VideosService } from './videos.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StreamKeyNotSignable } from '../common/storage/stream-signature';
import { VideoStatus } from '../generated/prisma/client';

const MOVIE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIDEO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MASTER_KEY = `videos/${MOVIE_ID}/hls/master.m3u8`;
const ORIGINAL_KEY = `videos/${MOVIE_ID}/original.mp4`;
const P720 = `videos/${MOVIE_ID}/hls/720p/index.m3u8`;
const P480 = `videos/${MOVIE_ID}/hls/480p/index.m3u8`;
const SIGNED_PATH = `/s/1800000000/tok/movies/${MASTER_KEY}`;

const VARIANT_720 =
  '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nsegment_000.ts\n';

/** A healthy READY row — every case starts from this and breaks one thing. */
const readyVideo = () => ({
  id: VIDEO_ID,
  movieId: MOVIE_ID,
  status: VideoStatus.READY,
  originalPath: ORIGINAL_KEY,
  originalFilename: 'original.mp4',
  hlsMasterPath: MASTER_KEY,
  renditions: [
    { resolution: '480p', playlistPath: P480 },
    { resolution: '720p', playlistPath: P720 },
  ],
  failureReason: null,
  duration: 5400,
  resolution: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
});

/** A fetch Response stand-in — only status and text() are read. */
const response = (status: number, body: string) =>
  ({ status, text: async () => body }) as unknown as Response;

describe('VideoDiagnosisService', () => {
  let service: VideoDiagnosisService;
  let prisma: {
    movie: { findUnique: jest.Mock };
    subtitle: { findMany: jest.Mock };
  };
  let videosService: { findLatestForMovie: jest.Mock };
  let minioService: {
    objectExists: jest.Mock;
    objectSize: jest.Mock;
    readBytes: jest.Mock;
    signedPlaybackUrl: jest.Mock;
    signedPlaybackPath: jest.Mock;
    playbackBaseUrl: jest.Mock;
  };
  let env: Record<string, string | undefined>;
  let fetchSpy: jest.SpyInstance;
  /** Object keys that exist in the mocked bucket. */
  let present: Set<string>;

  const checkNamed = (
    result: { checks: { name: string; ok: boolean; detail: string }[] },
    name: string,
  ) => result.checks.find((check) => check.name === name);

  beforeEach(async () => {
    jest.clearAllMocks();
    present = new Set([
      ORIGINAL_KEY,
      MASTER_KEY,
      P720,
      P480,
      `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
      `subtitles/${MOVIE_ID}/english.vtt`,
    ]);
    env = {};

    prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: MOVIE_ID }) },
      subtitle: { findMany: jest.fn().mockResolvedValue([]) },
    };
    videosService = {
      findLatestForMovie: jest.fn().mockResolvedValue(readyVideo()),
    };
    minioService = {
      objectExists: jest.fn(async (key: string) => present.has(key)),
      objectSize: jest.fn(async (key: string) =>
        present.has(key) ? 123_456 : null,
      ),
      readBytes: jest.fn(async (key: string) => {
        if (key === P720) return Buffer.from(VARIANT_720);
        throw new Error(`NoSuchKey ${key}`);
      }),
      signedPlaybackUrl: jest.fn(
        (key: string) => `http://localhost:8080${SIGNED_PATH}`,
      ),
      signedPlaybackPath: jest.fn(() => SIGNED_PATH),
      playbackBaseUrl: jest.fn(() => 'http://localhost:8080'),
    };
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(200, '#EXTM3U\n#EXT-X-VERSION:3\n'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoDiagnosisService,
        { provide: PrismaService, useValue: prisma },
        { provide: VideosService, useValue: videosService },
        { provide: MinioService, useValue: minioService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => env[key]) },
        },
      ],
    }).compile();

    service = module.get(VideoDiagnosisService);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws NotFoundException for a movie that does not exist', async () => {
    prisma.movie.findUnique.mockResolvedValue(null);

    await expect(service.diagnose(MOVIE_ID)).rejects.toThrow(NotFoundException);
    expect(videosService.findLatestForMovie).not.toHaveBeenCalled();
  });

  it('reports every check green and suggests nothing for a healthy title', async () => {
    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(true);
    expect(result.suggestedAction).toBe('none');
    expect(result.checks.map((check) => check.name)).toEqual([
      'video_row',
      'video_status',
      'original_object',
      'hls_master',
      'renditions_json',
      'rendition:480p',
      'rendition:720p',
      'segment_sample',
      'cacheserver_master',
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    // The sampled segment is the TOP rendition's first segment, resolved
    // relative to that playlist's folder.
    expect(checkNamed(result, 'segment_sample')?.detail).toBe(
      `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
    );
  });

  it('reads a REPLACED title entirely from its row — versioned master, playlists and the segment resolved beside them', async () => {
    // After a video replace the package lives in hls/v-<tag>/ and the Video
    // row is the only record of that; nothing here may rebuild a key from
    // the movie id, or the diagnosis would check the deleted old package.
    const pkg = `videos/${MOVIE_ID}/hls/v-abc123`;
    const versioned = {
      ...readyVideo(),
      hlsMasterPath: `${pkg}/master.m3u8`,
      renditions: [
        { resolution: '480p', playlistPath: `${pkg}/480p/index.m3u8` },
        { resolution: '720p', playlistPath: `${pkg}/720p/index.m3u8` },
      ],
    };
    videosService.findLatestForMovie.mockResolvedValue(versioned);
    present = new Set([
      ORIGINAL_KEY,
      `${pkg}/master.m3u8`,
      `${pkg}/480p/index.m3u8`,
      `${pkg}/720p/index.m3u8`,
      `${pkg}/720p/segment_000.ts`,
    ]);
    minioService.readBytes.mockImplementation(async (key: string) => {
      if (key === `${pkg}/720p/index.m3u8`) return Buffer.from(VARIANT_720);
      throw new Error(`NoSuchKey ${key}`);
    });

    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(true);
    expect(result.suggestedAction).toBe('none');
    expect(checkNamed(result, 'hls_master')?.detail).toBe(`${pkg}/master.m3u8`);
    expect(checkNamed(result, 'rendition:720p')?.detail).toBe(
      `${pkg}/720p/index.m3u8`,
    );
    expect(checkNamed(result, 'segment_sample')?.detail).toBe(
      `${pkg}/720p/segment_000.ts`,
    );
    expect(minioService.signedPlaybackUrl).toHaveBeenCalledWith(
      `${pkg}/master.m3u8`,
    );
    // The old un-versioned keys are never touched.
    for (const key of minioService.objectExists.mock.calls.map(
      ([k]) => k as string,
    )) {
      expect(key).not.toBe(MASTER_KEY);
      expect(key).not.toBe(P720);
    }
  });

  it('suggests replace with the whole checklist marked skipped when there is no Video row', async () => {
    videosService.findLatestForMovie.mockResolvedValue(null);

    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe('replace');
    expect(checkNamed(result, 'video_row')?.ok).toBe(false);
    expect(
      result.checks
        .filter((check) => check.detail === 'skipped')
        .map((c) => c.name),
    ).toEqual([
      'video_status',
      'original_object',
      'hls_master',
      'renditions_json',
      'segment_sample',
      'cacheserver_master',
    ]);
    expect(minioService.objectExists).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suggests reprocess for a FAILED video whose archived original is still there', async () => {
    videosService.findLatestForMovie.mockResolvedValue({
      ...readyVideo(),
      status: VideoStatus.FAILED,
      failureReason: 'ffmpeg exited 1',
      hlsMasterPath: null,
      renditions: null,
    });

    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe('reprocess');
    expect(checkNamed(result, 'video_status')).toEqual({
      name: 'video_status',
      ok: false,
      detail: 'status=FAILED failureReason=ffmpeg exited 1',
    });
    expect(checkNamed(result, 'original_object')?.ok).toBe(true);
    expect(checkNamed(result, 'hls_master')?.detail).toBe('no master path');
    expect(checkNamed(result, 'cacheserver_master')?.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suggests replace for a FAILED video whose original was never archived (local scratch path)', async () => {
    videosService.findLatestForMovie.mockResolvedValue({
      ...readyVideo(),
      status: VideoStatus.FAILED,
      originalPath: `/app/storage/temp/videos/${MOVIE_ID}/original.mp4`,
    });

    const result = await service.diagnose(MOVIE_ID);

    expect(result.suggestedAction).toBe('replace');
    expect(checkNamed(result, 'original_object')?.ok).toBe(false);
    expect(checkNamed(result, 'original_object')?.detail).toContain(
      'never archived',
    );
    // A local path is never HEADed against the bucket.
    expect(minioService.objectSize).not.toHaveBeenCalled();
  });

  it('suggests reprocess for a READY video whose master object is gone but whose original exists', async () => {
    present.delete(MASTER_KEY);

    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe('reprocess');
    expect(checkNamed(result, 'hls_master')).toEqual({
      name: 'hls_master',
      ok: false,
      detail: `${MASTER_KEY} is missing`,
    });
    expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
      'skipped',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('suggests replace for a READY video with a master but a missing segment', async () => {
    present.delete(`videos/${MOVIE_ID}/hls/720p/segment_000.ts`);

    const result = await service.diagnose(MOVIE_ID);

    expect(result.ok).toBe(false);
    expect(result.suggestedAction).toBe('replace');
    expect(checkNamed(result, 'segment_sample')).toEqual({
      name: 'segment_sample',
      ok: false,
      detail: `videos/${MOVIE_ID}/hls/720p/segment_000.ts is missing`,
    });
  });

  it('suggests replace when a rendition playlist is missing', async () => {
    present.delete(P480);

    const result = await service.diagnose(MOVIE_ID);

    expect(result.suggestedAction).toBe('replace');
    expect(checkNamed(result, 'rendition:480p')?.ok).toBe(false);
    expect(checkNamed(result, 'rendition:720p')?.ok).toBe(true);
  });

  describe('cacheserver_master — the fetch a viewer would make', () => {
    it('fetches the signed PATH through STREAM_INTERNAL_BASE_URL when set, and names both URLs', async () => {
      env.STREAM_INTERNAL_BASE_URL = 'http://host.docker.internal:8080/';

      const result = await service.diagnose(MOVIE_ID);

      expect(fetchSpy).toHaveBeenCalledWith(
        `http://host.docker.internal:8080${SIGNED_PATH}`,
        expect.objectContaining({
          redirect: 'manual',
          signal: expect.any(AbortSignal),
        }),
      );
      expect(checkNamed(result, 'cacheserver_master')).toEqual({
        name: 'cacheserver_master',
        ok: true,
        detail: `client url=http://localhost:8080${SIGNED_PATH} fetched=http://host.docker.internal:8080${SIGNED_PATH} status=200`,
      });
    });

    it('falls back to the request-derived playback base when no internal base is configured', async () => {
      await service.diagnose(MOVIE_ID);

      expect(fetchSpy).toHaveBeenCalledWith(
        `http://localhost:8080${SIGNED_PATH}`,
        expect.anything(),
      );
    });

    it('a 403 alone is ok=false with a signing hint and suggestedAction none — config, not media', async () => {
      fetchSpy.mockResolvedValue(response(403, ''));

      const result = await service.diagnose(MOVIE_ID);

      expect(result.ok).toBe(false);
      expect(result.suggestedAction).toBe('none');
      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'status=403 signature rejected (STREAM_SIGNING_SECRET mismatch?)',
      );
    });

    it('a 410 reads as an expired token', async () => {
      fetchSpy.mockResolvedValue(response(410, ''));

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'status=410 token expired',
      );
      expect(result.suggestedAction).toBe('none');
    });

    it('a 200 whose body is not a playlist is not a pass', async () => {
      fetchSpy.mockResolvedValue(response(200, '<html>not found</html>'));

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'cacheserver_master')?.ok).toBe(false);
      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'body is not an HLS playlist',
      );
    });

    it('a timeout is reported as no answer within 5 s, still suggestedAction none', async () => {
      fetchSpy.mockRejectedValue(
        Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        }),
      );

      const result = await service.diagnose(MOVIE_ID);

      expect(result.ok).toBe(false);
      expect(result.suggestedAction).toBe('none');
      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'no answer within 5 s',
      );
    });

    it('a connection refusal names the cause code so a wrong reach address explains itself', async () => {
      fetchSpy.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        }),
      );

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'TypeError: fetch failed (ECONNREFUSED)',
      );
    });

    it('reports an unsignable master path instead of throwing', async () => {
      minioService.signedPlaybackUrl.mockImplementation(() => {
        throw new StreamKeyNotSignable('legacy/path/master.m3u8');
      });

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'cacheserver_master')?.ok).toBe(false);
      expect(checkNamed(result, 'cacheserver_master')?.detail).toContain(
        'cannot be signed',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('renditions_json — parsed totally, never trusted', () => {
    it('fails the check and names the malformed entries, still checking the good ones', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        ...readyVideo(),
        renditions: [
          { resolution: '720p', playlistPath: P720 },
          'garbage',
          { resolution: '', playlistPath: P480 },
          { resolution: '480p' },
        ],
      });

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'renditions_json')).toEqual({
        name: 'renditions_json',
        ok: false,
        detail:
          '#1 is not an object; #2 has no resolution; #3 (480p) has no playlistPath',
      });
      expect(checkNamed(result, 'rendition:720p')?.ok).toBe(true);
      expect(result.suggestedAction).toBe('replace');
    });

    it('fails the check when the column is not a list at all', async () => {
      videosService.findLatestForMovie.mockResolvedValue({
        ...readyVideo(),
        renditions: { resolution: '720p' },
      });

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'renditions_json')?.ok).toBe(false);
      expect(checkNamed(result, 'renditions_json')?.detail).toContain(
        'not a list',
      );
      expect(checkNamed(result, 'segment_sample')?.detail).toContain('skipped');
    });
  });

  describe('segment_sample — the playlist is followed like a player would, but never outside its folder', () => {
    it('rejects a `..` segment URI without HEADing anything', async () => {
      minioService.readBytes.mockResolvedValue(
        Buffer.from('#EXTM3U\n#EXTINF:6.0,\n../../other/segment_000.ts\n'),
      );

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'segment_sample')?.ok).toBe(false);
      expect(checkNamed(result, 'segment_sample')?.detail).toContain(
        'outside its folder',
      );
      expect(minioService.objectExists).not.toHaveBeenCalledWith(
        expect.stringContaining('other/segment_000.ts'),
      );
    });

    it('rejects an absolute URI the same way', async () => {
      minioService.readBytes.mockResolvedValue(
        Buffer.from('#EXTM3U\n#EXTINF:6.0,\nhttp://evil.example/seg.ts\n'),
      );

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'segment_sample')?.ok).toBe(false);
      expect(checkNamed(result, 'segment_sample')?.detail).toContain(
        'outside its folder',
      );
    });

    it('reads a bounded head of the TOP rendition only', async () => {
      await service.diagnose(MOVIE_ID);

      expect(minioService.readBytes).toHaveBeenCalledTimes(1);
      expect(minioService.readBytes).toHaveBeenCalledWith(P720, 256 * 1024);
    });

    it('reports an unreadable playlist instead of throwing', async () => {
      present.delete(P720);
      minioService.readBytes.mockRejectedValue(new Error('NoSuchKey'));

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'segment_sample')?.ok).toBe(false);
      expect(checkNamed(result, 'segment_sample')?.detail).toContain(
        `could not read ${P720}`,
      );
      expect(result.suggestedAction).toBe('replace');
    });
  });

  describe('subtitle_source — one line per Subtitle row', () => {
    it('HEADs every track and a missing one is ok=false with suggestedAction none', async () => {
      prisma.subtitle.findMany.mockResolvedValue([
        {
          id: 's1',
          label: 'English',
          language: 'en',
          format: 'VTT',
          objectKey: `subtitles/${MOVIE_ID}/english.vtt`,
        },
        {
          id: 's2',
          label: 'Myanmar',
          language: 'my',
          format: 'SRT',
          objectKey: `subtitles/${MOVIE_ID}/myanmar.srt`,
        },
      ]);

      const result = await service.diagnose(MOVIE_ID);

      expect(checkNamed(result, 'subtitle_source:English')).toEqual({
        name: 'subtitle_source:English',
        ok: true,
        detail: `en VTT subtitles/${MOVIE_ID}/english.vtt`,
      });
      expect(checkNamed(result, 'subtitle_source:Myanmar')?.ok).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.suggestedAction).toBe('none');
      expect(prisma.subtitle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { videoId: VIDEO_ID } }),
      );
    });
  });

  it('never puts a credential in a detail line — only the same playback token a viewer gets', async () => {
    env.STREAM_INTERNAL_BASE_URL = 'http://host.docker.internal:8080';

    const result = await service.diagnose(MOVIE_ID);

    const details = result.checks.map((check) => check.detail).join('\n');
    expect(details).not.toMatch(/secret|access_key|password/i);
    expect(details).toContain(SIGNED_PATH);
  });
});
