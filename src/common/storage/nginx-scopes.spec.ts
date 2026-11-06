import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { NGINX_SCOPE_ALTERNATION } from './media-taxonomy';

/**
 * The cache server's signed-media contract in one assertion.
 *
 * The `(?<scope>...)` alternation appears TWICE in the nginx template — once
 * in the short-TTL playlist/VTT location and once in the long-TTL
 * everything-else location — and those two copies plus this registry must be
 * the same string. Editing one location and forgetting the other does not
 * fail loudly: playlists keep working while segments 403, or the reverse,
 * which looks like flaky playback rather than a config bug. That is exactly
 * the failure this test exists to turn into a red build.
 *
 * The backend repo can be checked out on its own, without the cacheserver
 * tree beside it, so a missing template SKIPS with a clear message rather
 * than failing — an absent file proves nothing about drift.
 */
const TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'cacheserver',
  'nginx',
  'templates',
  'default.conf.template',
);

const templateExists = existsSync(TEMPLATE_PATH);

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('nginx signed-scope alternation', () => {
  if (!templateExists) {
    it.skip(`SKIPPED — ${TEMPLATE_PATH} is not present (cacheserver/ is a separate deploy unit; nothing to compare against)`, () => {
      // Intentionally empty: recorded as a skip so the reason is visible in
      // the run output instead of silently passing.
    });
    return;
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8');

  it('appears in the template exactly twice', () => {
    const occurrences = countOccurrences(template, NGINX_SCOPE_ALTERNATION);
    expect({
      alternation: NGINX_SCOPE_ALTERNATION,
      occurrences,
    }).toEqual({ alternation: NGINX_SCOPE_ALTERNATION, occurrences: 2 });
  });

  it('opens every `(?<scope>` capture with the generated string', () => {
    // Counting alone would pass if someone added a THIRD location spelling
    // the scope differently, so each capture is checked where it starts: the
    // generated alternation must be followed immediately by `)/`.
    const opener = '(?<scope>';
    const expected = `${opener}${NGINX_SCOPE_ALTERNATION})/`;
    const openings: number[] = [];
    for (let at = template.indexOf(opener); at !== -1; ) {
      openings.push(at);
      at = template.indexOf(opener, at + opener.length);
    }

    expect(openings).toHaveLength(2);
    for (const at of openings) {
      expect(template.slice(at, at + expected.length)).toBe(expected);
    }
  });
});

/**
 * The cache's token-less reach (SEC-022): which paths a request WITHOUT an
 * /s/ token may forward to the storage origin at all. jest has no nginx, so
 * the two `map`s and the `location` guards are read out of the template and
 * evaluated the way nginx evaluates them — regex arms in file order, first
 * match wins, `default` otherwise — against the paths that matter. The
 * wiring is asserted too (a map nobody consults proves nothing), and the
 * rendered file is additionally proven with `nginx -t` plus a curl matrix in
 * a throwaway container (cacheserver/README.md, "Changing nginx.conf or the
 * template").
 */
describe('nginx token-less reach (SEC-022)', () => {
  if (!templateExists) {
    it.skip(`SKIPPED — ${TEMPLATE_PATH} is not present (cacheserver/ is a separate deploy unit; nothing to compare against)`, () => {
      // Intentionally empty — same reason as above.
    });
    return;
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  // Comments mention every directive too; only the directives count.
  const lines = template
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);

  interface MapArm {
    /** null = the `default` arm */
    pattern: RegExp | null;
    value: string;
  }

  /** The arms of `map <key> $variable { ... }`, in file order. */
  function readMap(variable: string): MapArm[] {
    const start = lines.findIndex(
      (line) => line.startsWith('map ') && line.endsWith(`${variable} {`),
    );
    expect(start).toBeGreaterThan(-1);
    const arms: MapArm[] = [];
    for (let at = start + 1; lines[at] !== '}'; at += 1) {
      const arm = /^(~(\S+)|default)\s+(\S+);$/.exec(lines[at]);
      expect({ line: lines[at], parsed: arm !== null }).toEqual({
        line: lines[at],
        parsed: true,
      });
      arms.push({
        pattern: arm![2] === undefined ? null : new RegExp(arm![2]),
        value: arm![3],
      });
    }
    return arms;
  }

  const evaluate = (arms: MapArm[], input: string): string =>
    arms.find((arm) => arm.pattern === null || arm.pattern.test(input))!
      .value;

  /** The directives inside `<opener> ... }`, nested `if { }` blocks included. */
  function blockBody(opener: string): string[] {
    const at = lines.indexOf(opener);
    expect({ opener, found: at > -1 }).toEqual({ opener, found: true });
    const body: string[] = [];
    let depth = 1;
    for (let i = at + 1; depth > 0; i += 1) {
      depth += (lines[i].match(/{/g) ?? []).length;
      depth -= (lines[i].match(/}/g) ?? []).length;
      if (depth > 0) body.push(lines[i]);
    }
    return body;
  }

  const outsideCacheScope = readMap('$outside_cache_scope');
  const denyUnsignedMedia = readMap('$deny_unsigned_media');

  /**
   * What the cache answers a token-less request: `^~ /minio/` is a prefix
   * location and beats the regex ones; then the two `if`s of the unsigned
   * locations in their order. nginx matches on the normalised $uri
   * (percent-decoded, `..` resolved), hence posix.normalize.
   */
  function unsignedRequest(
    mode: 'allow' | 'deny',
    rawUri: string,
  ): 'forbidden' | 'origin' {
    const uri = posix.normalize(decodeURIComponent(rawUri));
    if (uri.startsWith('/minio/')) return 'forbidden';
    if (evaluate(outsideCacheScope, uri) === '1') return 'forbidden';
    if (evaluate(denyUnsignedMedia, `${mode}:${uri}`) === '1') {
      return 'forbidden';
    }
    return 'origin';
  }

  it('answers /minio/ with 403 in a prefix location that beats the regex ones and never proxies', () => {
    expect(blockBody('location ^~ /minio/ {')).toEqual(['return 403;']);
  });

  it.each(['location ~* \\.(m3u8|vtt)$ {', 'location / {'])(
    'refuses outside-scope and denied-unsigned paths before proxying in `%s`',
    (opener) => {
      const body = blockBody(opener);
      const outside = body.indexOf('if ($outside_cache_scope) { return 403; }');
      const denied = body.indexOf('if ($deny_unsigned_media) { return 403; }');
      const proxied = body.findIndex((line) => line.startsWith('proxy_pass '));
      expect(outside).toBeGreaterThan(-1);
      expect(denied).toBeGreaterThan(outside);
      expect(proxied).toBeGreaterThan(denied);
    },
  );

  const ID = '731798fd-ca56-4650-86b6-32e96169c25e';

  it.each([
    // MinIO's own endpoints, the bucket root, other buckets, unknown folders:
    // 403 at the cache in BOTH modes — these never reached MinIO legitimately.
    ['/minio/health/live', 'forbidden', 'forbidden'],
    ['/minio/admin/v3/info', 'forbidden', 'forbidden'],
    ['/minio/x.m3u8', 'forbidden', 'forbidden'],
    ['/', 'forbidden', 'forbidden'],
    ['/movies/', 'forbidden', 'forbidden'],
    ['/other-bucket/x.jpg', 'forbidden', 'forbidden'],
    ['/other-bucket/x.m3u8', 'forbidden', 'forbidden'],
    ['/movies/unknown/x.bin', 'forbidden', 'forbidden'],
    [`/movies/images/../videos/${ID}/original.mp4`, 'forbidden', 'forbidden'],
    ['/movies/images/..%2F..%2Fminio/health/live', 'forbidden', 'forbidden'],
    // Images: public by key, both modes.
    [`/movies/images/movie/${ID}.jpg`, 'origin', 'origin'],
    [`/movies/images/user/${ID}/1727500000000.png`, 'origin', 'origin'],
    // Token-less media: the legacy switch alone decides.
    [`/movies/videos/${ID}/hls/master.m3u8`, 'forbidden', 'origin'],
    [`/movies/videos/${ID}/hls/v-c6592c79/720p/segment_000.ts`, 'forbidden', 'origin'],
    [`/movies/audio/${ID}/hls/master.m3u8`, 'forbidden', 'origin'],
    [`/movies/books/${ID}/${ID}/${ID}/pages/page-001.webp`, 'forbidden', 'origin'],
    // Never servable token-less, whatever the switch says.
    [`/movies/videos/${ID}/original.mp4`, 'forbidden', 'forbidden'],
    [`/movies/audio/${ID}/original.m4a`, 'forbidden', 'forbidden'],
    [`/movies/subtitles/${ID}/${ID}.srt`, 'forbidden', 'forbidden'],
    [`/movies/documents/books/${ID}/${ID}/${ID}/original.pdf`, 'forbidden', 'forbidden'],
    [`/movies/temp/${ID}/part-source.bin`, 'forbidden', 'forbidden'],
    // A pre-roll ad is signed-only: no legacy arm ever opened ads/ token-less.
    [`/movies/ads/${ID}/v-c6592c79/video.mp4`, 'forbidden', 'forbidden'],
    [`/movies/temp/ads/${ID}/video.mp4`, 'forbidden', 'forbidden'],
  ] as const)('%s → deny: %s, allow: %s', (uri, inDeny, inAllow) => {
    expect({
      uri,
      deny: unsignedRequest('deny', uri),
      allow: unsignedRequest('allow', uri),
    }).toEqual({ uri, deny: inDeny, allow: inAllow });
  });
});
