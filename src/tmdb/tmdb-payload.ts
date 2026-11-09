/**
 * Reads TMDB's JSON answers into the few fields this module uses.
 *
 * TMDB's documentation leaves several things open (TMDB-API-NOTES.md marks
 * them "test"), so every reader here is tolerant on purpose: a field of the
 * wrong type is read as missing, a row without an id or a name is dropped,
 * and only an answer that is not the expected KIND of thing at all (not an
 * object, no `results` list) is refused — the client turns that null into
 * `bad_response`. Nothing downstream ever touches raw TMDB JSON.
 */

/** One row of /search/movie or /search/tv, in one shape for both. */
export interface TmdbSearchRow {
  id: number;
  /** `title` of a movie, `name` of a show. */
  title: string;
  /** `original_title` / `original_name`; '' when TMDB sent none. */
  originalTitle: string;
  /** `release_date` / `first_air_date` ("2010-07-16"); '' when unknown. */
  releaseDate: string;
  overview: string;
  posterPath: string | null;
  originalLanguage: string | null;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

/** One person of a cast list. */
export interface TmdbCastRow {
  /** TMDB's person id. */
  id: number;
  name: string;
  /** The role(s) played: one for a film, one per role for a show's aggregate credits. */
  characters: string[];
  /** TMDB's billing order; a row without one sorts last. */
  order: number;
  profilePath: string | null;
}

export interface TmdbCrewRow {
  name: string;
  job: string;
}

/** One US release of a film: its certification ("PG-13", often '') and release type (3 = theatrical). */
export interface TmdbCertification {
  certification: string;
  type: number | null;
}

/** A film's details with its credits and US certifications already merged in. */
export interface TmdbMovieDetails {
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  releaseDate: string;
  /** Minutes; null when TMDB has none. */
  runtime: number | null;
  genres: TmdbGenre[];
  originalLanguage: string | null;
  /** ISO 3166-1 codes, TMDB's order. */
  productionCountries: string[];
  posterPath: string | null;
  backdropPath: string | null;
  cast: TmdbCastRow[];
  crew: TmdbCrewRow[];
  usCertifications: TmdbCertification[];
}

/** A show's details with its cast already merged in. */
export interface TmdbTvDetails {
  id: number;
  /** TMDB's `name`. */
  title: string;
  originalTitle: string;
  overview: string;
  firstAirDate: string;
  genres: TmdbGenre[];
  originalLanguage: string | null;
  /** ISO 3166-1 codes, TMDB's order. */
  originCountries: string[];
  posterPath: string | null;
  backdropPath: string | null;
  cast: TmdbCastRow[];
}

/** Only page 1 of a search is ever read (PLAN.md 2.4): at most this many rows. */
export const TMDB_SEARCH_ROWS_MAX = 20;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A positive whole number (a TMDB id), or null. */
function asId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The rows of a search answer, or null when the answer has no `results` list. */
export function readSearchRows(
  raw: unknown,
  kind: 'movie' | 'tv',
): TmdbSearchRow[] | null {
  const results = asList(asObject(raw)?.results);
  if (!results) return null;
  const rows: TmdbSearchRow[] = [];
  for (const entry of results.slice(0, TMDB_SEARCH_ROWS_MAX)) {
    const item = asObject(entry);
    const id = asId(item?.id);
    if (!item || id === null) continue;
    const title = asText(kind === 'movie' ? item.title : item.name).trim();
    if (title === '') continue;
    rows.push({
      id,
      title,
      originalTitle: asText(
        kind === 'movie' ? item.original_title : item.original_name,
      ).trim(),
      releaseDate: asText(
        kind === 'movie' ? item.release_date : item.first_air_date,
      ),
      overview: asText(item.overview),
      posterPath: asTextOrNull(item.poster_path),
      originalLanguage: asTextOrNull(item.original_language),
    });
  }
  return rows;
}

function readGenres(value: unknown): TmdbGenre[] {
  const genres: TmdbGenre[] = [];
  for (const entry of asList(value) ?? []) {
    const item = asObject(entry);
    const id = asId(item?.id);
    // An id TMDB did not send still leaves the name to map by.
    const name = asText(item?.name).trim();
    if (id === null && name === '') continue;
    genres.push({ id: id ?? 0, name });
  }
  return genres;
}

function readCountryCodes(value: unknown): string[] {
  const codes: string[] = [];
  for (const entry of asList(value) ?? []) {
    // production_countries is a list of objects, origin_country a list of codes.
    const code =
      typeof entry === 'string' ? entry : asText(asObject(entry)?.iso_3166_1);
    if (code.trim() !== '') codes.push(code.trim().toUpperCase());
  }
  return codes;
}

function readCastRow(entry: unknown): TmdbCastRow | null {
  const item = asObject(entry);
  const id = asId(item?.id);
  if (!item || id === null) return null;
  // A film's credit carries one `character`; a show's aggregate credit
  // carries `roles[]`, one per role the person played across the seasons.
  const roles = asList(item.roles);
  const characters = roles
    ? roles.map((role) => asText(asObject(role)?.character))
    : [asText(item.character)];
  return {
    id,
    name: asText(item.name),
    characters,
    order: asNumberOrNull(item.order) ?? Number.MAX_SAFE_INTEGER,
    profilePath: asTextOrNull(item.profile_path),
  };
}

/** A credits block (`cast` + `crew`), or null when it is not there at all. */
export function readCredits(
  raw: unknown,
): { cast: TmdbCastRow[]; crew: TmdbCrewRow[] } | null {
  const block = asObject(raw);
  const castList = asList(block?.cast);
  if (!block || !castList) return null;
  const cast: TmdbCastRow[] = [];
  for (const entry of castList) {
    const row = readCastRow(entry);
    if (row) cast.push(row);
  }
  const crew: TmdbCrewRow[] = [];
  for (const entry of asList(block.crew) ?? []) {
    const item = asObject(entry);
    const name = asText(item?.name).trim();
    if (name !== '') crew.push({ name, job: asText(item?.job) });
  }
  return { cast, crew };
}

/** The US entries of a release_dates block, or null when the block is not there at all. */
export function readUsCertifications(raw: unknown): TmdbCertification[] | null {
  const results = asList(asObject(raw)?.results);
  if (!results) return null;
  const certifications: TmdbCertification[] = [];
  for (const entry of results) {
    const country = asObject(entry);
    if (asText(country?.iso_3166_1).toUpperCase() !== 'US') continue;
    for (const release of asList(country?.release_dates) ?? []) {
      const item = asObject(release);
      certifications.push({
        certification: asText(item?.certification),
        type: asNumberOrNull(item?.type),
      });
    }
  }
  return certifications;
}

/** A film's own fields, without credits and certifications. Null when the answer is not a film. */
export function readMovieCore(
  raw: unknown,
): Omit<TmdbMovieDetails, 'cast' | 'crew' | 'usCertifications'> | null {
  const item = asObject(raw);
  const id = asId(item?.id);
  if (!item || id === null) return null;
  return {
    id,
    title: asText(item.title),
    originalTitle: asText(item.original_title),
    overview: asText(item.overview),
    releaseDate: asText(item.release_date),
    runtime: asNumberOrNull(item.runtime),
    genres: readGenres(item.genres),
    originalLanguage: asTextOrNull(item.original_language),
    productionCountries: readCountryCodes(item.production_countries),
    posterPath: asTextOrNull(item.poster_path),
    backdropPath: asTextOrNull(item.backdrop_path),
  };
}

/** A show's own fields, without its cast. Null when the answer is not a show. */
export function readTvCore(raw: unknown): Omit<TmdbTvDetails, 'cast'> | null {
  const item = asObject(raw);
  const id = asId(item?.id);
  if (!item || id === null) return null;
  return {
    id,
    title: asText(item.name),
    originalTitle: asText(item.original_name),
    overview: asText(item.overview),
    firstAirDate: asText(item.first_air_date),
    genres: readGenres(item.genres),
    originalLanguage: asTextOrNull(item.original_language),
    originCountries: readCountryCodes(item.origin_country),
    posterPath: asTextOrNull(item.poster_path),
    backdropPath: asTextOrNull(item.backdrop_path),
  };
}

/** The named block of a details answer that was fetched with append_to_response. */
export function appendedBlock(raw: unknown, name: string): unknown {
  return asObject(raw)?.[name];
}
