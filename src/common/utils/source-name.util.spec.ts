import { SOURCE_NAME_QUERY_MAX, parseSourceName } from './source-name.util';

/** Every case below is read as if today were in 2026. */
const NOW = 2026;

/**
 * The table of docs/movie-details-tmdb-2026-11-06/PLAN.md 2.3, row for row:
 * folder name, the name to search for, the release year.
 */
const PLAN_TABLE: Array<[string, string, number | null]> = [
  ['Inception.2010.1080p.BluRay.x264-YIFY', 'Inception', 2010],
  ['Inception (2010)', 'Inception', 2010],
  ['The_Dark_Knight_2008_720p_BrRip', 'The Dark Knight', 2008],
  ['Spider-Man.No.Way.Home.2021.2160p.WEB-DL', 'Spider-Man No Way Home', 2021],
  ['Parasite [2019] [Korean] 1080p', 'Parasite', 2019],
  ['[YTS] Oldboy 2003', 'Oldboy', 2003],
  ['2012.2009.1080p.BluRay', '2012', 2009],
  ['1917.2019.1080p', '1917', 2019],
  ['2001.A.Space.Odyssey.1968', '2001 A Space Odyssey', 1968],
  ['Blade.Runner.2049.2017.1080p', 'Blade Runner 2049', 2017],
  ['Blade Runner 2049', 'Blade Runner 2049', null],
  ['Wonder.Woman.1984.2020.WEBRip', 'Wonder Woman 1984', 2020],
  ['Wonder Woman 1984', 'Wonder Woman', 1984],
  ['Movie.720p.2010.x264', 'Movie', 2010],
  ['Inception.Extended.2010', 'Inception', 2010],
  ['Avengers Endgame 1080p', 'Avengers Endgame', null],
  ['the_great_escape', 'the great escape', null],
  ['2012', '2012', null],
  ['1080p', '1080p', null],
];

describe('parseSourceName', () => {
  it.each(PLAN_TABLE)('%s → "%s" (%s)', (name, query, year) => {
    expect(parseSourceName(name, NOW)).toMatchObject({ query, year });
  });

  describe('yearFollowsTitle — the year may be part of the name', () => {
    it.each([
      // The year stood right after the name: the lookup also tries
      // "Wonder Woman 1984" as a name.
      ['Wonder Woman 1984', true],
      ['Inception.2010.1080p.BluRay.x264-YIFY', true],
      ['2012.2009.1080p.BluRay', true],
      // An edition word is dropped AFTER the cut, so the year still counts
      // as having followed the name.
      ['Inception.Extended.2010', true],
      // A release word stood between the name and the year.
      ['Movie.720p.2010.x264', false],
      // No year at all.
      ['Blade Runner 2049', false],
      ['Avengers Endgame 1080p', false],
    ])('%s → %s', (name, expected) => {
      expect(parseSourceName(name, NOW).yearFollowsTitle).toBe(expected);
    });
  });

  describe('step 2 — bracket groups', () => {
    it.each([
      ['Inception [2010]', 'Inception', 2010],
      ['Inception {2010}', 'Inception', 2010],
      ['Inception ( 2010 )', 'Inception', 2010],
      ['Inception(2010)1080p', 'Inception', 2010],
    ])('reads a bracketed year: %s', (name, query, year) => {
      expect(parseSourceName(name, NOW)).toMatchObject({ query, year });
    });

    it('drops every other group whole, whatever is inside', () => {
      expect(
        parseSourceName('Oldboy (Directors Cut) [1080p] {x265}', NOW),
      ).toMatchObject({ query: 'Oldboy', year: null });
    });

    it('drops a group inside a group', () => {
      expect(parseSourceName('[YTS (MX)] Oldboy (2003)', NOW)).toMatchObject({
        query: 'Oldboy',
        year: 2003,
      });
    });

    it('a bracketed number that is no film year is a tag, not a year', () => {
      expect(parseSourceName('Movie (1899)', NOW)).toMatchObject({
        query: 'Movie',
        year: null,
      });
      expect(parseSourceName('Movie (12345)', NOW)).toMatchObject({
        query: 'Movie',
        year: null,
      });
    });
  });

  describe('step 3 — separators', () => {
    it('reads a run of dots and underscores as one space', () => {
      expect(parseSourceName('The...Great__Escape._.1963', NOW)).toMatchObject({
        query: 'The Great Escape',
        year: 1963,
      });
    });

    it('a hyphen standing alone or at a word edge is a space; inside a word it stays', () => {
      expect(parseSourceName('Spider-Man - Far From Home', NOW).query).toBe(
        'Spider-Man Far From Home',
      );
      expect(parseSourceName('-Up- 2009', NOW)).toMatchObject({
        query: 'Up',
        year: 2009,
      });
      expect(parseSourceName('X-Men.2000.BluRay', NOW)).toMatchObject({
        query: 'X-Men',
        year: 2000,
      });
    });

    it('collapses any whitespace, tabs and no-break spaces included', () => {
      expect(parseSourceName('  The\tDark\u00a0 Knight  ', NOW).query).toBe(
        'The Dark Knight',
      );
    });
  });

  describe('step 5 — the year', () => {
    it('accepts 1900 up to next year and nothing outside', () => {
      expect(parseSourceName('Movie 1900', NOW).year).toBe(1900);
      expect(parseSourceName('Movie 2027', NOW).year).toBe(2027);
      expect(parseSourceName('Movie 1899', NOW)).toMatchObject({
        query: 'Movie 1899',
        year: null,
      });
      expect(parseSourceName('Movie 2028', NOW)).toMatchObject({
        query: 'Movie 2028',
        year: null,
      });
    });

    it('follows the current year it is given', () => {
      expect(parseSourceName('Blade Runner 2049', 2048)).toMatchObject({
        query: 'Blade Runner',
        year: 2049,
        yearFollowsTitle: true,
      });
    });

    it('never reads the first word as the year', () => {
      expect(parseSourceName('1917', NOW)).toMatchObject({
        query: '1917',
        year: null,
      });
      expect(parseSourceName('(2010)', NOW)).toMatchObject({
        query: '2010',
        year: null,
      });
    });

    it('needs exactly four digits', () => {
      expect(parseSourceName('Movie 201', NOW).year).toBeNull();
      expect(parseSourceName('Movie 20101', NOW).year).toBeNull();
      expect(parseSourceName('Movie 2010a', NOW).year).toBeNull();
    });
  });

  describe('step 6 — release tokens', () => {
    it.each([
      '480p',
      '1080i',
      '2160P',
      '4K',
      'UHD',
      'BluRay',
      'Blu-Ray',
      'BRRip',
      'BDRip',
      'BDRemux',
      'REMUX',
      'WEBRip',
      'WEB-DL',
      'WEBDL',
      'HDRip',
      'DVDRip',
      'DVDScr',
      'HDTV',
      'HDCAM',
      'x264',
      'X265',
      'h264',
      'H265',
      'HEVC',
      'AVC',
      'XviD',
      'DivX',
      'AAC',
      'AC3',
      'DTS',
      '10bit',
      'HDR',
      'YIFY',
      'YTS',
      'RARBG',
    ])('cuts the name at %s, whatever its case', (word) => {
      expect(
        parseSourceName(`Some Movie ${word} extra words`, NOW),
      ).toMatchObject({ query: 'Some Movie', year: null });
    });

    it('cuts at a token whose part before the first hyphen is a release word', () => {
      expect(parseSourceName('Some.Movie.x264-GROUP', NOW).query).toBe(
        'Some Movie',
      );
      expect(parseSourceName('Some.Movie.1080p-GROUP', NOW).query).toBe(
        'Some Movie',
      );
      expect(parseSourceName('Some.Movie.DTS-HD.MA', NOW).query).toBe(
        'Some Movie',
      );
    });

    it('cuts at the two-token pairs "web dl" and "blu ray"', () => {
      expect(parseSourceName('Some.Movie.WEB.DL.x264', NOW).query).toBe(
        'Some Movie',
      );
      expect(parseSourceName('Some Movie Blu Ray 2011', NOW)).toMatchObject({
        query: 'Some Movie',
        year: 2011,
      });
    });

    it('keeps "web" and "blu" on their own, and words that only contain a release word', () => {
      expect(parseSourceName('The Dark Web', NOW).query).toBe('The Dark Web');
      expect(parseSourceName('Blu Sky', NOW).query).toBe('Blu Sky');
      expect(parseSourceName('The Remuxed Hdrive Story', NOW).query).toBe(
        'The Remuxed Hdrive Story',
      );
    });

    it('never reads the first word as a release token', () => {
      expect(parseSourceName('HDR.2020.1080p', NOW)).toMatchObject({
        query: 'HDR',
        year: 2020,
      });
    });
  });

  describe('step 8 — edition words', () => {
    it.each([
      'Extended',
      'UNRATED',
      'Remastered',
      'Uncut',
      'REPACK',
      'IMAX',
      'Proper',
    ])('drops a trailing %s', (word) => {
      expect(parseSourceName(`Alien.${word}.1979.1080p`, NOW)).toMatchObject({
        query: 'Alien',
        year: 1979,
      });
    });

    it('drops several, and keeps the last word that is left', () => {
      expect(parseSourceName('Alien Extended Remastered', NOW).query).toBe(
        'Alien',
      );
      expect(parseSourceName('Extended', NOW).query).toBe('Extended');
      expect(parseSourceName('Uncut.Extended.2019', NOW)).toMatchObject({
        query: 'Uncut',
        year: 2019,
      });
    });

    it('keeps an edition word inside the name', () => {
      expect(parseSourceName('The Extended Family 2012', NOW).query).toBe(
        'The Extended Family',
      );
    });
  });

  describe('step 9 — the finished name', () => {
    it('strips loose punctuation from both ends only', () => {
      expect(parseSourceName(': Dune: Part Two, 2024', NOW)).toMatchObject({
        query: 'Dune: Part Two',
        year: 2024,
      });
    });

    it('adds no capital letters and corrects nothing', () => {
      expect(parseSourceName('iNCEPTION.2010', NOW).query).toBe('iNCEPTION');
    });

    it('keeps Burmese and other non-Latin names, in one normal form', () => {
      expect(parseSourceName('မြန်မာ_ဇာတ်ကား_2019_720p', NOW)).toMatchObject({
        query: 'မြန်မာ ဇာတ်ကား',
        year: 2019,
      });
      // e + combining acute (NFD) comes out as the single letter (NFC).
      expect(parseSourceName('Ame\u0301lie.2001', NOW).query).toBe(
        'Am\u00e9lie',
      );
    });

    it('is empty for an empty or blank name', () => {
      const empty = { query: '', year: null, yearFollowsTitle: false };
      expect(parseSourceName('', NOW)).toEqual(empty);
      expect(parseSourceName('   ', NOW)).toEqual(empty);
      expect(parseSourceName('._-', NOW)).toEqual(empty);
      expect(parseSourceName('[YTS] (x)', NOW)).toEqual(empty);
    });

    it('hands back the cleaned string, with no year, when no name survives', () => {
      expect(parseSourceName(': , 2010', NOW)).toEqual({
        query: ': , 2010',
        year: null,
        yearFollowsTitle: false,
      });
    });

    it(`cuts a very long name to ${SOURCE_NAME_QUERY_MAX} characters and still finds the year behind it`, () => {
      const long = `${'Word.'.repeat(80)}2015.1080p`;
      const parsed = parseSourceName(long, NOW);

      expect(parsed.year).toBe(2015);
      expect(parsed.query.length).toBeLessThanOrEqual(SOURCE_NAME_QUERY_MAX);
      expect(parsed.query.startsWith('Word Word Word')).toBe(true);
      // Cut on a character, never on a trailing blank.
      expect(parsed.query).toBe(parsed.query.trim());
    });

    it('never cuts a two-unit character in half', () => {
      // 199 letters, then an emoji that would straddle the 200th position.
      const parsed = parseSourceName(`${'a'.repeat(199)}\u{1F3AC}b`, NOW);

      expect(parsed.query).toBe('a'.repeat(199));
    });

    it('cuts the handed-back string of a nameless folder too', () => {
      const parsed = parseSourceName(`: ${', '.repeat(150)}2010`, NOW);

      expect(parsed.year).toBeNull();
      expect(parsed.query.length).toBeLessThanOrEqual(SOURCE_NAME_QUERY_MAX);
    });
  });
});
