import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
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
    trackingService.recordWatchActivity.mockRejectedValue(
      new Error('db down'),
    );

    await expect(
      service.recordWatchProgress('user-1', 'movie-1', 40, 240),
    ).resolves.toEqual(expect.objectContaining({ id: 'history-1' }));
    expect(prisma.watchHistory.upsert).toHaveBeenCalled();
  });
});
