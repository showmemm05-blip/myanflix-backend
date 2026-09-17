import { createHash } from 'node:crypto';
import {
  StreamKeyNotSignable,
  quantizedExpiry,
  scopeForKey,
  signScope,
} from './stream-signature';

const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
const SUBTITLE_ID = '0d9d3b1e-6c1f-4f6e-9a0b-2b7f1c8e5d21';
const AUDIO_ID = '3c8a1d90-77bd-4f2e-9c31-8ad4b6e05f12';
const USER_ID = '5a2c7e10-4b93-4d6f-8e21-9f0a1b2c3d4e';
const BOOK_ID = '11111111-2222-4333-8444-555555555555';
const EDITION_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CHAPTER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

/**
 * The token format is dictated by nginx's secure_link_md5 (see the template
 * in cacheserver/), so the reference here is an independent computation, not
 * a call back into the module under test.
 */
describe('signScope', () => {
  it('is base64url(md5("<expires> <scope> <secret>")) without padding', () => {
    const scope = `videos/${MOVIE_ID}/hls`;
    const expires = 1_800_000_000;
    const secret = 'a-32-byte-or-longer-shared-secret-value-for-tests';

    const expected = createHash('md5')
      .update(`${expires} ${scope} ${secret}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(signScope(scope, expires, secret)).toBe(expected);
  });

  it('never emits +, / or = (the URL-safe alphabet nginx decodes)', () => {
    // Enough distinct inputs that a plain base64 digest would almost surely
    // have produced at least one of the three characters somewhere.
    for (let expires = 1_700_000_000; expires < 1_700_000_400; expires += 1) {
      const sig = signScope(`subtitles/${SUBTITLE_ID}`, expires, 'secret');
      expect(sig).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it('changes with every input — the secret included', () => {
    const base = signScope('videos/x/hls', 1, 'secret-a');
    expect(signScope('videos/x/hls', 1, 'secret-b')).not.toBe(base);
    expect(signScope('videos/y/hls', 1, 'secret-a')).not.toBe(base);
    expect(signScope('videos/x/hls', 2, 'secret-a')).not.toBe(base);
  });
});

describe('scopeForKey', () => {
  it('maps every HLS object of a title to its videos/<id>/hls scope', () => {
    const scope = `videos/${MOVIE_ID}/hls`;
    for (const key of [
      `videos/${MOVIE_ID}/hls/master.m3u8`,
      `videos/${MOVIE_ID}/hls/720p/index.m3u8`,
      `videos/${MOVIE_ID}/hls/720p/segment_000.ts`,
      `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`,
      `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`,
    ]) {
      expect(scopeForKey(key)).toBe(scope);
    }
  });

  it('maps every HLS object of an audio release to its audio/<id>/hls scope', () => {
    // Reserved: nothing writes audio/ yet, but the arm ships with the rest of
    // the taxonomy so a music or audiobook feature needs no signing change.
    const scope = `audio/${AUDIO_ID}/hls`;
    for (const key of [
      `audio/${AUDIO_ID}/hls/master.m3u8`,
      `audio/${AUDIO_ID}/hls/128k/index.m3u8`,
      `audio/${AUDIO_ID}/hls/128k/segment_000.ts`,
    ]) {
      expect(scopeForKey(key)).toBe(scope);
    }
  });

  it('maps a subtitle source file to its owning movie’s scope', () => {
    // Sources are keyed by the MOVIE, whatever wrote them: a single upload
    // names the file after the subtitle id, a bulk bundle keeps the
    // operator's own filename, and one scope covers both.
    expect(scopeForKey(`subtitles/${MOVIE_ID}/${SUBTITLE_ID}.srt`)).toBe(
      `subtitles/${MOVIE_ID}`,
    );
    expect(scopeForKey(`subtitles/${MOVIE_ID}/English.SDH.srt`)).toBe(
      `subtitles/${MOVIE_ID}`,
    );
  });

  it('no longer signs the retired videos/<movieId>/subtitles/* shape', () => {
    // Nothing can land there any more — the bulk flow routes `subtitles/`
    // paths to the movie-keyed namespace above — so the videos arm lost its
    // (?:hls|subtitles) alternation on both sides of the contract.
    expect(() =>
      scopeForKey(`videos/${MOVIE_ID}/subtitles/english.srt`),
    ).toThrow(StreamKeyNotSignable);
  });

  it('maps a converted book page to its chapter pages scope', () => {
    expect(
      scopeForKey(
        `books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}/pages/page-002.webp`,
      ),
    ).toBe(`books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}/pages`);
  });

  it('throws for everything a player never fetches', () => {
    for (const key of [
      // images/ is public BY KEY — giving it a scope would be the bug, not
      // the fix: a poster behind a token would 403 for every guest.
      'images/x.jpg',
      'images/movie/6f1c2e3a-9b4d-4d21-9f0a-2c7b8e5d1a44.webp',
      `images/user/${USER_ID}/1757606400000.webp`,
      `videos/${MOVIE_ID}/original.mp4`,
      `audio/${AUDIO_ID}/original.flac`,
      // Source PDFs and any other document: backend-only, credentialed S3.
      `documents/books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}/original.pdf`,
      `documents/legal/${USER_ID}/terms-2026-09.pdf`,
      // Object-store staging — reserved, and never served to anyone.
      `temp/${SUBTITLE_ID}/part-source.bin`,
      // Only the pages of a REAL chapter are signable — short ids are not.
      'books/b/e/c/pages/page-001.webp',
      'videos/33e6e224/hls/master.m3u8',
      'audio/33e6e224/hls/master.m3u8',
      'subtitles/33e6e224/english.srt',
    ]) {
      expect(() => scopeForKey(key)).toThrow(StreamKeyNotSignable);
    }
  });

  it('throws for paths rather than keys, and for traversal', () => {
    for (const key of [
      `/storage/videos/${MOVIE_ID}/hls/master.m3u8`,
      `/videos/${MOVIE_ID}/hls/master.m3u8`,
      '../etc',
      `videos/${MOVIE_ID}/hls/../original.mp4`,
      `subtitles/${MOVIE_ID}/../${MOVIE_ID}/x.srt`,
      `videos/${MOVIE_ID}/hls/`,
      `videos/${MOVIE_ID}/hls`,
      `subtitles/${MOVIE_ID}`,
      '',
    ]) {
      expect(() => scopeForKey(key)).toThrow(StreamKeyNotSignable);
    }
  });
});

describe('quantizedExpiry', () => {
  const TTL = 43_200;

  it('is identical for two calls inside one hour bucket', () => {
    const hourStart = 1_800_000_000 - (1_800_000_000 % 3600);
    expect(quantizedExpiry(hourStart + 1, TTL)).toBe(
      quantizedExpiry(hourStart + 3599, TTL),
    );
  });

  it('is at least ttl - step in the future, and never more than ttl', () => {
    for (const now of [1_800_000_000, 1_800_003_599, 1_800_003_600]) {
      const expires = quantizedExpiry(now, TTL);
      expect(expires - now).toBeGreaterThan(TTL - 3600);
      expect(expires - now).toBeLessThanOrEqual(TTL);
    }
  });

  it('honours a custom step', () => {
    expect(quantizedExpiry(1_000, 600, 100)).toBe(1_600);
    expect(quantizedExpiry(1_099, 600, 100)).toBe(1_600);
    expect(quantizedExpiry(1_100, 600, 100)).toBe(1_700);
  });
});
