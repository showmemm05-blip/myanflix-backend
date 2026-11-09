import { Injectable, NotFoundException } from '@nestjs/common';
import { TmdbLookupStatus } from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import {
  parseSourceName,
  type ParsedSourceName,
} from '../common/utils/source-name.util';
import { isTmdbImageKey } from '../images/image-source';
import { PrismaService } from '../prisma/prisma.service';
import {
  fieldStanding,
  readTmdbAuto,
  type ImageKeyOf,
  type TmdbAuto,
  type TmdbTitleView,
} from './tmdb-auto';
import { tmdbNotConfigured } from './tmdb-errors';
import { TmdbRunRegistry, movieRunKey } from './tmdb-runs';
import { movieView, seriesView } from './tmdb-title-view';
import { TmdbClient } from './tmdb.client';
import {
  TMDB_LOOKUP_ERRORS,
  tmdbFieldsFor,
  type TmdbField,
  type TmdbImageSource,
  type TmdbLookupError,
  type TmdbMovieState,
  type TmdbSeriesState,
  type TmdbTitleKind,
} from './tmdb.types';

/** Only the ids of the two list details are needed to tell whether they are still automatic. */
const LIST_IDS = {
  categories: { select: { id: true } },
  actors: { select: { id: true } },
} as const;

/**
 * What the automatic search of a movie starts from (PLAN.md 2.4): the
 * folder name, read by parseSourceName — unless staff renamed the title
 * since it was born, in which case their name is what they mean. A row
 * with no tmdbAuto (it predates the feature) has no birth title to compare
 * with, and no folder name either: its title is used.
 *
 * Shared by the lookup (what to search for) and the state route (what the
 * pick-a-match dialog starts with), so both always agree.
 */
export function movieSearchInput(
  movie: { title: string; sourceName: string | null; tmdbAuto: unknown },
  currentYear: number,
): ParsedSourceName {
  const bornTitle = readTmdbAuto(movie.tmdbAuto)?.title;
  const renamed = bornTitle === undefined || movie.title !== bornTitle;
  return parseSourceName(
    renamed ? movie.title : (movie.sourceName ?? movie.title),
    currentYear,
  );
}

/**
 * Where each title stands with TMDB, for the admin's badges, strips and
 * "From TMDB" tags (GET /tmdb/movies/state and /tmdb/series/:id/state,
 * PLAN.md 5.3 of docs/movie-details-tmdb-2026-11-06). This is the only
 * place the staff-only columns (`sourceName`, every `tmdb*`) leave the
 * API: MovieResponseDto and toSeriesResponse deliberately drop them,
 * because guests read those.
 */
@Injectable()
export class TmdbStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TmdbClient,
    private readonly minioService: MinioService,
    private readonly runs: TmdbRunRegistry,
  ) {}

  private readonly keyOf: ImageKeyOf = (url) =>
    this.minioService.keyFromPublicUrl(url);

  /**
   * The state of each movie that exists, in the order asked. An unknown id
   * is simply not in the answer.
   *
   * Answered with TMDB_API_KEY missing too (the one /tmdb route besides
   * the status that is): it reads only our own rows, and the folder name
   * of an upload must stay readable while TMDB is not connected — the
   * title was already cut out of it when the movie was born.
   */
  async movieStates(
    ids: readonly string[],
  ): Promise<{ items: TmdbMovieState[] }> {
    // Asked before the rows are read as well as after: a lookup that ends
    // while they are being read must not look like one with no run.
    const runningBefore = new Set(
      ids.filter((id) => this.runs.isRunning(movieRunKey(id))),
    );
    const movies = await this.prisma.movie.findMany({
      where: { id: { in: [...ids] } },
      include: LIST_IDS,
    });
    const byId = new Map(movies.map((movie) => [movie.id, movie]));
    const currentYear = new Date().getFullYear();
    const items: TmdbMovieState[] = [];
    for (const id of new Set(ids)) {
      const movie = byId.get(id);
      if (!movie) continue;
      const auto = readTmdbAuto(movie.tmdbAuto);
      const search = movieSearchInput(movie, currentYear);
      // Every lookup holds its movie's run from before the claim until its
      // result is written, so PENDING with no run is a lookup whose result
      // could not be recorded and that nothing will finish. It is shown as
      // interrupted — "Try again", which requestLookup accepts — without
      // writing anything here.
      const abandoned =
        movie.tmdbStatus === TmdbLookupStatus.PENDING &&
        !runningBefore.has(id) &&
        !this.runs.isRunning(movieRunKey(id));
      items.push({
        movieId: movie.id,
        status: abandoned ? TmdbLookupStatus.FAILED : movie.tmdbStatus,
        error: abandoned
          ? 'interrupted'
          : this.lookupError(movie.tmdbStatus, movie.tmdbError),
        tmdbId: movie.tmdbId,
        match: movie.tmdbId !== null ? (auto?.match ?? null) : null,
        fetchedAt: movie.tmdbFetchedAt?.toISOString() ?? null,
        sourceName: movie.sourceName,
        search: { query: search.query, year: search.year },
        images: {
          poster: this.imageSource(movie.posterUrl),
          cover: this.imageSource(movie.coverUrl),
        },
        autoFields: this.autoFields(
          'movie',
          movie.tmdbId,
          movieView(movie),
          auto,
        ),
      });
    }
    return { items };
  }

  async seriesState(seriesId: string): Promise<TmdbSeriesState> {
    if (!this.client.isEnabled) throw tmdbNotConfigured();
    const series = await this.prisma.series.findUnique({
      where: { id: seriesId },
      include: LIST_IDS,
    });
    if (!series) throw new NotFoundException('Series not found');
    const auto = readTmdbAuto(series.tmdbAuto);
    return {
      seriesId: series.id,
      tmdbId: series.tmdbId,
      match: series.tmdbId !== null ? (auto?.match ?? null) : null,
      fetchedAt: series.tmdbFetchedAt?.toISOString() ?? null,
      // A show has no folder name: its lookup starts from the name staff typed.
      search: { query: series.title, year: null },
      images: {
        poster: this.imageSource(series.posterUrl),
        cover: this.imageSource(series.coverUrl),
      },
      autoFields: this.autoFields(
        'series',
        series.tmdbId,
        seriesView(series),
        auto,
      ),
    };
  }

  /** The reason of a FAILED lookup; null in every other status. An unknown text reads as `internal`. */
  private lookupError(
    status: TmdbLookupStatus,
    stored: string | null,
  ): TmdbLookupError | null {
    if (status !== TmdbLookupStatus.FAILED) return null;
    return (TMDB_LOOKUP_ERRORS as readonly string[]).includes(stored ?? '')
      ? (stored as TmdbLookupError)
      : 'internal';
  }

  /** Read off the picture's file name alone — see images/image-source.ts. */
  private imageSource(url: string | null): TmdbImageSource {
    if (!url) return 'none';
    return isTmdbImageKey(this.keyOf(url)) ? 'tmdb' : 'own';
  }

  /**
   * The fields that still hold what the linked TMDB entry put there. A
   * title that is not linked has none: the title and year a bulk upload is
   * born with are remembered in tmdbAuto too, but they came from the
   * folder name, not from TMDB.
   */
  private autoFields(
    kind: TmdbTitleKind,
    tmdbId: number | null,
    view: TmdbTitleView,
    auto: TmdbAuto | null,
  ): TmdbField[] {
    if (tmdbId === null || auto === null) return [];
    return tmdbFieldsFor(kind).filter(
      (field) => fieldStanding(field, view, auto, this.keyOf) === 'auto',
    );
  }
}
