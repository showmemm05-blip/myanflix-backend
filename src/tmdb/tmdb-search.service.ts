import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { tmdbFailureException, tmdbNotConfigured } from './tmdb-errors';
import { TMDB_PREVIEW_SIZES, tmdbImageUrl } from './tmdb-image-url';
import { cutText } from './tmdb-keys';
import { rowYear } from './tmdb-match';
import type { TmdbSearchRow } from './tmdb-payload';
import { TmdbClient, type TmdbResult } from './tmdb.client';
import type { TmdbSearchAnswer, TmdbSearchResult } from './tmdb.types';

/** The most characters of a candidate's story the list carries. */
export const TMDB_OVERVIEW_PREVIEW = 300;

/** A story shortened for the list: whitespace collapsed, at most 300 characters, an ellipsis when cut. */
export function overviewPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TMDB_OVERVIEW_PREVIEW) return flat;
  return `${cutText(flat, TMDB_OVERVIEW_PREVIEW - 1)}…`;
}

type UsedBy = Map<number, { id: string; title: string }>;

/**
 * The search staff start themselves — "Pick a match", "Search TMDB",
 * "Find on TMDB" (GET /tmdb/search/movie and /tmdb/search/tv, PLAN.md 5.3
 * of docs/movie-details-tmdb-2026-11-06). It never decides anything: staff
 * always get the list and choose.
 *
 * With a year, TMDB's own year filter is sent; when that finds nothing the
 * search is repeated once without it and the answer says so
 * (`yearIgnored`) — a film dated a year off should still be findable. Each
 * candidate also says which of our titles is already linked to it. Nothing
 * is written and no audit row is recorded; a search is only logged, and
 * never with the words searched for.
 */
@Injectable()
export class TmdbSearchService {
  private readonly logger = new Logger(TmdbSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TmdbClient,
  ) {}

  searchMovies(query: string, year: number | null): Promise<TmdbSearchAnswer> {
    return this.search(
      'movie',
      query,
      year,
      (text, filter) => this.client.searchMovies(text, filter),
      (ids) => this.moviesUsing(ids),
    );
  }

  searchTv(query: string, year: number | null): Promise<TmdbSearchAnswer> {
    return this.search(
      'tv',
      query,
      year,
      (text, filter) => this.client.searchTv(text, filter),
      (ids) => this.seriesUsing(ids),
    );
  }

  private async search(
    kind: 'movie' | 'tv',
    query: string,
    year: number | null,
    ask: (
      text: string,
      yearFilter: number | null,
    ) => Promise<TmdbResult<TmdbSearchRow[]>>,
    usedByOf: (tmdbIds: number[]) => Promise<UsedBy>,
  ): Promise<TmdbSearchAnswer> {
    if (!this.client.isEnabled) throw tmdbNotConfigured();
    const text = query.trim();

    let rows = this.rowsOrThrow(await ask(text, year));
    let yearIgnored = false;
    if (year !== null && rows.length === 0) {
      rows = this.rowsOrThrow(await ask(text, null));
      yearIgnored = true;
    }
    this.logger.log(
      `TMDB ${kind} search: ${rows.length} result(s)${yearIgnored ? ', year ignored' : ''}`,
    );

    const usedBy = await usedByOf(rows.map((row) => row.id));
    return {
      query: text,
      year,
      yearIgnored,
      results: rows.map((row): TmdbSearchResult => ({
        tmdbId: row.id,
        title: row.title,
        originalTitle:
          row.originalTitle !== '' && row.originalTitle !== row.title
            ? row.originalTitle
            : null,
        year: rowYear(row),
        overview: overviewPreview(row.overview),
        posterPreviewUrl: tmdbImageUrl(
          TMDB_PREVIEW_SIZES.searchPoster,
          row.posterPath,
        ),
        originalLanguage: row.originalLanguage,
        usedBy: usedBy.get(row.id) ?? null,
      })),
    };
  }

  private rowsOrThrow(answer: TmdbResult<TmdbSearchRow[]>): TmdbSearchRow[] {
    if (answer.ok) return answer.data;
    // A search has no id that could be unknown: a 404 here is TMDB not
    // being itself, not "no such title".
    throw tmdbFailureException(
      answer.reason === 'not_found' ? 'unreachable' : answer.reason,
    );
  }

  /** Our standalone movies linked to these TMDB films — the oldest one per film. Episodes are never linked. */
  private async moviesUsing(tmdbIds: number[]): Promise<UsedBy> {
    const used: UsedBy = new Map();
    if (tmdbIds.length === 0) return used;
    const movies = await this.prisma.movie.findMany({
      where: { tmdbId: { in: tmdbIds }, seriesId: null },
      select: { id: true, title: true, tmdbId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const movie of movies) {
      if (movie.tmdbId !== null && !used.has(movie.tmdbId)) {
        used.set(movie.tmdbId, { id: movie.id, title: movie.title });
      }
    }
    return used;
  }

  /** Our series linked to these TMDB shows — the oldest one per show. */
  private async seriesUsing(tmdbIds: number[]): Promise<UsedBy> {
    const used: UsedBy = new Map();
    if (tmdbIds.length === 0) return used;
    const shows = await this.prisma.series.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { id: true, title: true, tmdbId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const show of shows) {
      if (show.tmdbId !== null && !used.has(show.tmdbId)) {
        used.set(show.tmdbId, { id: show.id, title: show.title });
      }
    }
    return used;
  }
}
