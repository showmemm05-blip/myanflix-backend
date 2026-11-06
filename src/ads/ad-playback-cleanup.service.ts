import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdvertisementPlaybackStatus } from '../generated/prisma/client';
import { ANALYTICS_MAX_RANGE_DAYS } from '../lottery/analytics/lottery-analytics-period';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Decisions that were never played (PENDING / ABANDONED) are kept this long, for debugging a complaint, then dropped. */
export const DEAD_PLAYBACK_MAX_AGE_MS = 7 * DAY_MS;

/**
 * Ads that failed before their first frame are the analytics' "failed to
 * load" figure (counted on failedAt), so they stay as long as the longest
 * period the analytics page can ask for — plus a day for the time zone.
 */
export const LOAD_FAILURE_MAX_AGE_MS = (ANALYTICS_MAX_RANGE_DAYS + 1) * DAY_MS;

/**
 * Every decision that finds an ad writes a PENDING row, and most of them
 * are spent within seconds — but a viewer who opens a player page and never
 * presses Play, or a tab that lost the per-title race (ABANDONED), leave a
 * row no analytics figure reads (they all key on `startedAt`). This sweep
 * drops those after a week so the table only grows with real impressions;
 * a 60/min-per-account throttle on the decisions bounds the worst a
 * scripted client can add in between. A row that FAILED before its first
 * frame is read (the "failed to load" figure) and is kept for a year.
 */
@Injectable()
export class AdPlaybackCleanupService {
  private readonly logger = new Logger(AdPlaybackCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweepDeadPlaybacks(now = new Date()): Promise<number> {
    try {
      const [unplayed, failed] = await Promise.all([
        this.prisma.advertisementPlayback.deleteMany({
          where: {
            startedAt: null,
            createdAt: {
              lt: new Date(now.getTime() - DEAD_PLAYBACK_MAX_AGE_MS),
            },
            status: {
              in: [
                AdvertisementPlaybackStatus.PENDING,
                AdvertisementPlaybackStatus.ABANDONED,
              ],
            },
          },
        }),
        this.prisma.advertisementPlayback.deleteMany({
          where: {
            startedAt: null,
            createdAt: {
              lt: new Date(now.getTime() - LOAD_FAILURE_MAX_AGE_MS),
            },
            status: AdvertisementPlaybackStatus.FAILED,
          },
        }),
      ]);
      const count = unplayed.count + failed.count;
      if (count > 0) {
        this.logger.log(
          `Cleanup removed ${count} ad playback row(s) that never started`,
        );
      }
      return count;
    } catch (error) {
      this.logger.warn(
        `Could not sweep dead ad playbacks: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
