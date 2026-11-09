/**
 * Where a TMDB picture lives: the one host, the path rule and the sizes
 * (PLAN.md 2.11 of docs/movie-details-tmdb-2026-11-06). Pure — the download
 * itself is TmdbImageFetcher.
 */

/** The one host a TMDB picture is ever downloaded from. */
export const TMDB_IMAGE_HOST = 'image.tmdb.org';
export const TMDB_IMAGE_BASE = `https://${TMDB_IMAGE_HOST}/t/p`;

/**
 * The only picture paths accepted: one path segment of plain characters
 * with an image extension, exactly what TMDB hands out
 * (`/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg`). Anything else — a second segment,
 * a `..`, a query, a full URL — is not a TMDB picture path.
 */
export const TMDB_IMAGE_PATH_PATTERN =
  /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/;

export type TmdbImageKind = 'poster' | 'backdrop' | 'profile';

/**
 * The sizes asked for, in order. A poster or backdrop is taken at
 * `original` and only when that is over the byte cap at the next size down;
 * an actor's photo is small on every screen, so it is taken at h632 only.
 */
export const TMDB_IMAGE_SIZES: Record<TmdbImageKind, readonly string[]> = {
  poster: ['original', 'w780'],
  backdrop: ['original', 'w1280'],
  profile: ['h632'],
};

/** The sizes the admin's review shows a candidate at — loaded by the browser straight from TMDB, staff only. */
export const TMDB_PREVIEW_SIZES = {
  /** A row of the pick-a-match list. */
  searchPoster: 'w185',
  /** The proposed poster of a review. */
  poster: 'w342',
  /** The proposed banner of a review. */
  backdrop: 'w780',
} as const;

export function isTmdbImagePath(
  path: string | null | undefined,
): path is string {
  return typeof path === 'string' && TMDB_IMAGE_PATH_PATTERN.test(path);
}

/**
 * The address of a TMDB picture at one size, or null for a path that is
 * not one. Built here, on the server, from the fixed base and a checked
 * path — a picture address is never taken from a browser.
 */
export function tmdbImageUrl(
  size: string,
  path: string | null | undefined,
): string | null {
  if (!isTmdbImagePath(path) || !/^(original|[wh]\d{2,4})$/.test(size)) {
    return null;
  }
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}
