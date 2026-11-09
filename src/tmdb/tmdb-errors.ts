import { HttpStatus } from '@nestjs/common';
import {
  CodedHttpException,
  type CodedErrorExtra,
} from '../common/errors/coded-http.exception';

/**
 * Error codes the admin branches on (admin/types/tmdb.ts keeps the same
 * list); the message is for people and may be reworded.
 */
export const TMDB_ERRORS = {
  /** 503: TMDB_API_KEY is missing — the feature is off. */
  NOT_CONFIGURED: 'TMDB_NOT_CONFIGURED',
  /** 502: TMDB did not answer, answered 5xx, or answered something unreadable. */
  UNREACHABLE: 'TMDB_UNREACHABLE',
  /** 502: TMDB refused the key (401). */
  KEY_REJECTED: 'TMDB_KEY_REJECTED',
  /** 503: still 429 after the retries. */
  RATE_LIMITED: 'TMDB_RATE_LIMITED',
  /** 404: TMDB has no entry with that id. */
  TITLE_NOT_FOUND: 'TMDB_TITLE_NOT_FOUND',
  /** 409: a lookup or an apply is already running for this title. */
  BUSY: 'TMDB_BUSY',
  /** 409: the movie is already linked — Refill or Change match instead of a new lookup. */
  ALREADY_MATCHED: 'TMDB_ALREADY_MATCHED',
  /** 409: one of our series is already linked to this TMDB show; extra { seriesId }. */
  SERIES_EXISTS: 'TMDB_SERIES_EXISTS',
  /** 400: the id is an episode — episodes are not looked up. */
  NOT_A_MOVIE: 'TMDB_NOT_A_MOVIE',
} as const;

export const tmdbError = (
  status: HttpStatus,
  code: string,
  message: string,
  extra?: CodedErrorExtra,
) => new CodedHttpException(status, code, message, extra);

/** The 503 every /tmdb route that needs TMDB answers while the key is missing (all but GET /tmdb/status and GET /tmdb/movies/state). */
export const tmdbNotConfigured = () =>
  tmdbError(
    HttpStatus.SERVICE_UNAVAILABLE,
    TMDB_ERRORS.NOT_CONFIGURED,
    'TMDB is not connected. Add TMDB_API_KEY to the server settings.',
  );

export const tmdbBusy = () =>
  tmdbError(
    HttpStatus.CONFLICT,
    TMDB_ERRORS.BUSY,
    'Details are being fetched for this title',
  );

/**
 * Why a call to TMDB did not produce data — what TmdbClient hands back
 * instead of throwing. `bad_response` = TMDB answered, but not with what
 * was asked for (not JSON, the wrong shape, far too much data).
 */
export type TmdbFailureReason =
  | 'not_configured'
  | 'key_rejected'
  | 'rate_limited'
  | 'unreachable'
  | 'not_found'
  | 'bad_response';

/**
 * The coded error a staff route answers with when TMDB let it down. A
 * search has no id that could be unknown, so `not_found` only reaches here
 * from a details call: TMDB has no such entry.
 */
export function tmdbFailureException(
  reason: TmdbFailureReason,
): CodedHttpException {
  switch (reason) {
    case 'not_configured':
      return tmdbNotConfigured();
    case 'key_rejected':
      return tmdbError(
        HttpStatus.BAD_GATEWAY,
        TMDB_ERRORS.KEY_REJECTED,
        'TMDB did not accept the key',
      );
    case 'rate_limited':
      return tmdbError(
        HttpStatus.SERVICE_UNAVAILABLE,
        TMDB_ERRORS.RATE_LIMITED,
        'TMDB is busy. Try again in a moment.',
      );
    case 'not_found':
      return tmdbError(
        HttpStatus.NOT_FOUND,
        TMDB_ERRORS.TITLE_NOT_FOUND,
        'TMDB has no title with this id',
      );
    case 'unreachable':
    case 'bad_response':
      return tmdbError(
        HttpStatus.BAD_GATEWAY,
        TMDB_ERRORS.UNREACHABLE,
        'Could not reach TMDB',
      );
  }
}
