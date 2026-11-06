import { Injectable } from '@nestjs/common';
import {
  DEFAULT_RESULTS_SOURCE_KIND,
  RESULTS_SOURCE_KINDS,
  type ResultsSource,
  type ResultsSourceKind,
} from './results-source';
import { ThaiLottoJsonSource } from './thai-lotto-json.source';

export function isResultsSourceKind(
  value: unknown,
): value is ResultsSourceKind {
  return (
    typeof value === 'string' &&
    (RESULTS_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Makes the ResultsSource the settings name (lottery backend phase 3). The
 * one seam between "what the admin configured" and "how the answer is
 * read": the cron, "Fetch now" and "Test the source" all go through here,
 * and the specs replace this provider with a fake source. An unknown kind
 * falls back to the default parser rather than failing — the column only
 * ever holds a known value, this guards a hand edit.
 */
@Injectable()
export class LotteryResultsSourceFactory {
  create(
    url: string,
    kind: string = DEFAULT_RESULTS_SOURCE_KIND,
  ): ResultsSource {
    const resolved = isResultsSourceKind(kind)
      ? kind
      : DEFAULT_RESULTS_SOURCE_KIND;
    switch (resolved) {
      case 'thai_lotto_json':
        return new ThaiLottoJsonSource(url);
    }
  }
}
