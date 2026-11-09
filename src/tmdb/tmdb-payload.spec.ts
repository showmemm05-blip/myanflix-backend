import {
  TMDB_SEARCH_ROWS_MAX,
  appendedBlock,
  readCredits,
  readMovieCore,
  readSearchRows,
  readTvCore,
  readUsCertifications,
} from './tmdb-payload';

describe('readSearchRows', () => {
  it('reads movie rows by their movie names and show rows by their show names', () => {
    expect(
      readSearchRows(
        {
          results: [
            {
              id: 27205,
              title: ' Inception ',
              original_title: 'Inception',
              release_date: '2010-07-16',
              overview: 'A thief.',
              poster_path: '/p.jpg',
              original_language: 'en',
              name: 'ignored for a movie',
            },
          ],
        },
        'movie',
      ),
    ).toEqual([
      {
        id: 27205,
        title: 'Inception',
        originalTitle: 'Inception',
        releaseDate: '2010-07-16',
        overview: 'A thief.',
        posterPath: '/p.jpg',
        originalLanguage: 'en',
      },
    ]);
    expect(
      readSearchRows(
        {
          results: [
            {
              id: 66732,
              name: 'Stranger Things',
              original_name: 'Stranger Things',
              first_air_date: '2016-07-15',
            },
          ],
        },
        'tv',
      ),
    ).toEqual([
      {
        id: 66732,
        title: 'Stranger Things',
        originalTitle: 'Stranger Things',
        releaseDate: '2016-07-15',
        overview: '',
        posterPath: null,
        originalLanguage: null,
      },
    ]);
  });

  it('reads a field of the wrong type as missing, and drops a row without an id or a name', () => {
    expect(
      readSearchRows(
        {
          results: [
            { id: 1, title: 'Kept', release_date: null, poster_path: '' },
            { id: '2', title: 'No numeric id' },
            { id: 0, title: 'Zero id' },
            { id: 3, title: '   ' },
            { id: 4 },
            null,
            'text',
            [5],
          ],
        },
        'movie',
      ),
    ).toEqual([
      {
        id: 1,
        title: 'Kept',
        originalTitle: '',
        releaseDate: '',
        overview: '',
        posterPath: null,
        originalLanguage: null,
      },
    ]);
  });

  it('is null — not an empty list — when the answer has no results list', () => {
    expect(readSearchRows({ page: 1 }, 'movie')).toBeNull();
    expect(readSearchRows({ results: 'none' }, 'movie')).toBeNull();
    expect(readSearchRows(null, 'tv')).toBeNull();
    expect(readSearchRows([], 'tv')).toBeNull();
    expect(readSearchRows({ results: [] }, 'tv')).toEqual([]);
  });

  it('reads page 1 only: at most twenty rows', () => {
    const results = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      title: `Film ${index + 1}`,
    }));

    const rows = readSearchRows({ results }, 'movie');

    expect(rows).toHaveLength(TMDB_SEARCH_ROWS_MAX);
    expect(rows?.[19].id).toBe(20);
  });
});

describe('readCredits', () => {
  it("reads a film's cast (one character each) and crew", () => {
    expect(
      readCredits({
        cast: [
          {
            id: 6193,
            name: 'Leonardo DiCaprio',
            character: 'Cobb',
            order: 0,
            profile_path: '/leo.jpg',
          },
          { id: 2, name: 'No Order', character: 'X', profile_path: null },
          { name: 'No id' },
        ],
        crew: [
          { name: ' Christopher Nolan ', job: 'Director' },
          { name: '', job: 'Director' },
          { job: 'Producer' },
        ],
      }),
    ).toEqual({
      cast: [
        {
          id: 6193,
          name: 'Leonardo DiCaprio',
          characters: ['Cobb'],
          order: 0,
          profilePath: '/leo.jpg',
        },
        {
          id: 2,
          name: 'No Order',
          characters: ['X'],
          order: Number.MAX_SAFE_INTEGER,
          profilePath: null,
        },
      ],
      crew: [{ name: 'Christopher Nolan', job: 'Director' }],
    });
  });

  it("reads a show's aggregate cast: one character per role", () => {
    const credits = readCredits({
      cast: [
        {
          id: 1,
          name: 'Winona Ryder',
          roles: [{ character: 'Joyce Byers' }, { character: 'Joyce' }, {}],
          order: 0,
        },
      ],
    });

    expect(credits?.cast[0].characters).toEqual(['Joyce Byers', 'Joyce', '']);
    expect(credits?.crew).toEqual([]);
  });

  it('is null when there is no credits block at all — the client then asks for it separately', () => {
    expect(readCredits(undefined)).toBeNull();
    expect(readCredits(null)).toBeNull();
    expect(readCredits({})).toBeNull();
    expect(readCredits({ crew: [] })).toBeNull();
    expect(readCredits({ cast: [] })).toEqual({ cast: [], crew: [] });
  });
});

describe('readUsCertifications', () => {
  it('takes the US releases only', () => {
    expect(
      readUsCertifications({
        results: [
          {
            iso_3166_1: 'GB',
            release_dates: [{ certification: '12A', type: 3 }],
          },
          {
            iso_3166_1: 'us',
            release_dates: [
              { certification: 'PG-13 ', type: 3 },
              { certification: '', type: 1 },
              { type: 'x' },
            ],
          },
        ],
      }),
    ).toEqual([
      { certification: 'PG-13 ', type: 3 },
      { certification: '', type: 1 },
      { certification: '', type: null },
    ]);
  });

  it('is null when the block is missing, and empty when the US is not in it', () => {
    expect(readUsCertifications(undefined)).toBeNull();
    expect(readUsCertifications({})).toBeNull();
    expect(readUsCertifications({ results: [] })).toEqual([]);
    expect(
      readUsCertifications({
        results: [
          { iso_3166_1: 'KR', release_dates: [{ certification: '15' }] },
        ],
      }),
    ).toEqual([]);
  });
});

describe('readMovieCore / readTvCore', () => {
  it('reads a film', () => {
    expect(
      readMovieCore({
        id: 27205,
        title: 'Inception',
        original_title: 'Inception',
        overview: 'A thief.',
        release_date: '2010-07-15',
        runtime: 148,
        genres: [
          { id: 28, name: 'Action' },
          { name: 'Name Only' },
          { id: 12 },
          {},
        ],
        original_language: 'en',
        production_countries: [
          { iso_3166_1: 'gb', name: 'United Kingdom' },
          { iso_3166_1: 'US', name: 'United States' },
          { name: 'No code' },
        ],
        poster_path: '/poster.jpg',
        backdrop_path: null,
        adult: false,
      }),
    ).toEqual({
      id: 27205,
      title: 'Inception',
      originalTitle: 'Inception',
      overview: 'A thief.',
      releaseDate: '2010-07-15',
      runtime: 148,
      genres: [
        { id: 28, name: 'Action' },
        { id: 0, name: 'Name Only' },
        { id: 12, name: '' },
      ],
      originalLanguage: 'en',
      productionCountries: ['GB', 'US'],
      posterPath: '/poster.jpg',
      backdropPath: null,
    });
  });

  it('reads a show: its name, first-air date and origin country codes', () => {
    expect(
      readTvCore({
        id: 66732,
        name: 'Stranger Things',
        original_name: 'Stranger Things',
        overview: 'A boy vanishes.',
        first_air_date: '2016-07-15',
        genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
        original_language: 'en',
        origin_country: ['us', ''],
        poster_path: '/st.jpg',
        backdrop_path: '/st-wide.jpg',
      }),
    ).toEqual({
      id: 66732,
      title: 'Stranger Things',
      originalTitle: 'Stranger Things',
      overview: 'A boy vanishes.',
      firstAirDate: '2016-07-15',
      genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
      originalLanguage: 'en',
      originCountries: ['US'],
      posterPath: '/st.jpg',
      backdropPath: '/st-wide.jpg',
    });
  });

  it('reads what is missing or of the wrong type as nothing', () => {
    expect(readMovieCore({ id: 1, runtime: '148', genres: 'Action' })).toEqual({
      id: 1,
      title: '',
      originalTitle: '',
      overview: '',
      releaseDate: '',
      runtime: null,
      genres: [],
      originalLanguage: null,
      productionCountries: [],
      posterPath: null,
      backdropPath: null,
    });
  });

  it('is null for an answer that is not a title at all', () => {
    for (const raw of [
      null,
      undefined,
      'text',
      [],
      {},
      { id: 'x' },
      { id: 0 },
    ]) {
      expect(readMovieCore(raw)).toBeNull();
      expect(readTvCore(raw)).toBeNull();
    }
  });
});

describe('appendedBlock', () => {
  it('hands back the named block, or undefined', () => {
    expect(appendedBlock({ credits: { cast: [] } }, 'credits')).toEqual({
      cast: [],
    });
    expect(appendedBlock({ id: 1 }, 'credits')).toBeUndefined();
    expect(appendedBlock(null, 'credits')).toBeUndefined();
  });
});
