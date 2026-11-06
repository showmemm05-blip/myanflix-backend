import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClientPlatform } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LOTTERY_ACTIVITY_THROTTLE_MS,
  LotteryActivityService,
  mmtHourStartOf,
} from './lottery-activity.service';

/**
 * 13:47:31.5 UTC = 20:17:31.5 MMT — inside the 20:00 MMT hour, whose start
 * is 13:30 UTC (buckets are aligned to the Myanmar hour, not the UTC one).
 */
const NOW = new Date('2026-10-23T13:47:31.500Z');
const HOUR_START = new Date('2026-10-23T13:30:00.000Z');

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('LotteryActivityService', () => {
  let service: LotteryActivityService;
  let prisma: {
    lotteryActivity: Record<'upsert' | 'aggregate', jest.Mock>;
  };

  beforeEach(async () => {
    prisma = {
      lotteryActivity: {
        upsert: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _min: { hourStart: null } }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryActivityService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LotteryActivityService);
  });

  describe('mmtHourStartOf — the bucket is the Myanmar hour', () => {
    it('lands at :30 past the UTC hour (an MMT top-of-hour) and keeps 00:00–00:30 MMT in its own day', () => {
      expect(mmtHourStartOf(NOW)).toEqual(HOUR_START);
      // 13:29:59.999 UTC = 19:59:59.999 MMT → the 19:00 MMT bucket (12:30 UTC).
      expect(mmtHourStartOf(new Date('2026-10-23T13:29:59.999Z'))).toEqual(
        new Date('2026-10-23T12:30:00.000Z'),
      );
      // 17:40 UTC = 00:10 MMT on the 24th → the 00:00 MMT bucket of the 24th (17:30 UTC on the 23rd).
      expect(mmtHourStartOf(new Date('2026-10-23T17:40:00.000Z'))).toEqual(
        new Date('2026-10-23T17:30:00.000Z'),
      );
      // Shifting the bucket by +390 minutes reads as an exact MMT top of the hour.
      const mmt = new Date(HOUR_START.getTime() + 390 * 60_000);
      expect(mmt.getUTCMinutes()).toBe(0);
      expect(mmt.getUTCHours()).toBe(20);
    });
  });

  describe('record — the upsert', () => {
    it('creates the (user, platform, MMT hour) row on the first ping of the hour and bumps pings/lastAt afterwards', async () => {
      await service.record('user-1', ClientPlatform.MOBILE, NOW);

      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledWith({
        where: {
          userId_platform_hourStart: {
            userId: 'user-1',
            platform: ClientPlatform.MOBILE,
            hourStart: HOUR_START,
          },
        },
        create: {
          userId: 'user-1',
          platform: ClientPlatform.MOBILE,
          hourStart: HOUR_START,
          pings: 1,
          firstAt: NOW,
          lastAt: NOW,
        },
        update: {
          pings: { increment: 1 },
          lastAt: NOW,
        },
      });
    });

    it('keys the bucket by platform, so the same user on web and mobile is two rows', async () => {
      await service.record('user-1', ClientPlatform.WEB, NOW);
      await service.record(
        'user-2',
        ClientPlatform.UNKNOWN,
        later(LOTTERY_ACTIVITY_THROTTLE_MS),
      );

      expect(prisma.lotteryActivity.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            userId_platform_hourStart: expect.objectContaining({
              platform: ClientPlatform.WEB,
            }),
          },
        }),
      );
      expect(prisma.lotteryActivity.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            userId_platform_hourStart: expect.objectContaining({
              userId: 'user-2',
              platform: ClientPlatform.UNKNOWN,
            }),
          },
        }),
      );
    });

    it('never rejects: a failed write is logged and swallowed', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      prisma.lotteryActivity.upsert.mockRejectedValue(new Error('db down'));

      await expect(
        service.record('user-1', ClientPlatform.WEB, NOW),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
      warn.mockRestore();
    });
  });

  describe('record — throttling (one write per user per minute)', () => {
    it('writes on the first ping for a user', async () => {
      await service.record('user-1', ClientPlatform.MOBILE, NOW);

      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(1);
    });

    it('writes once for a burst of pings inside the window', async () => {
      await Promise.all([
        service.record('user-1', ClientPlatform.MOBILE, NOW),
        service.record('user-1', ClientPlatform.MOBILE, later(10)),
        service.record('user-1', ClientPlatform.MOBILE, later(20_000)),
      ]);

      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(1);
    });

    it('writes again only once the window has elapsed', async () => {
      await service.record('user-1', ClientPlatform.MOBILE, NOW);
      await service.record(
        'user-1',
        ClientPlatform.MOBILE,
        later(LOTTERY_ACTIVITY_THROTTLE_MS - 1),
      );
      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(1);

      await service.record(
        'user-1',
        ClientPlatform.MOBILE,
        later(LOTTERY_ACTIVITY_THROTTLE_MS),
      );
      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(2);
    });

    it('throttles per user, not globally', async () => {
      await service.record('user-1', ClientPlatform.MOBILE, NOW);
      await service.record('user-2', ClientPlatform.MOBILE, NOW);

      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(2);
    });

    it('keeps the stamp when the write fails, so a database problem is not a write storm', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      prisma.lotteryActivity.upsert.mockRejectedValue(new Error('db down'));

      await service.record('user-1', ClientPlatform.MOBILE, NOW);
      await service.record('user-1', ClientPlatform.MOBILE, later(5_000));

      expect(prisma.lotteryActivity.upsert).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
    });
  });

  describe('firstActivityAt', () => {
    it('is null before the first ping', async () => {
      await expect(service.firstActivityAt()).resolves.toBeNull();
      expect(prisma.lotteryActivity.aggregate).toHaveBeenCalledWith({
        _min: { hourStart: true },
      });
    });

    it('is the earliest hour bucket on record', async () => {
      prisma.lotteryActivity.aggregate.mockResolvedValue({
        _min: { hourStart: HOUR_START },
      });

      await expect(service.firstActivityAt()).resolves.toEqual(HOUR_START);
    });
  });
});
