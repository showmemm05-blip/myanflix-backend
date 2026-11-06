import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LotteryPayoutStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Expires the prizes nobody asked for in time (2026-10-24): every hour,
 * an UNCLAIMED payout whose draw's claimDeadlineAt has passed becomes
 * EXPIRED, in one UPDATE. A REQUESTED prize never expires — once the
 * customer asked, the decision is the staff member's, however long it
 * waits. This is bookkeeping, not the safety net: a request checks the
 * deadline itself under the draw's row lock, so a late or stopped cron
 * never lets a prize be requested after its deadline. No audit row — no
 * one acted — and never throws: a database error is logged and the run ends.
 */
@Injectable()
export class LotteryClaimExpiryService {
  private readonly logger = new Logger(LotteryClaimExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async tick(): Promise<void> {
    await this.run(new Date());
  }

  /** Returns how many prizes this run expired. */
  async run(now: Date): Promise<number> {
    try {
      const { count } = await this.prisma.lotteryPayout.updateMany({
        where: {
          status: LotteryPayoutStatus.UNCLAIMED,
          draw: { claimDeadlineAt: { lte: now } },
        },
        data: { status: LotteryPayoutStatus.EXPIRED },
      });
      if (count > 0) {
        this.logger.log(
          `Expired ${count} unclaimed lottery prize(s) past their claim deadline`,
        );
      }
      return count;
    } catch (error) {
      this.logger.warn(
        `Could not expire unclaimed lottery prizes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }
}
