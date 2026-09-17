import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
