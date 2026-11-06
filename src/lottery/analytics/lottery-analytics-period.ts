import { HttpStatus } from '@nestjs/common';
import { YANGON_UTC_OFFSET_MINUTES } from '../../bank-events/risk-rules';
import { Prisma } from '../../generated/prisma/client';
import type { AnalyticsView } from '../dto/lottery-analytics.dto';
import { LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { isCalendarDate } from '../lottery-time';

/**
 * The pure arithmetic behind Lottery > Analytics: periods, comparison
 * windows, bucket keys and bin edges — everything that is not SQL. Every
 * date here is a MYANMAR calendar day (MMT, UTC+6:30, no DST), every
 * instant a UTC Date; the SQL side shifts timestamps by the same
 * YANGON_UTC_OFFSET_MINUTES before it buckets them, so both halves agree.
 */

export const MMT_OFFSET_MS = YANGON_UTC_OFFSET_MINUTES * 60_000;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest period one report may cover (a leap year). */
export const ANALYTICS_MAX_RANGE_DAYS = 366;
/** The dashboard's default: the last 7 full MMT days before today. */
export const ANALYTICS_DEFAULT_RANGE_DAYS = 7;

/** A period as the SQL needs it: the MMT dates for people, the UTC instants for the WHERE. */
export interface AnalyticsWindow {
  /** First MMT day, YYYY-MM-DD. */
  from: string;
  /** Last MMT day, YYYY-MM-DD (inclusive). */
  to: string;
  /** `from` 00:00 MMT as a UTC instant (inclusive). */
  start: Date;
  /** The day after `to`, 00:00 MMT, as a UTC instant (exclusive). */
  end: Date;
  /** How many calendar days the window spans. */
  days: number;
}

/** The selected period plus the equally long one right before it. */
export interface AnalyticsPeriod extends AnalyticsWindow {
  previous: AnalyticsWindow;
}

/** What an endpoint does when `from` and `to` are both absent. */
export type PeriodFallback = 'last7' | 'all';

const dateMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);
const msDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The MMT calendar date an instant falls on. */
export function mmtDateOf(at: Date): string {
  return msDate(at.getTime() + MMT_OFFSET_MS);
}

/** 00:00 MMT of a calendar day, as a UTC instant (= `${date}T00:00:00Z` minus 390 minutes). */
export function mmtDayStart(date: string): Date {
  return new Date(dateMs(date) - MMT_OFFSET_MS);
}

export function addDays(date: string, days: number): string {
  return msDate(dateMs(date) + days * DAY_MS);
}

/** Calendar days from `from` to `to`, both included (1 for the same day). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS) + 1;
}

export function windowOf(from: string, to: string): AnalyticsWindow {
  return {
    from,
    to,
    start: mmtDayStart(from),
    end: mmtDayStart(addDays(to, 1)),
    days: daysBetween(from, to),
  };
}

/** The period plus its comparison window: the same number of days ending the day before `from`. */
export function periodOf(from: string, to: string): AnalyticsPeriod {
  const current = windowOf(from, to);
  return {
    ...current,
    previous: windowOf(addDays(from, -current.days), addDays(from, -1)),
  };
}

/** The last `days` full MMT days before today (today = the MMT date of `now`). */
export function lastFullDays(
  now: Date,
  days: number,
): { from: string; to: string } {
  const today = mmtDateOf(now);
  return { from: addDays(today, -days), to: addDays(today, -1) };
}

const rangeInvalid = (message: string) =>
  lotteryError(
    HttpStatus.BAD_REQUEST,
    LOTTERY_ERRORS.ANALYTICS_RANGE_INVALID,
    message,
  );

/**
 * The period a request asks for. Both dates absent → the endpoint's
 * fallback: the last 7 full MMT days (dashboard) or null = all time
 * (reports). One date without the other, a date that is not a calendar
 * day, or `from` after `to` → 400 LOTTERY_ANALYTICS_RANGE_INVALID; more
 * than 366 days → 400 LOTTERY_ANALYTICS_RANGE_TOO_LONG.
 */
export function resolvePeriod(
  query: { from?: string; to?: string },
  fallback: 'last7',
  now?: Date,
): AnalyticsPeriod;
export function resolvePeriod(
  query: { from?: string; to?: string },
  fallback: 'all',
  now?: Date,
): AnalyticsPeriod | null;
export function resolvePeriod(
  query: { from?: string; to?: string },
  fallback: PeriodFallback,
  now?: Date,
): AnalyticsPeriod | null;
export function resolvePeriod(
  query: { from?: string; to?: string },
  fallback: PeriodFallback,
  now: Date = new Date(),
): AnalyticsPeriod | null {
  const { from, to } = query;
  if (from === undefined && to === undefined) {
    if (fallback === 'all') return null;
    const range = lastFullDays(now, ANALYTICS_DEFAULT_RANGE_DAYS);
    return periodOf(range.from, range.to);
  }
  if (from === undefined || to === undefined) {
    throw rangeInvalid('from and to go together');
  }
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw rangeInvalid('from and to must be calendar dates written YYYY-MM-DD');
  }
  if (from > to) throw rangeInvalid('from must not be after to');
  const days = daysBetween(from, to);
  if (days > ANALYTICS_MAX_RANGE_DAYS) {
    throw lotteryError(
      HttpStatus.BAD_REQUEST,
      LOTTERY_ERRORS.ANALYTICS_RANGE_TOO_LONG,
      `The period may cover at most ${ANALYTICS_MAX_RANGE_DAYS} days`,
      { days, maxDays: ANALYTICS_MAX_RANGE_DAYS },
    );
  }
  return periodOf(from, to);
}

/** "mon".."sun" — index 0 = Monday, matching `extract(isodow) - 1`. */
export const WEEKDAY_KEYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

/** "00".."23". */
export const HOUR_KEYS: readonly string[] = Array.from({ length: 24 }, (_, h) =>
  String(h).padStart(2, '0'),
);

/** The Monday of the ISO week a date falls in (a Monday maps to itself). */
export function mondayOf(date: string): string {
  const isodow = ((new Date(dateMs(date)).getUTCDay() + 6) % 7) + 1;
  return addDays(date, 1 - isodow);
}

/**
 * Every bucket key a view has for a window, in order, so a series is
 * zero-filled: 24 hours, every day of the window, every Monday from the
 * week of `from` to the week of `to`, or the 7 weekdays.
 */
export function bucketKeys(
  view: AnalyticsView,
  window: AnalyticsWindow,
): string[] {
  switch (view) {
    case 'hourly':
      return [...HOUR_KEYS];
    case 'weekday':
      return [...WEEKDAY_KEYS];
    case 'daily': {
      const keys: string[] = [];
      for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
        keys.push(day);
      }
      return keys;
    }
    case 'weekly': {
      const keys: string[] = [];
      for (
        let monday = mondayOf(window.from);
        monday <= window.to;
        monday = addDays(monday, 7)
      ) {
        keys.push(monday);
      }
      return keys;
    }
  }
}

/** The six "purchases before close" bins, oldest first, with the hours each covers. */
export const BEFORE_CLOSE_BINS = [
  { key: '72-48h', hoursBefore: 72, hours: 24 },
  { key: '48-24h', hoursBefore: 48, hours: 24 },
  { key: '24-12h', hoursBefore: 24, hours: 12 },
  { key: '12-6h', hoursBefore: 12, hours: 6 },
  { key: '6-1h', hoursBefore: 6, hours: 5 },
  { key: 'last-1h', hoursBefore: 1, hours: 1 },
] as const;

export type BeforeCloseBinKey = (typeof BEFORE_CLOSE_BINS)[number]['key'];

/**
 * The seven instants that cut the last 72 hours before a draw's sales
 * close into the six bins: [close−72h, close−48h, close−24h, close−12h,
 * close−6h, close−1h, close]. Bin i is `edges[i] <= createdAt <
 * edges[i+1]`; "earlier" is everything before edges[0]. The last bin is
 * open-ended on the SQL side (`>= edges[5]`) so a ticket stamped after the
 * close instant — only possible when staff moved salesCloseAt earlier
 * after selling — still adds up: total = earlier + Σ bins.
 */
export function beforeCloseEdges(salesCloseAt: Date): Date[] {
  const closeMs = salesCloseAt.getTime();
  const hours = [...BEFORE_CLOSE_BINS.map((bin) => bin.hoursBefore), 0];
  return hours.map((h) => new Date(closeMs - h * 60 * 60 * 1000));
}

/**
 * Whether the comparison window is fully covered by history: the first
 * paid purchase ever fell on or before `previousFrom` (as an MMT day). When
 * it did not, a comparison would be against a window that was partly
 * empty for lack of history, so the admin says "No earlier data" instead.
 */
export function hasEarlierData(
  firstPurchaseAt: Date | null,
  previousFrom: string,
): boolean {
  return firstPurchaseAt !== null && mmtDateOf(firstPurchaseAt) <= previousFrom;
}

/** Money as the wire wants it: a decimal string with exactly two places ("0.00" for nothing). */
export function ksText(
  value: Prisma.Decimal | string | number | null | undefined,
): string {
  return new Prisma.Decimal(value ?? 0).toFixed(2);
}

/** A ratio rounded to four places (0.0612), 0 when the denominator is 0. */
export function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/** (cur − prev) / prev rounded to four places; null when there is nothing to compare with. */
export function changePct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 10_000;
}
