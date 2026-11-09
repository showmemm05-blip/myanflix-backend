import type { ParsedSourceName } from '../common/utils/source-name.util';
import type { TmdbFailureReason } from './tmdb-errors';
import { wordKey } from './tmdb-keys';
import type { TmdbSearchRow } from './tmdb-payload';

/**
 * The automatic search and the "one clear match" rule (PLAN.md 2.4 and 2.5
 * of docs/movie-details-tmdb-2026-11-06) — pure, so the whole decision can
 * be tested without TMDB.
 *
 * Up to three searches, in order, for a name `Q` and a year `Y` read out of
 * a folder name:
 *
 *   A1  `Q` with TMDB's year filter `Y`     only when a year was found
 *   A2  `Q` alone
 *   A3  `"Q Y"` as the name, no filter      only when the year stood right
 *                                           after the name (it may be part
 *                                           of it: `Wonder Woman 1984`)
 *
 * In each, a row is a hit when its title (or original title) IS the name —
 * compared by wordKey, so case, accents and punctuation do not matter — and,
 * while a year is known (A1, A2), when its release year is within one of it.
 * Exactly one hit is the match and the search stops; two or more stop it as
 * "staff must pick"; none moves on. A wrong automatic match fills a wrong
 * story and creates wrong actors, so the rule is strict on purpose: when in
 * doubt, staff choose.
 *
 * It only decides the automatic path. A search staff start themselves
 * always shows the list.
 */

/** One search to make. */
export interface TmdbSearchAttempt {
  step: 'A1' | 'A2' | 'A3';
  query: string;
  /** TMDB's own year filter; null = not sent. */
  yearFilter: number | null;
}

export type TmdbMatchOutcome =
  | { kind: 'matched'; row: TmdbSearchRow }
  /** Several candidates, or candidates but none that is clearly it. */
  | { kind: 'needs_pick' }
  /** No search returned a single row. */
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: TmdbFailureReason };

/** The release year of a search row, or null when TMDB has no date for it. */
export function rowYear(
  row: Pick<TmdbSearchRow, 'releaseDate'>,
): number | null {
  const text = row.releaseDate.slice(0, 4);
  return /^\d{4}$/.test(text) ? Number(text) : null;
}

/** True when the row's title or original title is the searched name. */
export function exactHit(
  row: Pick<TmdbSearchRow, 'title' | 'originalTitle'>,
  query: string,
): boolean {
  const wanted = wordKey(query);
  if (wanted === '') return false;
  return wordKey(row.title) === wanted || wordKey(row.originalTitle) === wanted;
}

/** The searches to make for a parsed folder name, in order. */
export function planAttempts(parsed: ParsedSourceName): TmdbSearchAttempt[] {
  const attempts: TmdbSearchAttempt[] = [];
  if (parsed.year !== null) {
    attempts.push({ step: 'A1', query: parsed.query, yearFilter: parsed.year });
  }
  attempts.push({ step: 'A2', query: parsed.query, yearFilter: null });
  if (parsed.year !== null && parsed.yearFollowsTitle) {
    attempts.push({
      step: 'A3',
      query: `${parsed.query} ${parsed.year}`,
      yearFilter: null,
    });
  }
  return attempts;
}

/** The rows of one search that count as hits. */
export function hitsOf(
  attempt: TmdbSearchAttempt,
  rows: readonly TmdbSearchRow[],
  parsed: ParsedSourceName,
): TmdbSearchRow[] {
  if (attempt.step === 'A3') {
    // The year is part of the name here, so it is not also a release year.
    return rows.filter((row) => exactHit(row, attempt.query));
  }
  const year = parsed.year;
  if (year === null) return rows.filter((row) => exactHit(row, parsed.query));
  return rows.filter((row) => {
    const released = rowYear(row);
    return (
      exactHit(row, parsed.query) &&
      released !== null &&
      Math.abs(released - year) <= 1
    );
  });
}

/**
 * Runs the attempts through `search` and applies the rule. `search` is the
 * TMDB call (TmdbClient.searchMovies); a failed attempt ends the whole
 * search as failed — a lookup never decides on half the evidence.
 */
export async function findClearMatch(
  parsed: ParsedSourceName,
  search: (
    attempt: TmdbSearchAttempt,
  ) => Promise<
    | { ok: true; data: TmdbSearchRow[] }
    | { ok: false; reason: TmdbFailureReason }
  >,
): Promise<TmdbMatchOutcome> {
  if (parsed.query.trim() === '') return { kind: 'not_found' };
  let sawRows = false;
  for (const attempt of planAttempts(parsed)) {
    const answer = await search(attempt);
    if (!answer.ok) return { kind: 'failed', reason: answer.reason };
    if (answer.data.length > 0) sawRows = true;
    const hits = hitsOf(attempt, answer.data, parsed);
    if (hits.length === 1) return { kind: 'matched', row: hits[0] };
    if (hits.length >= 2) return { kind: 'needs_pick' };
  }
  return sawRows ? { kind: 'needs_pick' } : { kind: 'not_found' };
}
