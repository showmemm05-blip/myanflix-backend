import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LotteryDrawStatus,
  type LotteryDraw,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { lotteryDrawSnapshot } from '../audit/audit-snapshots';
import { PrismaService } from '../prisma/prisma.service';
import { drawLabel } from './lottery-draws-admin.service';
import { SELLING_STATUSES } from './lottery-draws.service';

/**
 * Closes sales on time (lottery backend phase 2): every minute, an OPEN or
 * PAUSED draw whose salesCloseAt has passed becomes CLOSED. This is
 * bookkeeping, not the safety net — a purchase checks the clock itself
 * under the draw's row lock, so a late or stopped cron never sells a
 * ticket after the close. Each close is one guarded UPDATE plus a system
 * audit row (actor null), so a staff member closing the same draw at the
 * same moment is simply the one who wins.
 */
@Injectable()
export class LotteryDrawCloserService {
  private readonly logger = new Logger(LotteryDrawCloserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.closeDueDraws(new Date());
  }

  /** Returns how many draws this run closed. Never throws: a database error is logged and the run ends. */
  async closeDueDraws(now: Date): Promise<number> {
    let closed = 0;
    try {
      const due = await this.prisma.lotteryDraw.findMany({
        where: {
          status: { in: [...SELLING_STATUSES] },
          salesCloseAt: { lte: now },
        },
        orderBy: { drawNo: 'asc' },
      });
      for (const draw of due) {
        const done = await this.closeOne(draw, now, 'sales_close');
        if (done) closed += 1;
      }
    } catch (error) {
      this.logger.warn(
        `Could not close due lottery draws: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return closed;
    }
    if (closed > 0) {
      this.logger.log(
        `Closed ${closed} lottery draw(s) whose sales time passed`,
      );
    }
    return closed;
  }

  /**
   * Closes one selling draw: a guarded UPDATE (OPEN / PAUSED → CLOSED,
   * `closedAt` = now) and a system audit row in one transaction. False when
   * the draw was no longer selling (a staff member or another run got
   * there first). `trigger` says why: 'sales_close' from the minute sweep,
   * 'draw_time' from the results cron, which closes a draw whose Thai draw
   * time has passed before it asks the source for the numbers.
   */
  async closeOne(
    draw: LotteryDraw,
    now: Date,
    trigger: 'sales_close' | 'draw_time',
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.lotteryDraw.updateMany({
        where: { id: draw.id, status: { in: [...SELLING_STATUSES] } },
        data: { status: LotteryDrawStatus.CLOSED, closedAt: now },
      });
      if (updated.count === 0) return false;
      const after = await tx.lotteryDraw.findUniqueOrThrow({
        where: { id: draw.id },
      });
      await this.audit.record({
        action: 'lottery_draw.close',
        actor: null,
        target: {
          type: 'lottery_draw',
          id: draw.id,
          label: drawLabel(draw),
        },
        before: lotteryDrawSnapshot(draw),
        after: lotteryDrawSnapshot(after),
        metadata: { trigger },
        tx,
      });
      return true;
    });
  }
}
