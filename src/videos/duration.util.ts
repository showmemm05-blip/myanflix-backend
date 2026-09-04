/**
 * Pure runtime arithmetic shared by every place the backend turns a probed
 * duration into stored numbers (finalize-time recovery and the admin
 * backfill). It mirrors admin/lib/upload/probe-duration.ts exactly: the
 * browser probe that fills a bulk placeholder at birth and the server paths
 * that fill it later must round the same seconds to the same minute, or the
 * two sources would disagree about one title.
 */

/** 100 hours. Anything longer is a bad probe, not a runtime, and is discarded. */
export const MAX_DURATION_MINUTES = 6000;

const MAX_DURATION_SECONDS = MAX_DURATION_MINUTES * 60;

function isPlausibleSeconds(
  seconds: number | null | undefined,
): seconds is number {
  return (
    seconds != null &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= MAX_DURATION_SECONDS
  );
}

/**
 * Seconds -> the whole minutes Movie.duration stores, or null when the value
 * is unusable (non-finite, <= 0, or over the sanity bound).
 *
 * ROUND, not ceil: runtimes are conventionally quoted that way (90:29 is
 * "90m"; ceil would inflate every title by up to a minute). FLOOR AT 1: 0 is
 * the unknown-runtime sentinel and the placeholder DTO rejects it, so a
 * 40-second clip is 1m, never 0.
 */
export function secondsToMinutes(
  seconds: number | null | undefined,
): number | null {
  if (!isPlausibleSeconds(seconds)) return null;
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * Seconds -> the integer Video.duration stores (same rounding as the ffprobe
 * path in processing/ffmpeg.util.ts), or null when the value is unusable. A
 * value that rounds to 0 is also null — a sub-half-second playlist is not a
 * runtime, and 0 would read as "measured, empty".
 */
export function normaliseDurationSeconds(
  seconds: number | null | undefined,
): number | null {
  if (!isPlausibleSeconds(seconds)) return null;
  const rounded = Math.round(seconds);
  return rounded > 0 ? rounded : null;
}
