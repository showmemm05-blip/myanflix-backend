import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdPlaybackCleanupService,
  DEAD_PLAYBACK_MAX_AGE_MS,
  LOAD_FAILURE_MAX_AGE_MS,
} from './ad-playback-cleanup.service';

describe('AdPlaybackCleanupService', () => {
  let service: AdPlaybackCleanupService;
  let prisma: { advertisementPlayback: { deleteMany: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      advertisementPlayback: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdPlaybackCleanupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AdPlaybackCleanupService);
  });

  it('drops unplayed decisions after a week, and failed-to-load rows only after a year — never an impression', async () => {
    const now = new Date('2026-11-10T04:00:00Z');
    await expect(service.sweepDeadPlaybacks(now)).resolves.toBe(6);
    expect(prisma.advertisementPlayback.deleteMany).toHaveBeenCalledWith({
      where: {
        startedAt: null,
        createdAt: { lt: new Date(now.getTime() - DEAD_PLAYBACK_MAX_AGE_MS) },
        status: { in: ['PENDING', 'ABANDONED'] },
      },
    });
    expect(prisma.advertisementPlayback.deleteMany).toHaveBeenCalledWith({
      where: {
        startedAt: null,
        createdAt: { lt: new Date(now.getTime() - LOAD_FAILURE_MAX_AGE_MS) },
        status: 'FAILED',
      },
    });
    expect(LOAD_FAILURE_MAX_AGE_MS).toBeGreaterThanOrEqual(
      366 * 24 * 60 * 60 * 1000,
    );
  });

  it('logs and returns 0 when the database refuses — never throws out of the cron', async () => {
    prisma.advertisementPlayback.deleteMany.mockRejectedValue(
      new Error('db down'),
    );
    await expect(service.sweepDeadPlaybacks()).resolves.toBe(0);
  });
});
