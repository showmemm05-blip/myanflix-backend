import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { TmdbLookupStatus } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ConversionSlots } from '../common/concurrency/slots';
import { PrismaService } from '../prisma/prisma.service';
import {
  TMDB_ERRORS,
  tmdbBusy,
  tmdbError,
  tmdbNotConfigured,
  type TmdbFailureReason,
} from './tmdb-errors';
import { TmdbFillService } from './tmdb-fill.service';
import { findClearMatch } from './tmdb-match';
import { TmdbRunRegistry, movieRunKey } from './tmdb-runs';
import { movieSearchInput } from './tmdb-state.service';
import { TmdbClient } from './tmdb.client';
import type { TmdbLookupError } from './tmdb.types';

/** How many automatic lookups run at the same time; the rest wait, still PENDING. */
export const TMDB_LOOKUP_CONCURRENCY = 2;

/**
 * The statuses a lookup may start from. After an upload: never looked up,
 * or a lookup that came to nothing. A staff "Find details" / "Try again"
 * may also restart a title that is waiting for a pick — and one that is
 * PENDING with no run behind it (a lookup whose result could not be
 * written). Staff claim only after taking the movie's run key, and every
 * run holds that key from before its claim until it has settled, so a
 * PENDING they can claim is never a lookup that is still alive. MATCHED
 * (it is linked: Refill or Change match) never.
 */
const CLAIMABLE_AFTER_UPLOAD: TmdbLookupStatus[] = [
  TmdbLookupStatus.NONE,
  TmdbLookupStatus.FAILED,
  TmdbLookupStatus.NOT_FOUND,
];
const CLAIMABLE_BY_STAFF: TmdbLookupStatus[] = [
  ...CLAIMABLE_AFTER_UPLOAD,
  TmdbLookupStatus.NEEDS_PICK,
  TmdbLookupStatus.PENDING,
];

/** What a finished lookup leaves on the movie when it did not end in a fill. */
interface LookupResult {
  status: TmdbLookupStatus;
  error?: TmdbLookupError;
}

/** Why a lookup FAILED, as Movie.tmdbError stores it (PLAN.md 2.12). */
function lookupErrorOf(reason: TmdbFailureReason): TmdbLookupError {
  switch (reason) {
    case 'key_rejected':
      return 'key_rejected';
    case 'rate_limited':
      return 'rate_limited';
    case 'not_configured':
      return 'internal';
    default:
      // Down, timed out, 5xx, or an answer that could not be read.
      return 'unreachable';
  }
}

/**
 * The automatic path (PLAN.md 2.1, 2.4, 2.5, 2.12 and 5.4 of
 * docs/movie-details-tmdb-2026-11-06): when a folder upload finishes, look
 * the film up on TMDB in the background. One clear match → its details
 * are filled (TmdbFillService, untouched fields only). Several → staff
 * pick. None → nothing changes.
 *
 * The upload never waits for this and can never fail because of it:
 * `afterUpload` is started without being awaited, resolves whatever
 * happens, and writes only the movie's TMDB columns — never `status`.
 * With TMDB_API_KEY missing it returns at once and the upload behaves
 * exactly as it did before this feature existed.
 *
 * A lookup claims its movie first (`tmdbStatus` → PENDING, a compare-and-
 * set on the statuses it may start from) and sets the result only while
 * the movie is still PENDING, so two lookups can never run for one movie
 * and a result never lands on a row something else has moved on. There is
 * no queue: a backend restart ends a running lookup, and at boot every
 * row still PENDING becomes FAILED / interrupted ("Try again"). A lookup
 * that ended without being able to write its result leaves the same kind
 * of row with no restart: the state route shows it as interrupted and
 * "Try again" takes it over.
 */
@Injectable()
export class TmdbLookupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TmdbLookupService.name);
  private readonly slots = new ConversionSlots(() => TMDB_LOOKUP_CONCURRENCY);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TmdbClient,
    private readonly fill: TmdbFillService,
    private readonly runs: TmdbRunRegistry,
  ) {}

  /**
   * A lookup lives in this process's memory, so one the last run left
   * PENDING will never finish. Marked FAILED / interrupted so the admin
   * shows "Try again" instead of "Finding details…" forever. Never stops
   * the boot: a failure here is logged and the server starts.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { count } = await this.prisma.movie.updateMany({
        where: { tmdbStatus: TmdbLookupStatus.PENDING },
        data: { tmdbStatus: TmdbLookupStatus.FAILED, tmdbError: 'interrupted' },
      });
      if (count > 0) {
        this.logger.warn(
          `${count} TMDB lookup(s) were interrupted by the restart — marked FAILED / interrupted`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Could not reset the TMDB lookups a restart interrupted',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Called (not awaited) as the last step of a successful finalize, in the
   * name of the staff member who uploaded. Returns at once for an episode,
   * while the feature is off, and for a movie that is already linked,
   * waiting for a pick or being looked up. The promise resolves when the
   * lookup is over and NEVER rejects.
   */
  async afterUpload(movieId: string, user: AuthenticatedUser): Promise<void> {
    try {
      if (!this.client.isEnabled) return;
      const movie = await this.prisma.movie.findUnique({
        where: { id: movieId },
        select: { seriesId: true, tmdbStatus: true },
      });
      if (!movie || movie.seriesId !== null) return;
      if (!CLAIMABLE_AFTER_UPLOAD.includes(movie.tmdbStatus)) return;

      const key = movieRunKey(movieId);
      if (!this.runs.tryStart(key)) return;
      try {
        if (await this.claim(movieId, CLAIMABLE_AFTER_UPLOAD)) {
          await this.run(movieId, user, 'upload');
        }
      } finally {
        this.runs.finish(key);
      }
    } catch (error) {
      this.logger.error(
        `The TMDB lookup after the upload of movie ${movieId} could not be started`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * "Find details" / "Try again" (POST /tmdb/movies/:id/lookup): the same
   * automatic path, started by staff and answered at once — the result
   * arrives through GET /tmdb/movies/state. 409 TMDB_BUSY while a run
   * holds the movie (a lookup or an Apply), 409 TMDB_ALREADY_MATCHED for a
   * linked movie, 400 TMDB_NOT_A_MOVIE for an episode. The status PENDING
   * alone is not "busy": with no run behind it nothing will ever finish
   * it, so this call takes it over.
   */
  async requestLookup(
    movieId: string,
    user: AuthenticatedUser,
  ): Promise<{ status: 'PENDING' }> {
    if (!this.client.isEnabled) throw tmdbNotConfigured();
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { seriesId: true, tmdbStatus: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    if (movie.seriesId !== null) {
      throw tmdbError(
        HttpStatus.BAD_REQUEST,
        TMDB_ERRORS.NOT_A_MOVIE,
        'Episodes are not filled from TMDB',
      );
    }
    if (movie.tmdbStatus === TmdbLookupStatus.MATCHED) {
      throw tmdbError(
        HttpStatus.CONFLICT,
        TMDB_ERRORS.ALREADY_MATCHED,
        'This movie already has its details from TMDB',
      );
    }

    // A lookup that is really running holds the key: that is the busy case.
    const key = movieRunKey(movieId);
    if (!this.runs.tryStart(key)) throw tmdbBusy();
    let claimed = false;
    try {
      claimed = await this.claim(movieId, CLAIMABLE_BY_STAFF);
    } finally {
      if (!claimed) this.runs.finish(key);
    }
    // The status moved between the read and the claim: another run got there.
    if (!claimed) throw tmdbBusy();

    // In the background: `run` never rejects, and the key is let go of
    // when it is over.
    void this.run(movieId, user, 'staff').finally(() => this.runs.finish(key));
    return { status: 'PENDING' };
  }

  /** The compare-and-set that makes this run the movie's one lookup. False = it was not in a claimable status. */
  private async claim(
    movieId: string,
    claimable: TmdbLookupStatus[],
  ): Promise<boolean> {
    const { count } = await this.prisma.movie.updateMany({
      where: { id: movieId, tmdbStatus: { in: claimable } },
      data: { tmdbStatus: TmdbLookupStatus.PENDING, tmdbError: null },
    });
    return count === 1;
  }

  /**
   * One claimed lookup, start to finish. Waits its turn (two at a time),
   * and whatever happens leaves the movie out of PENDING: an error nobody
   * expected becomes FAILED / internal. Only when that write fails as well
   * does the row stay PENDING, with no run behind it once the caller lets
   * go of the key. Never rejects.
   */
  private async run(
    movieId: string,
    user: AuthenticatedUser,
    trigger: 'upload' | 'staff',
  ): Promise<void> {
    try {
      await this.slots.acquire();
      try {
        const result = await this.lookup(movieId, user, trigger);
        if (result) await this.settle(movieId, result);
      } finally {
        this.slots.release();
      }
    } catch (error) {
      this.logger.error(
        `The TMDB lookup of movie ${movieId} failed unexpectedly`,
        error instanceof Error ? error.stack : String(error),
      );
      try {
        await this.settle(movieId, {
          status: TmdbLookupStatus.FAILED,
          error: 'internal',
        });
      } catch (settleError) {
        // Left PENDING with no run behind it: the state route shows it as
        // interrupted and "Try again" (requestLookup) takes it over; the
        // next boot resets it too.
        this.logger.error(
          `Could not record the failed TMDB lookup of movie ${movieId}`,
          settleError instanceof Error
            ? settleError.stack
            : String(settleError),
        );
      }
    }
  }

  /**
   * Search, decide, and fill on one clear match. Returns what to leave on
   * the movie, or null when there is nothing left to set: the fill already
   * wrote MATCHED, or the movie is gone.
   */
  private async lookup(
    movieId: string,
    user: AuthenticatedUser,
    trigger: 'upload' | 'staff',
  ): Promise<LookupResult | null> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { title: true, sourceName: true, tmdbAuto: true },
    });
    if (!movie) return null;

    const parsed = movieSearchInput(movie, new Date().getFullYear());
    const outcome = await findClearMatch(parsed, (attempt) =>
      this.client.searchMovies(attempt.query, attempt.yearFilter),
    );
    switch (outcome.kind) {
      case 'not_found':
        return { status: TmdbLookupStatus.NOT_FOUND };
      case 'needs_pick':
        return { status: TmdbLookupStatus.NEEDS_PICK };
      case 'failed':
        return {
          status: TmdbLookupStatus.FAILED,
          error: lookupErrorOf(outcome.reason),
        };
      case 'matched': {
        const filled = await this.fill.fillMovieAutomatically(
          movieId,
          outcome.row.id,
          user,
          trigger,
        );
        if (filled.outcome === 'filled') {
          this.logger.log(
            `TMDB lookup of movie ${movieId}: MATCHED to ${outcome.row.id} (${filled.report.filled.length} detail(s) filled)`,
          );
          return null;
        }
        if (filled.outcome === 'gone') return null;
        // The entry the search just listed has no details any more.
        if (filled.reason === 'not_found') {
          return { status: TmdbLookupStatus.NOT_FOUND };
        }
        return {
          status: TmdbLookupStatus.FAILED,
          error: lookupErrorOf(filled.reason),
        };
      }
    }
  }

  /** Sets the result — only while the movie is still PENDING. A status change is no catalogue content: logged, not audited. */
  private async settle(movieId: string, result: LookupResult): Promise<void> {
    const { count } = await this.prisma.movie.updateMany({
      where: { id: movieId, tmdbStatus: TmdbLookupStatus.PENDING },
      data: { tmdbStatus: result.status, tmdbError: result.error ?? null },
    });
    if (count === 1) {
      this.logger.log(
        `TMDB lookup of movie ${movieId}: ${result.status}${
          result.error ? ` (${result.error})` : ''
        }`,
      );
    }
  }
}
