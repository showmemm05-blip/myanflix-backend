import { Injectable, Logger } from '@nestjs/common';
import type { ClientPlatform } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { hourStartOf } from '../../tracking/tracking.service';
import { MMT_OFFSET_MS } from './lottery-analytics-period';

/**
 * How often one user's lottery presence may be written. The app pings on
 * entering the lottery, on coming back to the foreground and every five
 * minutes; a user flipping between screens or a retrying client could
 * ping far more often, and the hour bucket tells us nothing a once-a-
 * minute write does not.
 */
export const LOTTERY_ACTIVITY_THROTTLE_MS = 60 * 1000;

/** Above this many tracked users, the throttle map sheds its stale entries. */
const THROTTLE_MAP_PRUNE_THRESHOLD = 5_000;

/**
 * The start of the MYANMAR hour an instant falls in, as a UTC Date. Myanmar
 * time is UTC+6:30, so the bucket lands at :30 past the UTC hour (13:47 UTC
 * → 13:30 UTC = 20:00 MMT). Every analytics figure is bucketed in MMT
 * (`hourStart + 390 min` → extract(hour) / date_trunc), and tickets and
 * purchases are exact instants, so a UTC-aligned bucket would put each
 * hour's active users half an hour off the tickets drawn beside them and
 * count 00:00–00:30 MMT in the previous day. Aligning the bucket to the
 * MMT hour makes the shift exact. (Fixed 2026-10-23 before the first row
 * was written; WatchActivity keeps its own UTC buckets.)
 */
export function mmtHourStartOf(at: Date): Date {
  const shifted = hourStartOf(new Date(at.getTime() + MMT_OFFSET_MS));
  return new Date(shifted.getTime() - MMT_OFFSET_MS);
}

/**
 * The "I am in the lottery" ping (POST /lottery/activity) and the one read
 * the analytics overview needs. One row per (user, platform, MMT hour):
 * the first ping of the hour creates it, later ones bump `pings` and
 * `lastAt`. Everything here is incidental to the app's own navigation, so
 * a failed write is logged and swallowed — the client always gets its 204.
 */
@Injectable()
export class LotteryActivityService {
  private readonly logger = new Logger(LotteryActivityService.name);

  /**
   * userId -> epoch ms of the last write. In-process on purpose (the same
   * reasoning as TrackingService.lastSeenTouches): the throttle only has
   * to stop THIS instance from writing the same row again and again.
   */
  private readonly lastWrites = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one ping. Throttled to one write per user per
   * LOTTERY_ACTIVITY_THROTTLE_MS; the stamp is taken BEFORE the await so a
   * burst of concurrent pings produces one write, and it is kept on
   * failure so a database problem cannot turn into a write storm.
   * Never rejects.
   */
  async record(
    userId: string,
    platform: ClientPlatform,
    now: Date,
  ): Promise<void> {
    const nowMs = now.getTime();
    const previous = this.lastWrites.get(userId);
    if (
      previous !== undefined &&
      nowMs - previous < LOTTERY_ACTIVITY_THROTTLE_MS
    ) {
      return;
    }
    this.lastWrites.set(userId, nowMs);
    this.prune(nowMs);

    const hourStart = mmtHourStartOf(now);
    try {
      await this.prisma.lotteryActivity.upsert({
        where: {
          userId_platform_hourStart: { userId, platform, hourStart },
        },
        create: {
          userId,
          platform,
          hourStart,
          pings: 1,
          firstAt: now,
          lastAt: now,
        },
        update: {
          pings: { increment: 1 },
          lastAt: now,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to record lottery activity for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** When tracking started: the earliest hour bucket on record, or null before the first ping. */
  async firstActivityAt(): Promise<Date | null> {
    const { _min } = await this.prisma.lotteryActivity.aggregate({
      _min: { hourStart: true },
    });
    return _min.hourStart ?? null;
  }

  /** Drops entries already past the throttle window once the map is large (they can only answer "write again"). */
  private prune(nowMs: number): void {
    if (this.lastWrites.size <= THROTTLE_MAP_PRUNE_THRESHOLD) return;
    for (const [userId, writtenAt] of this.lastWrites) {
      if (nowMs - writtenAt >= LOTTERY_ACTIVITY_THROTTLE_MS) {
        this.lastWrites.delete(userId);
      }
    }
  }
}
