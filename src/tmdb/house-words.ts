/**
 * The house words — the fixed lists the admin's forms offer for a title's
 * genre, spoken language and type (admin/lib/constants/movie-options.ts).
 *
 * The backend stores all three as free text and never validated them, so it
 * never needed the lists. The TMDB fill does: it writes those columns by
 * itself, and a word the admin's lists do not carry would show up as an
 * unknown value in the edit form and in the catalogue's filters. Every word
 * tmdb-mapping.ts can write is therefore taken from here, and
 * house-words.spec.ts compares these lists with the admin's file (skipped
 * where that file is not present — the Docker build context is backend/
 * only). A word added to the admin's list goes here too.
 */

/** The 16 genres of the admin's genre list (`GENRE_OPTIONS`), in its order. */
export const HOUSE_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Musical',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Thriller',
] as const;

export type HouseGenre = (typeof HOUSE_GENRES)[number];

/**
 * The language words (`LANGUAGES`): the eight the admin always had plus
 * `Thai`, added with this feature. `Movie.language` / `Series.language`
 * hold one of these display words, never a language code.
 */
export const HOUSE_LANGUAGES = [
  'English',
  'Burmese',
  'Korean',
  'Japanese',
  'Hindi',
  'Chinese',
  'Spanish',
  'French',
  'Thai',
] as const;

export type HouseLanguage = (typeof HOUSE_LANGUAGES)[number];

/**
 * The type words (`MEDIA_TYPES`, owner 2026-10-27), kept in the `country`
 * column and shown as "Korean movie" / "Korean series". Not countries.
 */
export const HOUSE_TYPES = [
  'English',
  'Korean',
  'Chinese',
  'Thai',
  'Japanese',
  'Indian',
  'Myanmar',
  'Other',
] as const;

export type HouseType = (typeof HOUSE_TYPES)[number];
