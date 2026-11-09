import type { AgeRating } from '../generated/prisma/client';
import { MAX_DURATION_MINUTES } from '../videos/duration.util';
import type { HouseGenre, HouseLanguage, HouseType } from './house-words';
import { cutText, wordKey } from './tmdb-keys';
import { isTmdbImagePath } from './tmdb-image-url';
import type {
  TmdbCastRow,
  TmdbCertification,
  TmdbCrewRow,
  TmdbGenre,
  TmdbMovieDetails,
  TmdbTvDetails,
} from './tmdb-payload';
import type { TmdbMatchRef } from './tmdb.types';

/**
 * TMDB's details → the values MyanFlix would store (PLAN.md 2.6 to 2.8 and
 * 2.10 of docs/movie-details-tmdb-2026-11-06). Pure: no database, no
 * network, so every table below is tested as a table.
 *
 * A `null` in the result always means "TMDB has no value for this": the
 * fill then leaves the field to staff. Nothing is invented — a genre that
 * maps to no house word is no genre, a language outside the list is no
 * language word.
 */

/** The longest title, description, director and actor name the catalogue stores. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const PERSON_NAME_MAX = 120;

/** The years a title may carry (the bounds CreateMovieDto.releaseYear checks). */
const YEAR_MIN = 1888;
const YEAR_MAX = 2100;

/** How many people of a cast are taken, in TMDB's billing order. */
export const TMDB_CAST_LIMIT = 10;

/** One person of the cast a fill would attach. */
export interface TmdbCastPerson {
  tmdbPersonId: number;
  /** NFC, trimmed, inner spaces collapsed, at most 120 characters. */
  name: string;
  /** TMDB's photo path, already checked; null = TMDB has no photo. */
  profilePath: string | null;
}

/** Everything one TMDB entry offers, in our words. */
export interface TmdbProposal {
  tmdbId: number;
  /** The entry itself, for display: "Inception (2010)". */
  match: TmdbMatchRef;
  title: string | null;
  description: string | null;
  releaseYear: number | null;
  /** Minutes. Movies only. */
  duration: number | null;
  genre: string | null;
  language: string | null;
  /** The TYPE word kept in the `country` column. */
  country: string | null;
  /** Movies only. */
  director: string | null;
  /** Movies only. */
  ageRating: AgeRating | null;
  posterPath: string | null;
  coverPath: string | null;
  /** The words to look for among our categories — see mapGenres. */
  categoryWords: string[];
  cast: TmdbCastPerson[];
}

interface GenreRule {
  id: number;
  /** TMDB's own name for the genre — the fallback when an id is unknown. */
  name: string;
  /** The house genre it becomes; null = none (it can still be a category). */
  genre: HouseGenre | null;
  /** A second house word offered to the categories only (TMDB's combined TV genres). */
  alsoCategory?: HouseGenre;
}

/**
 * TMDB genre → house genre, by id (PLAN.md 2.7). The ids are TMDB's fixed
 * movie and TV genre ids; they are to be confirmed against /genre/movie/list
 * and /genre/tv/list in the live probe, which is why an unknown id falls
 * back to the name.
 */
const GENRE_RULES: readonly GenreRule[] = [
  { id: 28, name: 'Action', genre: 'Action' },
  { id: 12, name: 'Adventure', genre: 'Adventure' },
  { id: 16, name: 'Animation', genre: 'Animation' },
  { id: 35, name: 'Comedy', genre: 'Comedy' },
  { id: 80, name: 'Crime', genre: 'Crime' },
  { id: 99, name: 'Documentary', genre: 'Documentary' },
  { id: 18, name: 'Drama', genre: 'Drama' },
  { id: 10751, name: 'Family', genre: 'Family' },
  { id: 14, name: 'Fantasy', genre: 'Fantasy' },
  { id: 36, name: 'History', genre: 'History' },
  { id: 27, name: 'Horror', genre: 'Horror' },
  { id: 9648, name: 'Mystery', genre: 'Mystery' },
  { id: 10749, name: 'Romance', genre: 'Romance' },
  { id: 53, name: 'Thriller', genre: 'Thriller' },
  { id: 878, name: 'Science Fiction', genre: 'Sci-Fi' },
  { id: 10402, name: 'Music', genre: 'Musical' },
  // TV: two genres in one. The first is the genre, the second a category.
  {
    id: 10759,
    name: 'Action & Adventure',
    genre: 'Action',
    alsoCategory: 'Adventure',
  },
  {
    id: 10765,
    name: 'Sci-Fi & Fantasy',
    genre: 'Sci-Fi',
    alsoCategory: 'Fantasy',
  },
  { id: 10762, name: 'Kids', genre: 'Family' },
  { id: 10766, name: 'Soap', genre: 'Drama' },
  // No house genre: staff choose. Their TMDB name is still offered to the
  // categories, so a "War" category of ours gets connected.
  { id: 10770, name: 'TV Movie', genre: null },
  { id: 10752, name: 'War', genre: null },
  { id: 37, name: 'Western', genre: null },
  { id: 10763, name: 'News', genre: null },
  { id: 10764, name: 'Reality', genre: null },
  { id: 10767, name: 'Talk', genre: null },
  { id: 10768, name: 'War & Politics', genre: null },
];

const GENRE_BY_ID: ReadonlyMap<number, GenreRule> = new Map(
  GENRE_RULES.map((rule) => [rule.id, rule]),
);
const GENRE_BY_NAME: ReadonlyMap<string, GenreRule> = new Map(
  GENRE_RULES.map((rule) => [wordKey(rule.name), rule]),
);

/** Every TMDB genre id the table knows — what the live probe compares with TMDB's lists. */
export const KNOWN_TMDB_GENRE_IDS: readonly number[] = GENRE_RULES.map(
  (rule) => rule.id,
);

/**
 * The genre field and the category words of a title.
 *
 * `genre` is the house word of the FIRST TMDB genre (TMDB's own order) that
 * maps; none maps = null. `categoryWords` is every mapped house word plus
 * the TMDB name of every genre that maps to none — the fill connects each
 * existing category whose name is one of them and never creates one.
 */
export function mapGenres(genres: readonly TmdbGenre[]): {
  genre: HouseGenre | null;
  categoryWords: string[];
} {
  let genre: HouseGenre | null = null;
  const words: string[] = [];
  const seen = new Set<string>();
  const offer = (word: string) => {
    const key = wordKey(word);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    words.push(word);
  };
  for (const entry of genres) {
    const rule =
      GENRE_BY_ID.get(entry.id) ?? GENRE_BY_NAME.get(wordKey(entry.name));
    if (rule?.genre) {
      genre ??= rule.genre;
      offer(rule.genre);
      if (rule.alsoCategory) offer(rule.alsoCategory);
    } else {
      offer(entry.name.trim() || rule?.name || '');
    }
  }
  return { genre, categoryWords: words };
}

interface LanguageRule {
  type: HouseType | null;
  language: HouseLanguage | null;
}

const INDIAN_WITHOUT_WORD: LanguageRule = { type: 'Indian', language: null };

/** TMDB `original_language` → the type word and the language word (PLAN.md 2.8). */
const LANGUAGE_RULES: Readonly<Record<string, LanguageRule>> = {
  en: { type: 'English', language: 'English' },
  ko: { type: 'Korean', language: 'Korean' },
  zh: { type: 'Chinese', language: 'Chinese' },
  // TMDB's own code for Cantonese.
  cn: { type: 'Chinese', language: 'Chinese' },
  th: { type: 'Thai', language: 'Thai' },
  ja: { type: 'Japanese', language: 'Japanese' },
  hi: { type: 'Indian', language: 'Hindi' },
  // Indian films in a language the admin's list has no word for.
  ta: INDIAN_WITHOUT_WORD,
  te: INDIAN_WITHOUT_WORD,
  ml: INDIAN_WITHOUT_WORD,
  kn: INDIAN_WITHOUT_WORD,
  bn: INDIAN_WITHOUT_WORD,
  mr: INDIAN_WITHOUT_WORD,
  pa: INDIAN_WITHOUT_WORD,
  gu: INDIAN_WITHOUT_WORD,
  my: { type: 'Myanmar', language: 'Burmese' },
  // A language word but no type of its own: the country decides the type.
  es: { type: null, language: 'Spanish' },
  fr: { type: null, language: 'French' },
};

/** Country code → type word, used only when the language gave none. */
const COUNTRY_TYPES: Readonly<Record<string, HouseType>> = {
  US: 'English',
  GB: 'English',
  CA: 'English',
  AU: 'English',
  NZ: 'English',
  IE: 'English',
  KR: 'Korean',
  CN: 'Chinese',
  HK: 'Chinese',
  TW: 'Chinese',
  TH: 'Thai',
  JP: 'Japanese',
  IN: 'Indian',
  MM: 'Myanmar',
};

function languageRule(originalLanguage: string | null): LanguageRule | null {
  const code = originalLanguage?.trim().toLowerCase() ?? '';
  return code !== '' && Object.hasOwn(LANGUAGE_RULES, code)
    ? LANGUAGE_RULES[code]
    : null;
}

/** The display word for the `language` column, or null when the list has none for it. */
export function mapLanguageWord(
  originalLanguage: string | null,
): HouseLanguage | null {
  return languageRule(originalLanguage)?.language ?? null;
}

/**
 * The TYPE word for the `country` column: from the original language
 * first, then from the FIRST country code TMDB lists (production countries
 * of a film, origin countries of a show). TMDB gave a language or a country
 * but neither is on the list: "Other". TMDB gave neither: null.
 */
export function mapTypeWord(
  originalLanguage: string | null,
  countries: readonly string[],
): HouseType | null {
  const fromLanguage = languageRule(originalLanguage)?.type;
  if (fromLanguage) return fromLanguage;
  const firstCountry = countries[0]?.trim().toUpperCase() ?? '';
  if (firstCountry !== '' && Object.hasOwn(COUNTRY_TYPES, firstCountry)) {
    return COUNTRY_TYPES[firstCountry];
  }
  const hasLanguage = (originalLanguage?.trim() ?? '') !== '';
  return hasLanguage || firstCountry !== '' ? 'Other' : null;
}

const AGE_RATINGS: Readonly<Record<string, AgeRating>> = {
  G: 'G',
  PG: 'PG',
  'PG-13': 'PG13',
  R: 'R',
  'NC-17': 'NC17',
};

/**
 * A film's age rating from its US releases: the first certification that
 * is not blank, looking at the theatrical releases (type 3) first and then
 * at any release. TMDB pads some with spaces (`PG-13 `), hence the trim.
 * Anything that is not one of our five ratings (`NR`, `TV-MA`, `Unrated`)
 * is no rating: staff choose.
 */
export function mapAgeRating(
  usCertifications: readonly TmdbCertification[],
): AgeRating | null {
  const firstStated = (list: readonly TmdbCertification[]) =>
    list
      .map((entry) => entry.certification.trim())
      .find((value) => value !== '');
  const stated =
    firstStated(usCertifications.filter((entry) => entry.type === 3)) ??
    firstStated(usCertifications);
  const key = stated?.toUpperCase() ?? '';
  return Object.hasOwn(AGE_RATINGS, key) ? AGE_RATINGS[key] : null;
}

/** A person's name as the catalogue stores it: one spelling, single spaces, at most 120 characters. */
export function cleanPersonName(name: string): string {
  let text = name;
  try {
    text = name.normalize('NFC');
  } catch {
    // A runtime without Unicode tables: keep the name as TMDB sent it.
  }
  return cutText(text.replace(/\s+/g, ' '), PERSON_NAME_MAX);
}

/** The first crew member whose job is exactly "Director", or null. */
export function mapDirector(crew: readonly TmdbCrewRow[]): string | null {
  const director = crew.find((member) => member.job === 'Director');
  const name = director ? cleanPersonName(director.name) : '';
  return name === '' ? null : name;
}

/**
 * The cast a fill takes: the first ten people in TMDB's billing order,
 * without rows that have no name and without people who are only credited
 * as "uncredited". A person listed twice (two roles in one film) is taken
 * once, at their first position.
 */
export function mapCast(rows: readonly TmdbCastRow[]): TmdbCastPerson[] {
  const uncredited = (row: TmdbCastRow) =>
    row.characters.length > 0 &&
    row.characters.every((character) =>
      character.toLowerCase().includes('uncredited'),
    );
  const people: TmdbCastPerson[] = [];
  const seen = new Set<number>();
  const ordered = rows
    .filter((row) => row.name.trim() !== '' && !uncredited(row))
    // Array.prototype.sort is stable: equal orders keep TMDB's sequence.
    .sort((a, b) => a.order - b.order);
  for (const row of ordered) {
    if (people.length >= TMDB_CAST_LIMIT) break;
    if (seen.has(row.id)) continue;
    const name = cleanPersonName(row.name);
    if (name === '') continue;
    seen.add(row.id);
    people.push({
      tmdbPersonId: row.id,
      name,
      profilePath: isTmdbImagePath(row.profilePath) ? row.profilePath : null,
    });
  }
  return people;
}

/** The year of a TMDB date ("2010-07-16"), or null when there is none. */
export function yearOfDate(date: string): number | null {
  const text = date.slice(0, 4);
  return /^\d{4}$/.test(text) ? Number(text) : null;
}

/** A year the catalogue accepts as a release year, or null. */
function releaseYearOf(date: string): number | null {
  const year = yearOfDate(date);
  return year !== null && year >= YEAR_MIN && year <= YEAR_MAX ? year : null;
}

function textOrNull(text: string, max: number): string | null {
  const cut = cutText(text, max);
  return cut === '' ? null : cut;
}

function pathOrNull(path: string | null): string | null {
  return isTmdbImagePath(path) ? path : null;
}

function matchRef(
  title: string,
  originalTitle: string,
  date: string,
): TmdbMatchRef {
  return {
    title: cutText(title, TITLE_MAX) || cutText(originalTitle, TITLE_MAX),
    year: yearOfDate(date),
  };
}

/** A film's details in our words (PLAN.md 2.6). */
export function mapMovieDetails(details: TmdbMovieDetails): TmdbProposal {
  const { genre, categoryWords } = mapGenres(details.genres);
  const runtime = details.runtime !== null ? Math.round(details.runtime) : null;
  return {
    tmdbId: details.id,
    match: matchRef(details.title, details.originalTitle, details.releaseDate),
    title: textOrNull(details.title, TITLE_MAX),
    description: textOrNull(details.overview, DESCRIPTION_MAX),
    releaseYear: releaseYearOf(details.releaseDate),
    duration:
      runtime !== null && runtime >= 1 && runtime <= MAX_DURATION_MINUTES
        ? runtime
        : null,
    genre,
    language: mapLanguageWord(details.originalLanguage),
    country: mapTypeWord(details.originalLanguage, details.productionCountries),
    director: mapDirector(details.crew),
    ageRating: mapAgeRating(details.usCertifications),
    posterPath: pathOrNull(details.posterPath),
    coverPath: pathOrNull(details.backdropPath),
    categoryWords,
    cast: mapCast(details.cast),
  };
}

/** A show's details in our words. A series has no runtime, director or age rating column. */
export function mapTvDetails(details: TmdbTvDetails): TmdbProposal {
  const { genre, categoryWords } = mapGenres(details.genres);
  return {
    tmdbId: details.id,
    match: matchRef(details.title, details.originalTitle, details.firstAirDate),
    title: textOrNull(details.title, TITLE_MAX),
    description: textOrNull(details.overview, DESCRIPTION_MAX),
    releaseYear: releaseYearOf(details.firstAirDate),
    duration: null,
    genre,
    language: mapLanguageWord(details.originalLanguage),
    country: mapTypeWord(details.originalLanguage, details.originCountries),
    director: null,
    ageRating: null,
    posterPath: pathOrNull(details.posterPath),
    coverPath: pathOrNull(details.backdropPath),
    categoryWords,
    cast: mapCast(details.cast),
  };
}

/**
 * Which of our categories the category words name, and which words name
 * none. A category matches when its name has the same wordKey as a word
 * (`Sci-Fi` = `sci fi`); every category that matches is returned, in the
 * words' order. Categories are never created: an unmatched word is only
 * reported to staff.
 */
export function matchCategories<Row extends { id: string; name: string }>(
  words: readonly string[],
  categories: readonly Row[],
): { matched: Row[]; unmatched: string[] } {
  const byKey = new Map<string, Row[]>();
  for (const category of categories) {
    const key = wordKey(category.name);
    if (key === '') continue;
    const list = byKey.get(key);
    if (list) list.push(category);
    else byKey.set(key, [category]);
  }
  const matched: Row[] = [];
  const unmatched: string[] = [];
  const taken = new Set<string>();
  for (const word of words) {
    const found = byKey.get(wordKey(word));
    if (!found) {
      unmatched.push(word);
      continue;
    }
    for (const category of found) {
      if (taken.has(category.id)) continue;
      taken.add(category.id);
      matched.push(category);
    }
  }
  return { matched, unmatched };
}
