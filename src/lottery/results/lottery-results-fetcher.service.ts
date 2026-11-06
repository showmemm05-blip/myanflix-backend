import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LotteryDrawStatus,
  LotteryResultStatus,
  type LotteryDraw,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LotteryDrawCloserService } from '../lottery-draw-closer.service';
import { drawLabel } from '../lottery-draws-admin.service';
import { SELLING_STATUSES } from '../lottery-draws.service';
import { toDateString } from '../lottery-time';
import { LotteryResultsService } from './lottery-results.service';
import type { ResultsSource } from './results-source';

/** What one sweep did. */
export interface FetchSweep {
  /** Draws whose Thai draw time had passed while still selling, closed first. */
  closed: number;
  /** Sheets that arrived (FETCHED). */
  fetched: number;
  /** Draws the source does not show yet (still PENDING). */
  pending: number;
  /** Fetches that errored (FAILED, retried next run). */
  failed: number;
}

const NOTHING: FetchSweep = { closed: 0, fetched: 0, pending: 0, failed: 0 };

/**
 * How far back a sweep looks: a draw whose draw time is older than this
 * is left alone by the cron (a source that never shows it would be asked
 * every five minutes for ever) and stays reachable through "Fetch now".
 */
export const RESULTS_FETCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fetches winning numbers on time (lottery backend phase 3): every five
 * minutes, every draw whose Thai draw time has passed and whose sheet is
 * still PENDING or FAILED is asked of the results source. A draw still
 * OPEN / PAUSED at its draw time is closed first (the minute sweep closes
 * on salesCloseAt, which is never later, so this is a belt-and-braces
 * close with its own trigger in the audit row). Nothing here publishes —
 * only "Publish and pay winners" marks tickets and moves money. Skips the
 * whole run when the settings hold no results URL (manual entry only).
 * Never throws: one draw's error is logged and the next draw is tried.
 * One sweep at a time: a slow source can make a sweep outlast the five
 * minutes, and the next tick then returns at once instead of asking the
 * same draws again on top of it. Only draws of the last
 * RESULTS_FETCH_WINDOW_MS are swept.
 */
@Injectable()
export class LotteryResultsFetcherService {
  private readonly logger = new Logger(LotteryResultsFetcherService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly results: LotteryResultsService,
    private readonly closer: LotteryDrawCloserService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    await this.fetchDueResults(new Date());
  }

  async fetchDueResults(now: Date): Promise<FetchSweep> {
    const sweep: FetchSweep = { ...NOTHING };
    if (this.running) return sweep;
    this.running = true;
    try {
      return await this.sweep(sweep, now);
    } finally {
      this.running = false;
    }
  }

  private async sweep(sweep: FetchSweep, now: Date): Promise<FetchSweep> {
    let source: ResultsSource | null;
    try {
      source = await this.results.configuredSource();
    } catch (error) {
      this.logger.warn(
        `Could not read the lottery results settings: ${describe(error)}`,
      );
      return sweep;
    }
    if (!source) return sweep;

    let due: LotteryDraw[];
    try {
      due = await this.prisma.lotteryDraw.findMany({
        where: {
          status: {
            in: [...SELLING_STATUSES, LotteryDrawStatus.CLOSED],
          },
          drawAt: {
            lte: now,
            gte: new Date(now.getTime() - RESULTS_FETCH_WINDOW_MS),
          },
        },
        orderBy: { drawAt: 'asc' },
      });
    } catch (error) {
      this.logger.warn(
        `Could not list lottery draws due for results: ${describe(error)}`,
      );
      return sweep;
    }

    for (let draw of due) {
      try {
        if (SELLING_STATUSES.includes(draw.status)) {
          if (await this.closer.closeOne(draw, now, 'draw_time')) {
            sweep.closed += 1;
          }
          const fresh = await this.prisma.lotteryDraw.findUnique({
            where: { id: draw.id },
          });
          if (!fresh || fresh.status !== LotteryDrawStatus.CLOSED) continue;
          draw = fresh;
        }
        const row = await this.results.getOrCreateRow(draw.id);
        if (
          row.status !== LotteryResultStatus.PENDING &&
          row.status !== LotteryResultStatus.FAILED
        ) {
          continue;
        }
        const outcome = await source.fetch(toDateString(draw.thaiDrawDate));
        const { applied } = await this.results.applyOutcome(
          draw,
          row,
          outcome,
          { actor: null, trigger: 'cron', now },
        );
        if (applied === 'fetched') {
          sweep.fetched += 1;
          this.logger.log(`Results for ${drawLabel(draw)} fetched`);
        } else if (applied === 'not_yet') {
          sweep.pending += 1;
        } else if (applied === 'failed') {
          sweep.failed += 1;
          this.logger.warn(
            `Results for ${drawLabel(draw)} not fetched: ${
              outcome.ok ? 'unknown error' : outcome.error
            }`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Could not fetch results for ${drawLabel(draw)}: ${describe(error)}`,
        );
      }
    }
    return sweep;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
