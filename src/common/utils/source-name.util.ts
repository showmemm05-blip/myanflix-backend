/**
 * Reads a film's name and year out of the folder a bulk upload came from.
 *
 * The Transcoder names its output folder after the source file, so the only
 * clue to what a title IS is a string like
 * `Inception.2010.1080p.BluRay.x264-YIFY`. Two places need the same answer
 * from it, which is why this is one pure function: the upload placeholder
 * (the title and year a movie is born with) and the TMDB lookup (what to
 * search for). The rule is fixed in
 * docs/movie-details-tmdb-2026-11-06/PLAN.md 2.3 — the steps below are
 * numbered the way that section numbers them.
 *
 * It only ever REMOVES things (separators, bracket groups, release words,
 * the year). No capital letters are added and no word is corrected: the
 * search is case-blind and staff can always type their own words. Known
 * limit: a dotted short form (`S.W.A.T.`) becomes `S W A T`.
 */

/** What parseSourceName read out of a folder name. */
export interface ParsedSourceName {
  /** The cleaned name, at most SOURCE_NAME_QUERY_MAX characters. '' only for a name with nothing in it. */
  query: string;
  /** The release year found after the name, or null. */
  year: number | null;
  /**
   * True when the year stood directly after the name (`Wonder Woman 1984`),
   * so it may be part of the name itself rather than a release year. The
   * lookup then also tries the name with the year put back.
   */
  yearFollowsTitle: boolean;
}

/** The longest query returned — the length a movie title may have. */
export const SOURCE_NAME_QUERY_MAX = 200;

/** No film is older than this; a smaller 4-digit number is part of a name. */
const EARLIEST_YEAR = 1900;

const FOUR_DIGITS = /^\d{4}$/;

/** `1080p`, `720p`, `480i` — a picture height, never part of a name. */
const RESOLUTION_TOKEN = /^\d{3,4}[pi]$/;

/** Words a release puts after the name: source, codec, audio, group. Lower case. */
const RELEASE_WORDS: ReadonlySet<string> = new Set([
  '4k',
  'uhd',
  'bluray',
  'blu-ray',
  'brrip',
  'bdrip',
  'bdremux',
  'remux',
  'webrip',
  'web-dl',
  'webdl',
  'hdrip',
  'dvdrip',
  'dvdscr',
  'hdtv',
  'hdcam',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'xvid',
  'divx',
  'aac',
  'ac3',
  'dts',
  '10bit',
  'hdr',
  'yify',
  'yts',
  'rarbg',
]);

/** Release words written as two tokens once the separators are gone: `WEB.DL`, `Blu.Ray`. */
const RELEASE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['web', 'dl'],
  ['blu', 'ray'],
];

/** Edition words that trail a name without being part of it (`Inception Extended`). Lower case. */
const EDITION_WORDS: ReadonlySet<string> = new Set([
  'extended',
  'unrated',
  'remastered',
  'uncut',
  'repack',
  'imax',
  'proper',
]);

/** One innermost `(...)`, `[...]` or `{...}` group. */
const BRACKET_GROUP = /\(([^()]*)\)|\[([^[\]]*)\]|\{([^{}]*)\}/g;

function nfc(text: string): string {
  try {
    return text.normalize('NFC');
  } catch {
    // A runtime without Unicode tables: read the name as typed.
    return text;
  }
}

/** Exactly four digits naming a year a film can have: 1900 up to next year. */
function isYearToken(token: string, currentYear: number): boolean {
  if (!FOUR_DIGITS.test(token)) return false;
  const value = Number(token);
  return value >= EARLIEST_YEAR && value <= currentYear + 1;
}

function isReleaseWord(word: string): boolean {
  return RESOLUTION_TOKEN.test(word) || RELEASE_WORDS.has(word);
}

/**
 * Step 6: is the token at `index` where the release details start? A whole
 * token that is a release word, the part before its first hyphen being one
 * (`x264-YIFY`), or the first half of a two-token pair (`web dl`).
 */
function isReleaseTokenAt(tokens: readonly string[], index: number): boolean {
  const token = tokens[index].toLowerCase();
  if (isReleaseWord(token)) return true;
  const hyphen = token.indexOf('-');
  if (hyphen > 0 && isReleaseWord(token.slice(0, hyphen))) return true;
  const next = tokens[index + 1]?.toLowerCase();
  return RELEASE_PAIRS.some(
    ([first, second]) => token === first && next === second,
  );
}

/** The first `max` characters, never ending on half of a two-unit character. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? max - 1 : max).trimEnd();
}

/**
 * `currentYear` is passed in rather than read from the clock so the same
 * folder name always parses the same way in a test, and so a film dated
 * next year (a release announced early) still counts as a year.
 */
export function parseSourceName(
  name: string,
  currentYear: number,
): ParsedSourceName {
  // 1. One spelling of every character, no outer blanks.
  let text = nfc(name).trim();

  // 2. Bracket groups: `(2010)` is the year, anything else (`[YTS]`,
  // `[Korean]`) is a tag. Innermost first, so a group inside a group is
  // gone before its parent is read.
  let previous: string;
  do {
    previous = text;
    text = text.replace(
      BRACKET_GROUP,
      (_group, round?: string, square?: string, curly?: string) => {
        const inside = (round ?? square ?? curly ?? '').trim();
        return isYearToken(inside, currentYear) ? ` ${inside} ` : ' ';
      },
    );
  } while (text !== previous);

  // 3. Dots and underscores stand for spaces. A hyphen does too when it
  // stands alone or at a word's edge; inside a word it stays (`Spider-Man`,
  // `WEB-DL`).
  text = text.replace(/[._]+/g, ' ').replace(/(?<=^|\s)-+|-+(?=\s|$)/g, ' ');

  // 4. Single spaces, then words.
  const joined = text.replace(/\s+/g, ' ').trim();
  const tokens = joined === '' ? [] : joined.split(' ');

  // 5. The LAST year-looking token that is not the first word: in
  // `2012.2009.1080p` and `Wonder.Woman.1984.2020` the later one is the
  // release year, and a name may open with a year (`1917`, `2001 A Space
  // Odyssey`).
  let yearIndex = -1;
  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    if (isYearToken(tokens[index], currentYear)) {
      yearIndex = index;
      break;
    }
  }

  // 6. The FIRST release token that is not the first word (a film may be
  // called `1080p`; nothing before the first word can be a name).
  let releaseIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    if (isReleaseTokenAt(tokens, index)) {
      releaseIndex = index;
      break;
    }
  }

  // 7. The name ends where the year or the release details begin,
  // whichever comes first.
  const stops = [yearIndex, releaseIndex].filter((index) => index >= 0);
  const cut = stops.length > 0 ? Math.min(...stops) : tokens.length;
  const titleTokens = tokens.slice(0, cut);
  const year = yearIndex >= 0 ? Number(tokens[yearIndex]) : null;

  // 8. Edition words trail the name; the last word left is always kept.
  while (
    titleTokens.length > 1 &&
    EDITION_WORDS.has(titleTokens[titleTokens.length - 1].toLowerCase())
  ) {
    titleTokens.pop();
  }

  // 9. Loose punctuation at either end is left over from the separators.
  const query = cutTo(
    titleTokens.join(' ').replace(/^[\s\-:,]+|[\s\-:,]+$/g, ''),
    SOURCE_NAME_QUERY_MAX,
  );
  if (query === '') {
    // Nothing that reads as a name survived (a folder called `-` or `:`):
    // hand back the cleaned string itself, with no year claimed.
    return {
      query: cutTo(joined, SOURCE_NAME_QUERY_MAX),
      year: null,
      yearFollowsTitle: false,
    };
  }

  // 10. A year right after the name may belong to it (`Blade Runner 2049`
  // is caught by the year range; `Wonder Woman 1984` is not).
  return { query, year, yearFollowsTitle: year !== null && yearIndex === cut };
}
