import type { TmdbLookupStatus } from '../generated/prisma/client';

/**
 * The shapes the /tmdb routes answer with (PLAN.md 5.3 of
 * docs/movie-details-tmdb-2026-11-06). The admin keeps the same shapes in
 * admin/types/tmdb.ts; a field renamed here must be renamed there.
 */

/**
 * One detail a fill can write. A movie has all thirteen. `poster` and
 * `cover` are the two pictures (`posterUrl` / `coverUrl` on the row),
 * `country` is the TYPE word ("Korean"), `categories` and `cast` are the
 * two list details.
 */
export const TMDB_MOVIE_FIELDS = [
  'title',
  'description',
  'releaseYear',
  'duration',
  'genre',
  'language',
  'country',
  'director',
  'ageRating',
  'poster',
  'cover',
  'categories',
  'cast',
] as const;

export type TmdbField = (typeof TMDB_MOVIE_FIELDS)[number];

/** A series has no runtime, director or age rating column, so it has ten. */
export const TMDB_SERIES_FIELDS: readonly TmdbField[] =
  TMDB_MOVIE_FIELDS.filter(
    (field) =>
      field !== 'duration' && field !== 'director' && field !== 'ageRating',
  );

/** Which of our two catalogues a title belongs to. An episode is neither: episodes are not looked up. */
export type TmdbTitleKind = 'movie' | 'series';

export function tmdbFieldsFor(kind: TmdbTitleKind): readonly TmdbField[] {
  return kind === 'movie' ? TMDB_MOVIE_FIELDS : TMDB_SERIES_FIELDS;
}

/** Whether the backend can reach TMDB right now. `off` = no TMDB_API_KEY. */
export type TmdbConnectionState =
  'off' | 'connected' | 'key_rejected' | 'unreachable' | 'rate_limited';

/** GET /tmdb/status. */
export interface TmdbStatus {
  /** False = TMDB_API_KEY is missing: the feature is off. */
  configured: boolean;
  state: TmdbConnectionState;
  /** When TMDB was last asked; null while off. */
  checkedAt: string | null;
}

/** One candidate of a staff search. */
export interface TmdbSearchResult {
  tmdbId: number;
  title: string;
  /** Only when it differs from `title`. */
  originalTitle: string | null;
  year: number | null;
  /** At most 300 characters. */
  overview: string;
  /** A small poster on TMDB's own image server — for the admin's list only, never for viewers. */
  posterPreviewUrl: string | null;
  /** TMDB's language code ("ko"), not a display word. */
  originalLanguage: string | null;
  /** One of our titles already linked to this entry. */
  usedBy: { id: string; title: string } | null;
}

/** GET /tmdb/search/movie and /tmdb/search/tv. */
export interface TmdbSearchAnswer {
  query: string;
  year: number | null;
  /** True when the year gave no rows and the search was repeated without it. */
  yearIgnored: boolean;
  results: TmdbSearchResult[];
}

/** Why a lookup FAILED — the values Movie.tmdbError may hold. */
export const TMDB_LOOKUP_ERRORS = [
  'unreachable',
  'rate_limited',
  'key_rejected',
  'interrupted',
  'internal',
] as const;

export type TmdbLookupError = (typeof TMDB_LOOKUP_ERRORS)[number];

/** The TMDB entry a title is linked to, for display: "Inception (2010)". */
export interface TmdbMatchRef {
  title: string;
  year: number | null;
}

/** Whether a stored picture came from TMDB, was uploaded by staff, or is missing. */
export type TmdbImageSource = 'tmdb' | 'own' | 'none';

/** One row of GET /tmdb/movies/state. */
export interface TmdbMovieState {
  movieId: string;
  status: TmdbLookupStatus;
  error: TmdbLookupError | null;
  tmdbId: number | null;
  match: TmdbMatchRef | null;
  fetchedAt: string | null;
  /** The raw folder name of the upload. */
  sourceName: string | null;
  /** What the pick-a-match dialog starts with (PLAN.md 2.4). */
  search: { query: string; year: number | null };
  images: { poster: TmdbImageSource; cover: TmdbImageSource };
  /** Fields that still hold the value the linked TMDB entry put there (the "From TMDB" tags). */
  autoFields: TmdbField[];
}

/** GET /tmdb/series/:id/state. A series has no lookup status: staff always start its lookups. */
export interface TmdbSeriesState {
  seriesId: string;
  tmdbId: number | null;
  match: TmdbMatchRef | null;
  fetchedAt: string | null;
  /** The series title; the year is always null. */
  search: { query: string; year: number | null };
  images: { poster: TmdbImageSource; cover: TmdbImageSource };
  autoFields: TmdbField[];
}

/**
 * How one detail stands before an apply: `empty` = nothing there now,
 * `auto` = still the automatic value, `hand` = changed by staff, `same` =
 * already equal to TMDB's, `none` = TMDB has no value.
 */
export type TmdbPreviewLineState = 'empty' | 'auto' | 'hand' | 'same' | 'none';

/** A display value. Lists: names. Pictures: our URL now, a TMDB preview URL proposed. */
export type TmdbPreviewValue = string | number | string[] | null;

export interface TmdbPreviewLine {
  field: TmdbField;
  current: TmdbPreviewValue;
  proposed: TmdbPreviewValue;
  state: TmdbPreviewLineState;
  /** True only for `empty` and `auto`: what a fill writes without being asked. */
  defaultOn: boolean;
}

/** What an apply would do with one person of the cast. */
export type TmdbCastAction =
  'reuse' | 'create' | 'skip_same_name' | 'skip_no_permission';

export interface TmdbPreviewCastMember {
  name: string;
  tmdbPersonId: number;
  action: TmdbCastAction;
  /** The actor that would be attached; null for a person to create or to skip. */
  actorId: string | null;
  /** Whether TMDB has a photo of this person. */
  hasPhoto: boolean;
}

/** POST /tmdb/movies/:id/preview and /tmdb/series/:id/preview. Nothing is written or downloaded for it. */
export interface TmdbPreview {
  tmdbId: number;
  match: TmdbMatchRef;
  fields: TmdbPreviewLine[];
  cast: TmdbPreviewCastMember[];
  categories: {
    /** Existing categories the apply would connect and the title does not have yet. */
    add: Array<{ id: string; name: string }>;
    /** TMDB genres with no category of ours. Categories are never created. */
    unmatched: string[];
  };
}

export type TmdbSkipReason = 'hand' | 'no_value' | 'image_failed';

/** What a fill really did — returned by apply and by a series created from TMDB. */
export interface TmdbFillReport {
  filled: TmdbField[];
  skipped: Array<{ field: TmdbField; reason: TmdbSkipReason }>;
  actors: {
    reused: number;
    created: number;
    skipped: Array<{ name: string; reason: 'same_name' | 'no_permission' }>;
  };
  categories: { added: string[]; unmatched: string[] };
}
