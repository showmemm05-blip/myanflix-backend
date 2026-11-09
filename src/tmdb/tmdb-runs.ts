import { Injectable } from '@nestjs/common';
import { tmdbBusy } from './tmdb-errors';

/** The run key of one of our movies, of one of our series, and of a show being created from a TMDB entry. */
export const movieRunKey = (movieId: string) => `movie:${movieId}`;
export const seriesRunKey = (seriesId: string) => `series:${seriesId}`;
export const tvCreateRunKey = (tmdbId: number) => `tv:${tmdbId}`;

/**
 * One TMDB run per title at a time. The automatic lookup, "Find details"
 * and Apply all read a title, fetch pictures and cast for it, and write it
 * back; two of them interleaving on one title would each work from a row
 * the other is about to change. So each takes the title's key first, and
 * whoever finds it taken is told "Details are being fetched for this
 * title" (409 TMDB_BUSY) instead of joining in. The same guard keeps two
 * clicks on "Create series" from making the same show twice.
 *
 * In memory on purpose: the backend runs as one process, and a restart
 * ends every run anyway (TmdbLookupService resets the rows it left PENDING
 * at boot).
 */
@Injectable()
export class TmdbRunRegistry {
  private readonly running = new Set<string>();

  /** Takes the key; false when a run already holds it. The caller that got true must `finish` it. */
  tryStart(key: string): boolean {
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  finish(key: string): void {
    this.running.delete(key);
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** Runs `work` holding the key and lets go of it however `work` ends; 409 TMDB_BUSY when it is taken. */
  async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (!this.tryStart(key)) throw tmdbBusy();
    try {
      return await work();
    } finally {
      this.finish(key);
    }
  }
}
