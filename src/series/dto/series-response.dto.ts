import type { Actor } from '../../generated/prisma/client';
import type { ImageUrlResolver } from '../../movies/dto/movie-response.dto';

/** A cast entry as every series response carries it — same shape as MovieResponseDto.actors. */
export interface SeriesActorRef {
  id: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Series columns that never leave the API. A series response is the stored
 * row passed through (unlike a movie's, which is a whitelist), and guests
 * read it — so the TMDB bookkeeping is taken out by name. Staff read it
 * through the /tmdb/series routes instead. A new staff-only column on
 * Series belongs in this list; series-response.dto.spec.ts fails when a
 * column is in neither this list nor the list of fields a response carries.
 */
export const SERIES_STAFF_ONLY_FIELDS = [
  'tmdbId',
  'tmdbFetchedAt',
  'tmdbAuto',
] as const;

export type SeriesStaffOnlyField = (typeof SERIES_STAFF_ONLY_FIELDS)[number];

/** What toSeriesResponse turns a stored row (plus any extras it carries) into. */
export type SeriesResponse<T> = Omit<T, 'actors' | SeriesStaffOnlyField> & {
  actors: SeriesActorRef[];
};

/**
 * The one mapper every series response goes through — list rows, detail,
 * and the rows create / update / publish return (SeriesService), and the
 * shows the TMDB module creates or fills.
 *
 * Three things happen to the stored row: the staff-only TMDB columns are
 * dropped; the poster and cover URLs, persisted absolute with whatever host
 * uploaded them, are re-hosted against the current request (see
 * MinioService.imageUrl — `resolveImageUrl` is that method); and the cast
 * is trimmed to what a client renders, headshots re-hosted. Everything else
 * — `descriptionMm` included — passes through as stored. Purely a read-time
 * derivation: nothing is written back.
 */
export function toSeriesResponse<
  T extends {
    posterUrl: string | null;
    coverUrl: string | null;
    actors?: Actor[];
  },
>(series: T, resolveImageUrl: ImageUrlResolver): SeriesResponse<T> {
  const viewable: Partial<Record<SeriesStaffOnlyField, unknown>> & T = {
    ...series,
  };
  for (const field of SERIES_STAFF_ONLY_FIELDS) delete viewable[field];
  return {
    ...viewable,
    posterUrl: resolveImageUrl(series.posterUrl),
    coverUrl: resolveImageUrl(series.coverUrl),
    // The exact shape MovieResponseDto.actors has, so the clients share one
    // type for both.
    actors: (series.actors ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      imageUrl: resolveImageUrl(a.imageUrl),
    })),
  };
}
