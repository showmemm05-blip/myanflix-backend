import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  LotteryDrawStatus,
  LotteryResultSource,
  LotteryResultStatus,
  Prisma,
  type LotteryDraw,
  type LotteryResult,
} from '../../generated/prisma/client';
import { AuditService } from '../../audit/audit.service';
import { lotteryResultSnapshot } from '../../audit/audit-snapshots';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type EnterResultsDto,
  type ResultSourceWire,
  type ResultStatusWire,
} from '../dto/lottery-results.dto';
import { drawLabel } from '../lottery-draws-admin.service';
import { drawStatusToWire } from '../lottery-draws.service';
import { drawNotFound, LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import {
  LotterySettingsService,
  staffLabel,
  type StaffRef,
} from '../lottery-settings.service';
import { toDateString } from '../lottery-time';
import { LotteryResultsSourceFactory } from './lottery-results-source.factory';
import {
  checkPrizeGroups,
  isCompletePrizeSheet,
  normalizePrizeGroups,
  parseStoredPrizeGroups,
  type PrizeGroup,
} from './prize-groups';
import { groupsWithKs } from './prize-matcher';
import type { ResultsFetchOutcome, ResultsSource } from './results-source';
import { resultsUrlFor } from './thai-lotto-json.source';

/** Bangkok is UTC+7 all year — "today" for the source is today in Bangkok. */
const BANGKOK_UTC_OFFSET_MINUTES = 7 * 60;

const STATUS_TO_WIRE: Record<LotteryResultStatus, ResultStatusWire> = {
  PENDING: 'pending',
  FETCHED: 'fetched',
  PUBLISHED: 'published',
  FAILED: 'failed',
};

const SOURCE_TO_WIRE: Record<LotteryResultSource, ResultSourceWire> = {
  API: 'api',
  MANUAL: 'manual',
};

export const resultStatusToWire = (
  status: LotteryResultStatus,
): ResultStatusWire => STATUS_TO_WIRE[status];

export const resultSourceToWire = (
  source: LotteryResultSource | null,
): ResultSourceWire | null => (source === null ? null : SOURCE_TO_WIRE[source]);

/** The staff member who entered the sheet by hand, as the admin names them. */
const ENTERED_BY_INCLUDE = {
  enteredBy: { select: { id: true, username: true, displayName: true } },
} satisfies Prisma.LotteryResultInclude;

export type LotteryResultRow = LotteryResult & { enteredBy: StaffRef | null };

/** One group of the sheet as the admin card and the apps read it: the Baht prize and the Ks at the rate. */
export type PrizeGroupView = PrizeGroup & { ks: number | null };

/** A draw's results as the admin "Results" card reads them. */
export interface ResultsView {
  drawId: string;
  drawNo: number;
  thaiDrawDate: string;
  status: ResultStatusWire;
  source: ResultSourceWire | null;
  fetchedAt: Date | null;
  /** The date the source said it was showing (manual entry: the draw date). */
  sourceDate: string | null;
  lastError: string | null;
  attempts: number;
  enteredBy: { id: string; label: string } | null;
  /** Ks per Baht the Ks figures below use: the draw's rate once published, else the settings'. */
  rate: number;
  /** The nine groups in the fixed order; empty until fetched or entered. */
  groups: PrizeGroupView[];
  /** True when the sheet is full and valid — what publish needs. */
  complete: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

/** What "Test the source" shows. */
export interface ResultsTestView {
  ok: boolean;
  /** The URL that was asked, after the {date} replacement. */
  url: string | null;
  /** The date the source was asked for (today in Bangkok). */
  askedDate: string;
  sourceDate: string | null;
  matches: boolean | null;
  groupsSummary: Array<{
    key: string;
    name: string;
    baht: number;
    count: number;
    numbers: string[];
  }> | null;
  warnings: string[];
  error: string | null;
}

/** What one fetch did to the row. */
export type FetchApplied = 'fetched' | 'not_yet' | 'failed' | 'locked';

export interface ApplyOptions {
  /** null = the cron (a system audit row). */
  actor: AuthenticatedUser | null;
  trigger: 'cron' | 'manual';
  now: Date;
}

/**
 * A draw's winning numbers (lottery backend phase 3): the results row,
 * what the results source answered, and what a staff member typed in.
 * Everything that writes money (publish, payouts) is engineer B's
 * service; this one only ever decides what the sheet IS. The row is
 * created on first touch so every draw has one to show; it is never
 * changed once the draw is PUBLISHED.
 */
@Injectable()
export class LotteryResultsService {
  private readonly logger = new Logger(LotteryResultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: LotterySettingsService,
    private readonly sources: LotteryResultsSourceFactory,
  ) {}

  /** The results row of a draw, made PENDING with an empty sheet on first read. */
  async getOrCreateRow(
    drawId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<LotteryResultRow> {
    return client.lotteryResult.upsert({
      where: { drawId },
      create: { drawId },
      update: {},
      include: ENTERED_BY_INCLUDE,
    });
  }

  /** GET /lottery/admin/draws/:id/results */
  async get(drawId: string): Promise<ResultsView> {
    const draw = await this.findDraw(drawId);
    const row = await this.getOrCreateRow(drawId);
    return this.view(row, draw, await this.rateFor(draw));
  }

  /**
   * POST /lottery/admin/draws/:id/results/fetch — asks the source now, for
   * this draw's date, and stores whatever came back exactly as the cron
   * would (a staff member's name on the audit row instead of "system").
   * Refused once the draw is published; refused while sales are not
   * closed (a draw that reopened must close again first); refused when no
   * source is set.
   */
  async fetchNow(
    drawId: string,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<ResultsView> {
    const draw = await this.findDraw(drawId);
    this.assertNotPublished(draw);
    this.assertClosed(draw);
    const source = await this.configuredSource();
    if (!source) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.RESULTS_SOURCE_NOT_SET,
        'No results source is set — add one in Lottery settings, or enter the numbers by hand',
      );
    }
    const row = await this.getOrCreateRow(drawId);
    const outcome = await source.fetch(toDateString(draw.thaiDrawDate));
    await this.applyOutcome(draw, row, outcome, {
      actor,
      trigger: 'manual',
      now,
    });
    return this.get(drawId);
  }

  /**
   * Stores one fetch outcome on the row (shared with the five-minute
   * cron). A matching sheet → FETCHED (source API, the sheet, the raw
   * answer, the source's date, fetchedAt) plus a lottery_results.fetch
   * audit row; a sheet for another date → the row stays as it was
   * (PENDING, or FETCHED when a sheet is already in), attempts + 1 and
   * lastError saying which date the source shows; an error → FAILED (a
   * sheet already in stays FETCHED), attempts + 1, lastError. Never
   * touches a PUBLISHED row: the source was asked seconds ago with the
   * row as it was then, so the write happens under the draw's row lock
   * (the one publish and reopen take for their status flips) against the
   * row and the draw as they are NOW — a staff member who entered the
   * sheet by hand and published while the source was slow keeps the sheet
   * the winners were paid from, and a draw that reopened meanwhile takes
   * no sheet (a staff fetch gets the 409; the cron, which only reaches
   * here with a CLOSED draw whose draw time has passed — one that cannot
   * reopen, since sales close before the draw — just reports "locked").
   */
  async applyOutcome(
    draw: LotteryDraw,
    row: LotteryResult,
    outcome: ResultsFetchOutcome,
    options: ApplyOptions,
  ): Promise<{ row: LotteryResult; applied: FetchApplied }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDraw(tx, draw.id);
      const fresh = await tx.lotteryResult.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (fresh.status === LotteryResultStatus.PUBLISHED) {
        return { row: fresh, applied: 'locked' };
      }
      const drawNow = await tx.lotteryDraw.findUniqueOrThrow({
        where: { id: draw.id },
      });
      if (drawNow.status !== LotteryDrawStatus.CLOSED) {
        if (options.trigger === 'manual') this.assertClosed(drawNow);
        return { row: fresh, applied: 'locked' };
      }
      const keepSheet = fresh.status === LotteryResultStatus.FETCHED;

      if (!outcome.ok) {
        const updated = await tx.lotteryResult.update({
          where: { id: fresh.id },
          data: {
            status: keepSheet
              ? LotteryResultStatus.FETCHED
              : LotteryResultStatus.FAILED,
            attempts: { increment: 1 },
            lastError: outcome.error,
            ...(outcome.raw === undefined || keepSheet
              ? {}
              : { raw: rawJson(outcome.raw) }),
          },
        });
        return { row: updated, applied: 'failed' };
      }

      if (!outcome.matches) {
        const updated = await tx.lotteryResult.update({
          where: { id: fresh.id },
          data: {
            status: keepSheet
              ? LotteryResultStatus.FETCHED
              : LotteryResultStatus.PENDING,
            attempts: { increment: 1 },
            lastError: `The source still shows ${outcome.sourceDate}`,
          },
        });
        return { row: updated, applied: 'not_yet' };
      }

      if (outcome.warnings.length > 0) {
        this.logger.warn(
          `Results for ${drawLabel(draw)}: ${outcome.warnings.join('; ')}`,
        );
      }
      const after = await tx.lotteryResult.update({
        where: { id: fresh.id },
        data: {
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.API,
          groups: sheetJson(outcome.groups),
          raw: rawJson(outcome.raw),
          sourceDate: outcome.sourceDate,
          fetchedAt: options.now,
          enteredByUserId: null,
          lastError: null,
          attempts: { increment: 1 },
        },
      });
      await this.audit.record({
        action: 'lottery_results.fetch',
        actor: options.actor,
        target: {
          type: 'lottery_results',
          id: fresh.id,
          label: drawLabel(draw),
        },
        before: lotteryResultSnapshot(fresh),
        after: lotteryResultSnapshot(after),
        metadata: {
          trigger: options.trigger,
          sourceDate: outcome.sourceDate,
          warnings: outcome.warnings,
        },
        tx,
      });
      return { row: after, applied: 'fetched' };
    });
  }

  /**
   * PUT /lottery/admin/draws/:id/results — the sheet typed in by hand,
   * all nine groups. Every problem is reported at once (400
   * LOTTERY_RESULTS_INVALID, details.errors); a sheet that passes replaces
   * whatever was there (an API sheet included — the staff member is
   * saying the source was wrong) and is audited before/after. Only a
   * CLOSED draw takes a sheet: a draw that reopened must close again
   * first, so customers never buy with the numbers known.
   */
  async enter(
    drawId: string,
    dto: EnterResultsDto,
    actor: AuthenticatedUser,
    now = new Date(),
  ): Promise<ResultsView> {
    const draw = await this.findDraw(drawId);
    this.assertNotPublished(draw);
    this.assertClosed(draw);
    const check = checkPrizeGroups(dto.groups);
    if (check.errors.length > 0) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.RESULTS_INVALID,
        'The sheet is not complete',
        { details: { errors: check.errors } },
      );
    }
    const groups = normalizePrizeGroups(dto.groups);

    await this.prisma.$transaction(async (tx) => {
      // Under the draw's row lock, against the draw as it is now: a
      // publish or a reopen that committed since the checks above is
      // seen here.
      await this.lockDraw(tx, drawId);
      const current = await tx.lotteryDraw.findUniqueOrThrow({
        where: { id: drawId },
      });
      this.assertNotPublished(current);
      this.assertClosed(current);
      const before = await this.getOrCreateRow(drawId, tx);
      if (before.status === LotteryResultStatus.PUBLISHED) {
        throw this.locked();
      }
      const after = await tx.lotteryResult.update({
        where: { id: before.id },
        data: {
          status: LotteryResultStatus.FETCHED,
          source: LotteryResultSource.MANUAL,
          groups: sheetJson(groups),
          raw: Prisma.DbNull,
          sourceDate: toDateString(draw.thaiDrawDate),
          fetchedAt: now,
          enteredByUserId: actor.id,
          lastError: null,
        },
      });
      await this.audit.record({
        action: 'lottery_results.enter',
        actor,
        target: {
          type: 'lottery_results',
          id: before.id,
          label: drawLabel(draw),
        },
        before: lotteryResultSnapshot(before),
        after: lotteryResultSnapshot(after),
        metadata: { note: dto.note ?? null, warnings: check.warnings },
        tx,
      });
    });
    return this.get(drawId);
  }

  /**
   * GET /lottery/admin/settings/results-test — asks the configured source
   * for today's draw (today in Bangkok) and shows what came back, storing
   * nothing. Answers 200 either way; `ok` says whether the source worked.
   */
  async testSource(now = new Date()): Promise<ResultsTestView> {
    const askedDate = bangkokDate(now);
    const settings = await this.settings.getOrCreate();
    if (!settings.resultsUrl) {
      return {
        ok: false,
        url: null,
        askedDate,
        sourceDate: null,
        matches: null,
        groupsSummary: null,
        warnings: [],
        error: 'No results source is set',
      };
    }
    const source = this.sources.create(
      settings.resultsUrl,
      settings.resultsSourceKind,
    );
    const outcome = await source.fetch(askedDate);
    const url = resultsUrlFor(settings.resultsUrl, askedDate);
    if (!outcome.ok) {
      return {
        ok: false,
        url,
        askedDate,
        sourceDate: null,
        matches: null,
        groupsSummary: null,
        warnings: [],
        error: outcome.error,
      };
    }
    return {
      ok: true,
      url,
      askedDate,
      sourceDate: outcome.sourceDate,
      matches: outcome.matches,
      groupsSummary: outcome.groups.map((group) => ({
        key: group.key,
        name: group.name,
        baht: group.baht,
        count: group.numbers.length,
        numbers: group.numbers,
      })),
      warnings: outcome.warnings,
      error: null,
    };
  }

  /** The configured source, or null when the settings hold no URL (manual entry only). */
  async configuredSource(): Promise<ResultsSource | null> {
    const settings = await this.settings.getOrCreate();
    if (!settings.resultsUrl) return null;
    return this.sources.create(settings.resultsUrl, settings.resultsSourceKind);
  }

  /** The stored sheet of a row, empty when nothing is in yet. */
  sheetOf(row: Pick<LotteryResult, 'groups'>): PrizeGroup[] {
    return parseStoredPrizeGroups(row.groups);
  }

  /** Ks per Baht for a draw: its own rate once set (publish), else the settings'. */
  async rateFor(draw: Pick<LotteryDraw, 'exchangeRate'>): Promise<number> {
    if (draw.exchangeRate !== null) return draw.exchangeRate.toNumber();
    const settings = await this.settings.getOrCreate();
    return settings.exchangeRate.toNumber();
  }

  view(row: LotteryResultRow, draw: LotteryDraw, rate: number): ResultsView {
    const groups = this.sheetOf(row);
    return {
      drawId: draw.id,
      drawNo: draw.drawNo,
      thaiDrawDate: toDateString(draw.thaiDrawDate),
      status: resultStatusToWire(row.status),
      source: resultSourceToWire(row.source),
      fetchedAt: row.fetchedAt,
      sourceDate: row.sourceDate,
      lastError: row.lastError,
      attempts: row.attempts,
      enteredBy: row.enteredBy
        ? { id: row.enteredBy.id, label: staffLabel(row.enteredBy) }
        : null,
      rate,
      groups: groupsWithKs(groups, rate),
      complete: groups.length > 0 && isCompletePrizeSheet(groups),
      publishedAt: draw.publishedAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findDraw(id: string): Promise<LotteryDraw> {
    const row = await this.prisma.lotteryDraw.findUnique({ where: { id } });
    if (!row) throw drawNotFound();
    return row;
  }

  private assertNotPublished(draw: Pick<LotteryDraw, 'status'>) {
    if (draw.status === LotteryDrawStatus.PUBLISHED) throw this.locked();
  }

  /** A sheet goes only onto a CLOSED draw (publish refuses the same way, lottery-publish.service.ts). */
  private assertClosed(draw: Pick<LotteryDraw, 'status'>) {
    if (draw.status === LotteryDrawStatus.CLOSED) return;
    throw lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.DRAW_STATE,
      'Close sales before entering the results',
      { status: drawStatusToWire(draw.status) },
    );
  }

  /** The draw's row lock — the statement publish and reopen take before their status flips (lottery-publish.service.ts, lottery-draws-admin.service.ts). */
  private async lockDraw(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "lottery_draws" WHERE "id" = ${id} FOR UPDATE`;
  }

  private locked() {
    return lotteryError(
      HttpStatus.CONFLICT,
      LOTTERY_ERRORS.RESULTS_LOCKED,
      'The results are published and cannot change',
    );
  }
}

/** The sheet for the `groups` Json column (always an array, never null). */
function sheetJson(groups: readonly PrizeGroup[]): Prisma.InputJsonValue {
  return groups as unknown as Prisma.InputJsonValue;
}

/** The source's answer for the nullable `raw` column; nothing → SQL NULL. */
function rawJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value;
}

/** YYYY-MM-DD of an instant in Bangkok time. */
export function bangkokDate(at: Date): string {
  return toDateString(
    new Date(at.getTime() + BANGKOK_UTC_OFFSET_MINUTES * 60_000),
  );
}
