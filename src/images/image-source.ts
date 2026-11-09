/**
 * Where a stored picture came from, read off its object key alone.
 *
 * A picture the backend fetched from TMDB (a poster, a backdrop, an actor
 * photo) is stored through the same ImageStoreService a staff upload uses,
 * in the same images/<purpose>/ folder — only its file name starts with
 * `tmdb-`. That name IS the mark: a staff upload is always a bare uuid, so
 * "not from TMDB" needs no flag that could fall out of step with the row,
 * and every TMDB picture can be listed by prefix (images/movie/tmdb-,
 * images/series/tmdb-, images/actor/tmdb-) the day TMDB's terms require
 * them gone.
 */

/** What a TMDB picture's file name starts with: images/<purpose>/tmdb-<uuid><ext>. */
export const TMDB_IMAGE_ID_PREFIX = 'tmdb-';

/** True for the object key of a picture that was fetched from TMDB. */
export function isTmdbImageKey(key: string | null | undefined): boolean {
  if (!key || !key.startsWith('images/')) return false;
  const fileName = key.slice(key.lastIndexOf('/') + 1);
  return fileName.startsWith(TMDB_IMAGE_ID_PREFIX);
}

/**
 * The TMDB pictures a save left with nothing pointing at them: for each
 * image field, the OLD picture's key when it came from TMDB and the row now
 * shows something else there (staff uploaded their own, the field was
 * cleared, a refill brought a new one). The caller deletes them, best
 * effort, after the row is written. A staff picture is never returned —
 * only TMDB ones are cleaned up this way.
 *
 * Compared by object key, not by URL text: the same picture saved back
 * under another host (the admin echoes re-hosted URLs) is not a change.
 * `keyOf` is MinioService.keyFromPublicUrl.
 */
export function replacedTmdbImageKeys<Field extends string>(
  before: Partial<Record<Field, string | null>>,
  after: Partial<Record<Field, string | null>>,
  fields: readonly Field[],
  keyOf: (url: string) => string | null,
): string[] {
  const replaced = new Set<string>();
  for (const field of fields) {
    const oldUrl = before[field];
    if (!oldUrl || oldUrl === after[field]) continue;
    const oldKey = keyOf(oldUrl);
    if (oldKey && isTmdbImageKey(oldKey)) replaced.add(oldKey);
  }
  if (replaced.size === 0) return [];
  // Still shown by the row (the same object under another host, or moved
  // to another of its image fields): not orphaned.
  for (const field of fields) {
    const url = after[field];
    const key = url ? keyOf(url) : null;
    if (key) replaced.delete(key);
  }
  return [...replaced];
}
