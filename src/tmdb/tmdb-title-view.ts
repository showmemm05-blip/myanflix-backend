import type { Movie, Series } from '../generated/prisma/client';
import type { TmdbTitleView } from './tmdb-auto';

/**
 * A stored movie or series as the comparable values tmdb-auto.ts works on.
 * Only the ids of the two list details are needed, so a caller may load the
 * relations with a narrow select.
 */

type WithListIds = {
  categories: ReadonlyArray<{ id: string }>;
  actors: ReadonlyArray<{ id: string }>;
};

export type MovieViewSource = Pick<
  Movie,
  | 'title'
  | 'description'
  | 'releaseYear'
  | 'duration'
  | 'genre'
  | 'language'
  | 'country'
  | 'director'
  | 'ageRating'
  | 'posterUrl'
  | 'coverUrl'
> &
  WithListIds;

export type SeriesViewSource = Pick<
  Series,
  | 'title'
  | 'description'
  | 'releaseYear'
  | 'genre'
  | 'language'
  | 'country'
  | 'posterUrl'
  | 'coverUrl'
> &
  WithListIds;

export function movieView(row: MovieViewSource): TmdbTitleView {
  return {
    title: row.title,
    description: row.description,
    releaseYear: row.releaseYear,
    duration: row.duration,
    genre: row.genre,
    language: row.language,
    country: row.country,
    director: row.director,
    ageRating: row.ageRating,
    posterUrl: row.posterUrl,
    coverUrl: row.coverUrl,
    categoryIds: row.categories.map((category) => category.id),
    actorIds: row.actors.map((actor) => actor.id),
  };
}

export function seriesView(row: SeriesViewSource): TmdbTitleView {
  return {
    title: row.title,
    description: row.description,
    releaseYear: row.releaseYear,
    // A series has no runtime, director or age rating column: their empty
    // placeholders, and those three fields are never asked about.
    duration: 0,
    genre: row.genre,
    language: row.language,
    country: row.country,
    director: null,
    ageRating: null,
    posterUrl: row.posterUrl,
    coverUrl: row.coverUrl,
    categoryIds: row.categories.map((category) => category.id),
    actorIds: row.actors.map((actor) => actor.id),
  };
}
