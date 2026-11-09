import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOUSE_GENRES, HOUSE_LANGUAGES, HOUSE_TYPES } from './house-words';

/**
 * The backend writes a title's genre, language and type by itself when it
 * fills details from TMDB, so every word it can write must be one the
 * admin's forms offer — a word the admin does not know shows up as an
 * unknown value in the edit form and in the catalogue's filters. The lists
 * live twice (backend/src/tmdb/house-words.ts and
 * admin/lib/constants/movie-options.ts); this spec is what keeps them one.
 *
 * As with media-layout-doc.spec.ts, the backend can be checked out or built
 * without the rest of the monorepo beside it (the Docker build context is
 * backend/ only), so an ABSENT admin file skips with a clear message — a
 * missing file proves nothing about drift. A file that is present and
 * differs always fails.
 */
const ADMIN_OPTIONS_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'admin',
  'lib',
  'constants',
  'movie-options.ts',
);

/** The string literals of `export const <name> = [ ... ]` in the admin's file, in order. */
function adminList(source: string, name: string): string[] {
  const declaration = new RegExp(
    `export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`,
  ).exec(source);
  if (!declaration) {
    throw new Error(`admin movie-options.ts no longer declares ${name}`);
  }
  return [...declaration[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2],
  );
}

describe('the house words', () => {
  it('are sixteen genres, nine languages and eight types, each listed once', () => {
    expect(HOUSE_GENRES).toHaveLength(16);
    expect(HOUSE_LANGUAGES).toHaveLength(9);
    expect(HOUSE_TYPES).toHaveLength(8);
    for (const list of [HOUSE_GENRES, HOUSE_LANGUAGES, HOUSE_TYPES]) {
      expect(new Set<string>(list).size).toBe(list.length);
      for (const word of list) expect(word).toBe(word.trim());
    }
  });

  it('carry Thai as a language and as a type (added with the TMDB details)', () => {
    expect(HOUSE_LANGUAGES).toContain('Thai');
    expect(HOUSE_TYPES).toContain('Thai');
  });

  describe('match admin/lib/constants/movie-options.ts', () => {
    if (!existsSync(ADMIN_OPTIONS_PATH)) {
      it.skip(`SKIPPED — ${ADMIN_OPTIONS_PATH} is not present (admin/ lives outside the backend deploy unit; nothing to compare against)`, () => {
        // Intentionally empty: recorded as a skip so the reason shows up in
        // the run output instead of silently passing.
      });
      return;
    }

    const source = readFileSync(ADMIN_OPTIONS_PATH, 'utf8');

    it('GENRE_OPTIONS = HOUSE_GENRES, in the same order', () => {
      expect(adminList(source, 'GENRE_OPTIONS')).toEqual([...HOUSE_GENRES]);
    });

    it('LANGUAGES = HOUSE_LANGUAGES, in the same order', () => {
      expect(adminList(source, 'LANGUAGES')).toEqual([...HOUSE_LANGUAGES]);
    });

    it('MEDIA_TYPES = HOUSE_TYPES, in the same order', () => {
      expect(adminList(source, 'MEDIA_TYPES')).toEqual([...HOUSE_TYPES]);
    });
  });

  describe('the reader of the admin file (so a change of its layout cannot pass silently)', () => {
    it('reads a list written on one line or on several, with either quote', () => {
      const source = [
        'export const ONE = ["A", "B-C"];',
        "export const TWO: readonly string[] = [\n  'x',\n  'y z',\n];",
        'export const THREE = ["only"] as const;',
      ].join('\n');

      expect(adminList(source, 'ONE')).toEqual(['A', 'B-C']);
      expect(adminList(source, 'TWO')).toEqual(['x', 'y z']);
      expect(adminList(source, 'THREE')).toEqual(['only']);
    });

    it('fails loudly when a list is gone or renamed', () => {
      expect(() => adminList('export const OTHER = [];', 'LANGUAGES')).toThrow(
        /no longer declares LANGUAGES/,
      );
      // A longer name is another list.
      expect(() =>
        adminList('export const LANGUAGES_OLD = ["x"];', 'LANGUAGES'),
      ).toThrow(/no longer declares LANGUAGES/);
    });
  });
});
