import { createHash } from 'node:crypto';

import { STREAM_SCOPE_PATTERNS } from './media-taxonomy';

/**
 * Pure helpers behind MinioService.signedPlaybackUrl() — no Nest, no I/O.
 *
 * A playback link carries a token IN ITS PATH:
 *
 *   /s/<expires>/<signature>/movies/<objectKey>
 *
 * The cache server (cacheserver/nginx/templates/default.conf.template)
 * checks it with nginx's secure_link module before proxying to storage, so
 * this file and that template are two halves of one contract:
 *
 *   signature = base64url( md5( "<expires> <scope> <secret>" ) )
 *
 * `scope` is the PREFIX the token unlocks, not the object itself, because a
 * playlist's segments are resolved relative to the playlist URL: signing one
 * `videos/<id>/hls` scope covers master.m3u8, every rendition playlist, every
 * segment and every published subtitle of that title with one token.
 *
 * The scopes themselves are NOT written here. They come from MEDIA_CLASSES in
 * media-taxonomy.ts, which also generates the nginx alternation, because the
 * two used to be hand-kept copies of one string across three places and a
 * mismatch does not fail loudly — it breaks playlists but not segments, or
 * the reverse, which reads as flaky playback rather than a config bug.
 */

/** Thrown for a key that is not part of any signable scope. */
export class StreamKeyNotSignable extends Error {
  constructor(objectKey: string) {
    super(`Object key is not part of a signable stream scope: ${objectKey}`);
    this.name = 'StreamKeyNotSignable';
  }
}

/**
 * The four signable scopes, generated from the media taxonomy and identical
 * by construction to the `(?<scope>...)` alternation in both signed locations
 * of the nginx template:
 *
 *   videos/<movieId>/hls              — one token per title, covering
 *                                       master.m3u8, every rendition, every
 *                                       segment and every published subtitle
 *   audio/<audioId>/hls               — reserved; same shape, signs nothing
 *                                       until an audio catalogue exists
 *   subtitles/<movieId>               — the uploaded subtitle SOURCES of one
 *                                       title, so /stream's subtitles[].url
 *                                       stays a working link
 *   books/<b>/<e>/<c>/pages           — one token per chapter of a reader
 *
 * The trailing `(.+)` each pattern carries must be a real path remainder: no
 * empty segment, no `.` / `..` hops (isCleanRemainder below).
 */
const SCOPES: readonly RegExp[] = STREAM_SCOPE_PATTERNS;

const isCleanRemainder = (rest: string): boolean =>
  rest
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/**
 * The scope prefix a key belongs to, e.g.
 * `videos/<id>/hls/720p/segment_000.ts` -> `videos/<id>/hls`.
 * Throws StreamKeyNotSignable for everything else — everything under images/
 * (posters and avatars are public by key and must stay so), video and audio
 * originals, everything under documents/ and temp/, and anything with a
 * leading slash or a `..` segment. The subtitle-source scope exists only so
 * the stream response's existing `subtitles[].url` field can stay signed
 * rather than disappear.
 */
export function scopeForKey(objectKey: string): string {
  for (const pattern of SCOPES) {
    const match = pattern.exec(objectKey);
    if (match && isCleanRemainder(match[2])) return match[1];
  }
  throw new StreamKeyNotSignable(objectKey);
}

/**
 * Unix-seconds expiry rounded DOWN to a `step` boundary before the TTL is
 * added, so every link minted within one step (an hour by default) is
 * byte-identical: a client that refetches the stream mid-session gets the
 * same URL back and never rebuilds its player over a token change. The
 * effective lifetime is therefore between `ttl - step` and `ttl`.
 */
export function quantizedExpiry(
  nowSeconds: number,
  ttlSeconds: number,
  stepSeconds = 3600,
): number {
  return Math.floor(nowSeconds / stepSeconds) * stepSeconds + ttlSeconds;
}

/**
 * The token itself, in the exact form nginx's `secure_link_md5` expects:
 * MD5 over `"<expires> <scope> <secret>"`, base64 with `+`/`/` swapped for
 * `-`/`_` and the `=` padding dropped.
 */
export function signScope(
  scope: string,
  expires: number,
  secret: string,
): string {
  return createHash('md5')
    .update(`${expires} ${scope} ${secret}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
