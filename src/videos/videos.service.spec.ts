import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccessType, Role, VideoStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingService } from '../tracking/tracking.service';
import { VideosService } from './videos.service';

describe('VideosService — recordWatchProgress', () => {
  let service: VideosService;
  let prisma: {
    movie: { findUnique: jest.Mock };
    watchHistory: { findUnique: jest.Mock; upsert: jest.Mock };
  };
  let trackingService: { recordWatchActivity: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue({ id: 'movie-1' }) },
      watchHistory: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: 'history-1',
          userId: 'user-1',
          movieId: 'movie-1',
          progress: 40,
          lastPosition: 240,
        }),
      },
    };
    trackingService = {
      recordWatchActivity: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: {} },
        { provide: TrackingService, useValue: trackingService },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('upserts watch history exactly as before and returns it unchanged', async () => {
    const result = await service.recordWatchProgress(
      'user-1',
      'movie-1',
      40,
      240,
    );

    expect(prisma.watchHistory.upsert).toHaveBeenCalledWith({
      where: { userId_movieId: { userId: 'user-1', movieId: 'movie-1' } },
      create: {
        userId: 'user-1',
        movieId: 'movie-1',
        progress: 40,
        lastPosition: 240,
      },
      update: { progress: 40, lastPosition: 240 },
    });
    expect(result).toEqual(
      expect.objectContaining({ id: 'history-1', lastPosition: 240 }),
    );
  });

  it('derives the watch delta from the STORED previous position, never the client', async () => {
    prisma.watchHistory.findUnique.mockResolvedValue({ lastPosition: 225 });

    await service.recordWatchProgress('user-1', 'movie-1', 40, 240);

    expect(trackingService.recordWatchActivity).toHaveBeenCalledWith({
      userId: 'user-1',
      movieId: 'movie-1',
      previousPosition: 225,
      nextPosition: 240,
    });
  });

  it('reads the previous position BEFORE the upsert overwrites it', async () => {
    const order: string[] = [];
    prisma.watchHistory.findUnique.mockImplementation(() => {
      order.push('read');
      return Promise.resolve({ lastPosition: 225 });
    });
    prisma.watchHistory.upsert.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({});
    });

    await service.recordWatchProgress('user-1', 'movie-1', 40, 240);

    expect(order).toEqual(['read', 'write']);
  });

  it('treats a first-ever heartbeat as starting from 0', async () => {
    prisma.watchHistory.findUnique.mockResolvedValue(null);

    await service.recordWatchProgress('user-1', 'movie-1', 2, 8);

    expect(trackingService.recordWatchActivity).toHaveBeenCalledWith(
      expect.objectContaining({ previousPosition: 0, nextPosition: 8 }),
    );
  });

  it('404s before touching anything when the movie does not exist', async () => {
    prisma.movie.findUnique.mockResolvedValue(null);

    await expect(
      service.recordWatchProgress('user-1', 'movie-1', 40, 240),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.watchHistory.upsert).not.toHaveBeenCalled();
    expect(trackingService.recordWatchActivity).not.toHaveBeenCalled();
  });

  it('still saves the heartbeat when watch-activity tracking fails', async () => {
    trackingService.recordWatchActivity.mockRejectedValue(new Error('db down'));

    await expect(
      service.recordWatchProgress('user-1', 'movie-1', 40, 240),
    ).resolves.toEqual(expect.objectContaining({ id: 'history-1' }));
    expect(prisma.watchHistory.upsert).toHaveBeenCalled();
  });
});

/**
 * The stream grant. The subscription check is the ONLY thing between a
 * viewer and a playable link now that the link itself carries the cache
 * server's token, so these pin down two things: who gets past the check,
 * and that every URL in a successful response is the SIGNED one.
 */
describe('VideosService — getStreamInfo', () => {
  const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
  const MASTER_KEY = `videos/${MOVIE_ID}/hls/master.m3u8`;

  let service: VideosService;
  let prisma: {
    movie: { findUnique: jest.Mock };
    video: { findFirst: jest.Mock };
    subtitle: { findMany: jest.Mock };
    userSubscription: { findFirst: jest.Mock };
  };
  let minioService: { signedPlaybackUrl: jest.Mock; playbackUrl: jest.Mock };

  const readyVideo = {
    id: 'video-1',
    status: VideoStatus.READY,
    hlsMasterPath: MASTER_KEY,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      movie: {
        findUnique: jest.fn().mockResolvedValue({
          id: MOVIE_ID,
          accessType: AccessType.SUBSCRIPTION,
          series: null,
        }),
      },
      video: { findFirst: jest.fn().mockResolvedValue(readyVideo) },
      subtitle: { findMany: jest.fn().mockResolvedValue([]) },
      userSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    minioService = {
      signedPlaybackUrl: jest.fn((key: string) => `signed:${key}`),
      playbackUrl: jest.fn((key: string) => `plain:${key}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: TrackingService, useValue: {} },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('403s a USER without an active subscription on a SUBSCRIPTION movie, before any URL is minted', async () => {
    await expect(
      service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.userSubscription.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', expiresAt: { gt: expect.any(Date) } },
    });
    expect(minioService.signedPlaybackUrl).not.toHaveBeenCalled();
    expect(minioService.playbackUrl).not.toHaveBeenCalled();
  });

  it('lets a subscribed USER through', async () => {
    prisma.userSubscription.findFirst.mockResolvedValue({ id: 'sub-1' });

    const result = await service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER);

    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
  });

  it('never asks about a subscription for a FREE movie', async () => {
    prisma.movie.findUnique.mockResolvedValue({
      id: MOVIE_ID,
      accessType: AccessType.FREE,
      series: null,
    });

    const result = await service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER);

    expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
  });

  it('lets an ADMIN through without the subscription lookup', async () => {
    const result = await service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN);

    expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
  });

  it('gates an episode by the parent series, not its own accessType', async () => {
    prisma.movie.findUnique.mockResolvedValue({
      id: MOVIE_ID,
      accessType: AccessType.FREE,
      series: { accessType: AccessType.SUBSCRIPTION },
    });

    await expect(
      service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER),
    ).rejects.toThrow(ForbiddenException);
    expect(minioService.signedPlaybackUrl).not.toHaveBeenCalled();
  });

  it('404s when the movie does not exist', async () => {
    prisma.movie.findUnique.mockResolvedValue(null);

    await expect(
      service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when there is no READY video, even for staff', async () => {
    prisma.video.findFirst.mockResolvedValue({
      ...readyVideo,
      status: VideoStatus.PROCESSING,
      hlsMasterPath: null,
    });

    await expect(
      service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN),
    ).rejects.toThrow(NotFoundException);
    expect(minioService.signedPlaybackUrl).not.toHaveBeenCalled();
  });

  it('signs the playlist AND every subtitle url — nothing plain leaks out', async () => {
    prisma.userSubscription.findFirst.mockResolvedValue({ id: 'sub-1' });
    prisma.subtitle.findMany.mockResolvedValue([
      {
        id: 'sub-en',
        language: 'en',
        label: 'English',
        format: 'SRT',
        isDefault: true,
        objectKey: `subtitles/${MOVIE_ID}/sub-en.srt`,
      },
      {
        id: 'sub-my',
        language: 'my',
        label: 'Myanmar',
        format: 'VTT',
        isDefault: false,
        objectKey: `subtitles/${MOVIE_ID}/sub-my.vtt`,
      },
    ]);

    const result = await service.getStreamInfo(MOVIE_ID, 'user-1', Role.USER);

    expect(result).toEqual({
      playlistUrl: `signed:${MASTER_KEY}`,
      // The fixture carries no `renditions` column at all — the honest answer
      // is an empty ladder, not a missing key, so a client never has to branch
      // on undefined.
      qualities: [],
      subtitles: [
        expect.objectContaining({
          id: 'sub-en',
          isDefault: true,
          url: `signed:subtitles/${MOVIE_ID}/sub-en.srt`,
        }),
        expect.objectContaining({
          id: 'sub-my',
          isDefault: false,
          url: `signed:subtitles/${MOVIE_ID}/sub-my.vtt`,
        }),
      ],
    });
    expect(prisma.subtitle.findMany).toHaveBeenCalledWith({
      where: { videoId: 'video-1' },
    });
    expect(minioService.playbackUrl).not.toHaveBeenCalled();
  });

  /**
   * The ladder as something a client can pin. These pin down the three things
   * a player depends on: every rung is SIGNED (a rendition playlist is fetched
   * by the same cache server, under the same token as the master), the order is
   * decided here rather than by whichever producer wrote the column, and a
   * column that cannot be trusted degrades instead of failing the stream.
   */
  it('signs every rendition playlist and returns it best-first', async () => {
    prisma.video.findFirst.mockResolvedValue({
      ...readyVideo,
      // Ascending, the order the bulk-upload path writes — the response must
      // not echo it.
      renditions: [
        { resolution: '240p', playlistPath: `videos/${MOVIE_ID}/hls/240p/index.m3u8` },
        { resolution: '720p', playlistPath: `videos/${MOVIE_ID}/hls/720p/index.m3u8` },
        { resolution: '480p', playlistPath: `videos/${MOVIE_ID}/hls/480p/index.m3u8` },
      ],
    });

    const result = await service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN);

    expect(result.qualities).toEqual([
      { label: '720p', url: `signed:videos/${MOVIE_ID}/hls/720p/index.m3u8` },
      { label: '480p', url: `signed:videos/${MOVIE_ID}/hls/480p/index.m3u8` },
      { label: '240p', url: `signed:videos/${MOVIE_ID}/hls/240p/index.m3u8` },
    ]);
    // The master is still the response's own playlistUrl — "Auto" is unchanged.
    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
    expect(minioService.playbackUrl).not.toHaveBeenCalled();
  });

  it('returns an empty ladder when renditions is null', async () => {
    prisma.video.findFirst.mockResolvedValue({
      ...readyVideo,
      renditions: null,
    });

    const result = await service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN);

    expect(result.qualities).toEqual([]);
    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
  });

  it('drops malformed entries instead of emitting a rung with no url', async () => {
    prisma.video.findFirst.mockResolvedValue({
      ...readyVideo,
      renditions: [
        'not-an-object',
        null,
        { resolution: '720p' },
        { playlistPath: `videos/${MOVIE_ID}/hls/480p/index.m3u8` },
        { resolution: '', playlistPath: `videos/${MOVIE_ID}/hls/360p/index.m3u8` },
        { resolution: '240p', playlistPath: `videos/${MOVIE_ID}/hls/240p/index.m3u8` },
      ],
    });

    const result = await service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN);

    expect(result.qualities).toEqual([
      { label: '240p', url: `signed:videos/${MOVIE_ID}/hls/240p/index.m3u8` },
    ]);
  });

  it('drops a rendition whose path cannot be signed rather than failing the stream', async () => {
    const LOCAL_PATH = '/var/tmp/transcode/720p/index.m3u8';
    minioService.signedPlaybackUrl.mockImplementation((key: string) => {
      // What stream-signature.ts really does with a key outside a scope: the
      // transcoder holds a LOCAL ffmpeg output path until the upload rewrites
      // it, and a legacy row can carry one for good.
      if (!key.startsWith('videos/')) throw new Error('StreamKeyNotSignable');
      return `signed:${key}`;
    });
    prisma.video.findFirst.mockResolvedValue({
      ...readyVideo,
      renditions: [
        { resolution: '720p', playlistPath: LOCAL_PATH },
        { resolution: '480p', playlistPath: `videos/${MOVIE_ID}/hls/480p/index.m3u8` },
      ],
    });

    const result = await service.getStreamInfo(MOVIE_ID, 'admin-1', Role.ADMIN);

    expect(result.qualities).toEqual([
      { label: '480p', url: `signed:videos/${MOVIE_ID}/hls/480p/index.m3u8` },
    ]);
    expect(result.playlistUrl).toBe(`signed:${MASTER_KEY}`);
  });
});

describe('VideosService — getLatestStatusForMovie', () => {
  const MASTER_KEY =
    'videos/f41b5f3d-cadf-40ab-b789-4192ee772a5e/hls/master.m3u8';

  let service: VideosService;
  let prisma: { video: { findFirst: jest.Mock } };
  let minioService: { signedPlaybackUrl: jest.Mock; playbackUrl: jest.Mock };

  beforeEach(async () => {
    prisma = { video: { findFirst: jest.fn() } };
    minioService = {
      signedPlaybackUrl: jest.fn((key: string) => `signed:${key}`),
      playbackUrl: jest.fn((key: string) => `plain:${key}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: TrackingService, useValue: {} },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('signs hlsMasterPath', async () => {
    prisma.video.findFirst.mockResolvedValue({
      id: 'video-1',
      status: VideoStatus.READY,
      hlsMasterPath: MASTER_KEY,
      renditions: [],
    });

    const result = await service.getLatestStatusForMovie('movie-1');

    expect(result.hlsMasterPath).toBe(`signed:${MASTER_KEY}`);
    expect(minioService.playbackUrl).not.toHaveBeenCalled();
  });

  it('keeps a null hlsMasterPath null while processing', async () => {
    prisma.video.findFirst.mockResolvedValue({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      hlsMasterPath: null,
      renditions: null,
    });

    const result = await service.getLatestStatusForMovie('movie-1');

    expect(result.hlsMasterPath).toBeNull();
    expect(minioService.signedPlaybackUrl).not.toHaveBeenCalled();
  });

  it('404s when the movie has no video at all', async () => {
    prisma.video.findFirst.mockResolvedValue(null);

    await expect(service.getLatestStatusForMovie('movie-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
