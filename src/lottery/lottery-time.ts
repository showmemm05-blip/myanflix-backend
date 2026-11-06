import { YANGON_UTC_OFFSET_MINUTES } from '../bank-events/risk-rules';

/**
 * The Thai lottery draws on the draw date at 14:30 Asia/Bangkok (UTC+7),
 * which is 07:30 UTC and 14:00 in Myanmar. The backend keeps UTC; the apps
 * show Myanmar time. Thailand has no DST either, so the offset is exact.
 */
export const THAI_DRAW_UTC_HOUR = 7;
export const THAI_DRAW_UTC_MINUTE = 30;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * The value to store in a `@db.Date` column for a YYYY-MM-DD string:
 * midnight UTC on that day, which is also what Prisma hands back.
 */
export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** YYYY-MM-DD of a `@db.Date` value. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** When the Thai draw happens for a draw date: 14:30 Bangkok, as a UTC instant. */
export function drawAtFor(thaiDrawDate: string): Date {
  const [year, month, day] = thaiDrawDate.split('-').map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, THAI_DRAW_UTC_HOUR, THAI_DRAW_UTC_MINUTE),
  );
}

export function minutesBefore(at: Date, minutes: number): Date {
  return new Date(at.getTime() - minutes * 60_000);
}

/** "yymmdd" of an instant in Myanmar time — the date part of a purchase ref. */
export function myanmarYymmdd(at: Date): string {
  const shifted = new Date(at.getTime() + YANGON_UTC_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCFullYear() % 100)}${pad(
    shifted.getUTCMonth() + 1,
  )}${pad(shifted.getUTCDate())}`;
}
