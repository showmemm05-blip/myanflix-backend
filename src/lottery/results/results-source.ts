import type { PrizeGroup } from './prize-groups';

/** The source answered with a sheet it could parse (whether or not for the asked date). */
export interface ResultsFetchSuccess {
  ok: true;
  /** The draw date the source said it was showing, as YYYY-MM-DD. */
  sourceDate: string;
  /** True when `sourceDate` is the date that was asked for. */
  matches: boolean;
  /** The source's answer exactly as received, for lottery_results.raw. */
  raw: unknown;
  /** A full sheet in the fixed order (checkPrizeGroups passed with no errors). */
  groups: PrizeGroup[];
  /** Oddities that did not block (near-first not first ± 1). */
  warnings: string[];
}

/** The source could not be read or its answer could not be used; `error` is for lottery_results.lastError. */
export interface ResultsFetchFailure {
  ok: false;
  error: string;
  /** What came back, when anything did — kept so a staff member can see what went wrong. */
  raw?: unknown;
}

export type ResultsFetchOutcome = ResultsFetchSuccess | ResultsFetchFailure;

/**
 * Where winning numbers come from (lottery backend phase 3): never from
 * us. One implementation per answer shape; `fetch` never throws — a
 * network error, a timeout, a bad body or a bad sheet all come back as
 * `{ ok: false, error }`, and the caller (the five-minute cron, "Fetch
 * now", "Test the source") decides what to store. No retries inside.
 */
export interface ResultsSource {
  fetch(thaiDrawDate: string): Promise<ResultsFetchOutcome>;
}

/** The parsers the settings may name; only one exists today. */
export const RESULTS_SOURCE_KINDS = ['thai_lotto_json'] as const;

export type ResultsSourceKind = (typeof RESULTS_SOURCE_KINDS)[number];

export const DEFAULT_RESULTS_SOURCE_KIND: ResultsSourceKind = 'thai_lotto_json';
