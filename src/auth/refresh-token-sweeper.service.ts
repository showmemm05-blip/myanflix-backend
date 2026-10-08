import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/** Rows are kept this long after they expire, then deleted. */
export const REFRESH_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per statement, so no single delete holds locks for long. */
export const REFRESH_TOKEN_SWEEP_BATCH = 5000;

/**
 * Upper bound on statements per run (5,000 x 400 = 2 million rows). A
 * backlog bigger than that is simply finished on the following nights.
 */
export const REFRESH_TOKEN_SWEEP_MAX_BATCHES = 400;

/**
 * bam-04 / db-04: every sign-in and every /auth/refresh (about every 15
 * minutes of use) adds a refresh_tokens row, and rotation only marks the old
 * one revoked — nothing ever deleted them, so the table grew forever.
 *
 * Nightly, this deletes rows that expired more than a day ago. That cannot
 * sign anyone out: /auth/refresh only accepts a row whose expiresAt is still
 * in the future (AuthService.refresh), so an expired row can never be used
 * again and nothing else reads it.
 *
 * It touches refresh_tokens rows only. It never reads or locks a users row,
 * so it cannot disturb the users -> refresh_tokens lock order the refresh
 * and revoke paths rely on. 2 AM so it never runs alongside the upload
 * sweeps (3 and 4 AM) or the one-time-code sweep (5 AM).
 */
@Injectable()
export class RefreshTokenSweeperService {
  private readonly logger = new Logger(RefreshTokenSweeperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async sweepExpired(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - REFRESH_TOKEN_GRACE_MS);
    let total = 0;
    try {
      for (let batch = 0; batch < REFRESH_TOKEN_SWEEP_MAX_BATCHES; batch++) {
        const deleted = await this.prisma.$executeRaw`
          DELETE FROM "refresh_tokens"
          WHERE "id" IN (
            SELECT "id" FROM "refresh_tokens"
            WHERE "expiresAt" < ${cutoff}
            LIMIT ${REFRESH_TOKEN_SWEEP_BATCH}
          )`;
        total += deleted;
        if (deleted < REFRESH_TOKEN_SWEEP_BATCH) break;
      }
    } catch (error) {
      // A nightly job: log and try again tomorrow, never crash the process.
      this.logger.warn(
        `Refresh-token sweep stopped after ${total} row(s): ${(error as Error).message}`,
      );
      return total;
    }
    if (total > 0) {
      this.logger.log(
        `Deleted ${total} refresh token row(s) that expired over a day ago`,
      );
    }
    return total;
  }
}
