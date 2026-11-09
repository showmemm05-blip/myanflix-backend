import {
  parseSourceName,
  type ParsedSourceName,
} from '../common/utils/source-name.util';
import type { TmdbFailureReason } from './tmdb-errors';
import {
  exactHit,
  findClearMatch,
  hitsOf,
  planAttempts,
  rowYear,
  type TmdbSearchAttempt,
} from './tmdb-match';
import type { TmdbSearchRow } from './tmdb-payload';

let nextId = 1;

/** One search row; only what a test cares about is named. */
function row(
  title: string,
  releaseDate: string,
  overrides: Partial<TmdbSearchRow> = {},
): TmdbSearchRow {
  return {
    id: nextId++,
    title,
    originalTitle: title,
    releaseDate,
    overview: '',
    posterPath: null,
    originalLanguage: 'en',
    ...overrides,
  };
}

const parsed = (
  query: string,
  year: number | null = null,
  yearFollowsTitle = false,
): ParsedSourceName => ({ query, year, yearFollowsTitle });

type Answer =
  | { ok: true; data: TmdbSearchRow[] }
  | { ok: false; reason: TmdbFailureReason };

/**
 * A fake TMDB search: the answer of each attempt by its step, and the
 * attempts it was asked, in order. A step with no answer returns no rows.
 */
function fakeSearch(answers: Partial<Record<'A1' | 'A2' | 'A3', Answer>>) {
  const asked: TmdbSearchAttempt[] = [];
  const search = jest.fn(async (attempt: TmdbSearchAttempt) => {
    asked.push(attempt);
    return answers[attempt.step] ?? { ok: true as const, data: [] };
  });
  return { search, asked };
}

const rows = (...data: TmdbSearchRow[]): Answer => ({ ok: true, data });

beforeEach(() => {
  nextId = 1;
});

describe('rowYear', () => {
  it('reads the year of a release date', () => {
    expect(rowYear({ releaseDate: '2010-07-16' })).toBe(2010);
  });

  it('is null when TMDB has no date, or the date is not one', () => {
    expect(rowYear({ releaseDate: '' })).toBeNull();
    expect(rowYear({ releaseDate: 'soon' })).toBeNull();
    expect(rowYear({ releaseDate: '201' })).toBeNull();
  });
});

describe('exactHit', () => {
  it('compares the names without case, accents or punctuation', () => {
    const film = { title: 'Spider-Man: No Way Home', originalTitle: '' };
    expect(exactHit(film, 'spider-man no way home')).toBe(true);
    expect(exactHit(film, 'Spider Man No Way Home')).toBe(true);
    expect(exactHit(film, 'Spider-Man')).toBe(false);
    expect(exactHit({ title: 'Amélie', originalTitle: '' }, 'amelie')).toBe(
      true,
    );
    expect(
      exactHit(
        { title: 'Fast & Furious', originalTitle: '' },
        'fast and furious',
      ),
    ).toBe(true);
  });

  it('also accepts the original title', () => {
    const film = { title: 'Parasite', originalTitle: '기생충' };
    expect(exactHit(film, '기생충')).toBe(true);
    expect(exactHit(film, 'Parasite')).toBe(true);
  });

  it('a Burmese name is not a hit for another word with the same consonants', () => {
    // "Fire" on TMDB, "rain" on the folder: they differ only in vowel signs.
    const fire = { title: 'Fire', originalTitle: 'မီး' };
    expect(exactHit(fire, 'မိုး')).toBe(false);
    expect(exactHit(fire, 'မီး')).toBe(true);
    expect(exactHit({ title: 'မိုး', originalTitle: '' }, 'မီး')).toBe(false);
  });

  it('never matches a name with nothing in it', () => {
    expect(exactHit({ title: '', originalTitle: '' }, '')).toBe(false);
    expect(exactHit({ title: '!!!', originalTitle: '' }, '???')).toBe(false);
  });
});

describe('planAttempts — which searches are made, in order', () => {
  it('no year: one search, the name alone', () => {
    expect(planAttempts(parsed('Avengers Endgame'))).toEqual([
      { step: 'A2', query: 'Avengers Endgame', yearFilter: null },
    ]);
  });

  it('a year after the release details: with the year filter, then without', () => {
    expect(planAttempts(parsed('Movie', 2010, false))).toEqual([
      { step: 'A1', query: 'Movie', yearFilter: 2010 },
      { step: 'A2', query: 'Movie', yearFilter: null },
    ]);
  });

  it('a year right after the name: a third search with the year put back into the name', () => {
    expect(planAttempts(parsed('Wonder Woman', 1984, true))).toEqual([
      { step: 'A1', query: 'Wonder Woman', yearFilter: 1984 },
      { step: 'A2', query: 'Wonder Woman', yearFilter: null },
      { step: 'A3', query: 'Wonder Woman 1984', yearFilter: null },
    ]);
  });

  it('plans from what parseSourceName really reads out of a folder name', () => {
    expect(
      planAttempts(
        parseSourceName('Inception.2010.1080p.BluRay.x264-YIFY', 2026),
      ).map((attempt) => attempt.step),
    ).toEqual(['A1', 'A2', 'A3']);
    expect(
      planAttempts(parseSourceName('Movie.720p.2010.x264', 2026)).map(
        (attempt) => attempt.step,
      ),
    ).toEqual(['A1', 'A2']);
    expect(
      planAttempts(parseSourceName('the_great_escape', 2026)).map(
        (attempt) => attempt.step,
      ),
    ).toEqual(['A2']);
  });
});

describe('hitsOf — which rows of one search count', () => {
  const inception = parsed('Inception', 2010, true);

  it('with a known year: the exact name AND a release year within one of it', () => {
    const candidates = [
      row('Inception', '2009-12-30'),
      row('Inception', '2010-07-16'),
      row('Inception', '2011-01-02'),
      row('Inception', '2012-05-05'),
      row('Inception', '2008-05-05'),
      row('Inception: The Cobol Job', '2010-12-07'),
    ];
    const a1: TmdbSearchAttempt = {
      step: 'A1',
      query: 'Inception',
      yearFilter: 2010,
    };
    expect(hitsOf(a1, candidates, inception).map(rowYear)).toEqual([
      2009, 2010, 2011,
    ]);
    // A2 keeps the year window while a year is known.
    const a2: TmdbSearchAttempt = {
      step: 'A2',
      query: 'Inception',
      yearFilter: null,
    };
    expect(hitsOf(a2, candidates, inception)).toHaveLength(3);
  });

  it('with a known year, a row without a release date is never a hit', () => {
    const a1: TmdbSearchAttempt = {
      step: 'A1',
      query: 'Inception',
      yearFilter: 2010,
    };
    expect(hitsOf(a1, [row('Inception', '')], inception)).toEqual([]);
  });

  it('without a year: the exact name alone decides, dated or not', () => {
    const a2: TmdbSearchAttempt = {
      step: 'A2',
      query: 'Oldboy',
      yearFilter: null,
    };
    const candidates = [
      row('Oldboy', ''),
      row('Oldboy', '2003-11-21'),
      row('Old Boys', '2003-01-01'),
    ];
    expect(hitsOf(a2, candidates, parsed('Oldboy'))).toHaveLength(2);
  });

  it('A3: the year is part of the name, so the release year is not looked at', () => {
    const a3: TmdbSearchAttempt = {
      step: 'A3',
      query: 'Wonder Woman 1984',
      yearFilter: null,
    };
    const candidates = [
      row('Wonder Woman 1984', '2020-12-16'),
      row('Wonder Woman', '2017-05-30'),
    ];
    expect(
      hitsOf(a3, candidates, parsed('Wonder Woman', 1984, true)).map(
        (hit) => hit.title,
      ),
    ).toEqual(['Wonder Woman 1984']);
  });
});

describe('findClearMatch — the "one clear match" rule', () => {
  it('one hit: that row is the match and the search stops there', async () => {
    const inception = row('Inception', '2010-07-16');
    const { search, asked } = fakeSearch({
      A1: rows(inception, row('Inception: The Cobol Job', '2010-12-07')),
    });

    await expect(
      findClearMatch(parsed('Inception', 2010, true), search),
    ).resolves.toEqual({ kind: 'matched', row: inception });
    expect(asked.map((attempt) => attempt.step)).toEqual(['A1']);
    expect(asked[0]).toEqual({
      step: 'A1',
      query: 'Inception',
      yearFilter: 2010,
    });
  });

  it('two hits: staff must pick, and no further search is made', async () => {
    const { search, asked } = fakeSearch({
      A1: rows(row('Oldboy', '2003-11-21'), row('Oldboy', '2004-01-10')),
    });

    await expect(
      findClearMatch(parsed('Oldboy', 2003, true), search),
    ).resolves.toEqual({ kind: 'needs_pick' });
    expect(asked.map((attempt) => attempt.step)).toEqual(['A1']);
  });

  it('no hit moves on: A1, then A2, then A3 — in that order', async () => {
    const { search, asked } = fakeSearch({});

    await expect(
      findClearMatch(parsed('Wonder Woman', 1984, true), search),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(asked).toEqual([
      { step: 'A1', query: 'Wonder Woman', yearFilter: 1984 },
      { step: 'A2', query: 'Wonder Woman', yearFilter: null },
      { step: 'A3', query: 'Wonder Woman 1984', yearFilter: null },
    ]);
  });

  it('A2 rescues a film the year filter hid — still within one year of the folder', async () => {
    const film = row('The Dark Knight', '2009-01-01');
    const { search, asked } = fakeSearch({
      A1: rows(),
      A2: rows(film, row('The Dark Knight Rises', '2012-07-16')),
    });

    await expect(
      findClearMatch(parsed('The Dark Knight', 2008, false), search),
    ).resolves.toEqual({ kind: 'matched', row: film });
    expect(asked.map((attempt) => attempt.step)).toEqual(['A1', 'A2']);
  });

  it('a year further than one away is no hit: rows were seen, so staff pick', async () => {
    const { search } = fakeSearch({
      A1: rows(),
      A2: rows(row('Movie', '2013-01-01')),
    });

    await expect(
      findClearMatch(parsed('Movie', 2010, false), search),
    ).resolves.toEqual({ kind: 'needs_pick' });
  });

  it('A3 rescues a name that ends in a year (`Wonder Woman 1984`)', async () => {
    const sequel = row('Wonder Woman 1984', '2020-12-16');
    const { search, asked } = fakeSearch({
      A1: rows(),
      A2: rows(row('Wonder Woman', '2017-05-30')),
      A3: rows(sequel, row('Wonder Woman', '2017-05-30')),
    });

    await expect(
      findClearMatch(parsed('Wonder Woman', 1984, true), search),
    ).resolves.toEqual({ kind: 'matched', row: sequel });
    expect(asked.map((attempt) => attempt.step)).toEqual(['A1', 'A2', 'A3']);
  });

  it('matches on the original title', async () => {
    const parasite = row('Parasite', '2019-05-30', { originalTitle: '기생충' });
    const { search } = fakeSearch({ A1: rows(parasite) });

    await expect(
      findClearMatch(parsed('기생충', 2019, true), search),
    ).resolves.toEqual({ kind: 'matched', row: parasite });
  });

  it('an empty release date: a hit when no year is known, not one when a year is', async () => {
    const undated = row('Oldboy', '');

    await expect(
      findClearMatch(
        parsed('Oldboy'),
        fakeSearch({ A2: rows(undated) }).search,
      ),
    ).resolves.toEqual({ kind: 'matched', row: undated });
    await expect(
      findClearMatch(
        parsed('Oldboy', 2003, false),
        fakeSearch({ A1: rows(undated), A2: rows(undated) }).search,
      ),
    ).resolves.toEqual({ kind: 'needs_pick' });
  });

  it('rows but none that is the name: staff pick; no rows anywhere: not found', async () => {
    await expect(
      findClearMatch(
        parsed('Avengers Endgame'),
        fakeSearch({ A2: rows(row('Avengers: Endgame Live', '2019-01-01')) })
          .search,
      ),
    ).resolves.toEqual({ kind: 'needs_pick' });
    await expect(
      findClearMatch(parsed('Zzzz Qqqq'), fakeSearch({}).search),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it.each<TmdbFailureReason>([
    'unreachable',
    'rate_limited',
    'key_rejected',
    'bad_response',
  ])(
    'a search that fails (%s) ends the lookup as failed — never decided on half the evidence',
    async (reason) => {
      const { search, asked } = fakeSearch({
        A1: rows(),
        A2: { ok: false, reason },
        A3: rows(row('Wonder Woman 1984', '2020-12-16')),
      });

      await expect(
        findClearMatch(parsed('Wonder Woman', 1984, true), search),
      ).resolves.toEqual({ kind: 'failed', reason });
      expect(asked.map((attempt) => attempt.step)).toEqual(['A1', 'A2']);
    },
  );

  it('a name with nothing in it is not searched for at all', async () => {
    const { search } = fakeSearch({});

    await expect(findClearMatch(parsed('  '), search)).resolves.toEqual({
      kind: 'not_found',
    });
    expect(search).not.toHaveBeenCalled();
  });
});
