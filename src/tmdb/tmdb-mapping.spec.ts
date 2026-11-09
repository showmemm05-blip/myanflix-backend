import { HOUSE_GENRES, HOUSE_LANGUAGES, HOUSE_TYPES } from './house-words';
import {
  KNOWN_TMDB_GENRE_IDS,
  TMDB_CAST_LIMIT,
  cleanPersonName,
  mapAgeRating,
  mapCast,
  mapDirector,
  mapGenres,
  mapLanguageWord,
  mapMovieDetails,
  mapTvDetails,
  mapTypeWord,
  matchCategories,
  yearOfDate,
} from './tmdb-mapping';
import type {
  TmdbCastRow,
  TmdbMovieDetails,
  TmdbTvDetails,
} from './tmdb-payload';

const castRow = (
  id: number,
  name: string,
  order: number,
  overrides: Partial<TmdbCastRow> = {},
): TmdbCastRow => ({
  id,
  name,
  characters: ['Someone'],
  order,
  profilePath: `/photo${id}.jpg`,
  ...overrides,
});

const movieDetails = (
  overrides: Partial<TmdbMovieDetails> = {},
): TmdbMovieDetails => ({
  id: 27205,
  title: 'Inception',
  originalTitle: 'Inception',
  overview: 'A thief who steals corporate secrets through dreams.',
  releaseDate: '2010-07-15',
  runtime: 148,
  genres: [
    { id: 28, name: 'Action' },
    { id: 878, name: 'Science Fiction' },
    { id: 12, name: 'Adventure' },
  ],
  originalLanguage: 'en',
  productionCountries: ['GB', 'US'],
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
  cast: [castRow(6193, 'Leonardo DiCaprio', 0)],
  crew: [
    { name: 'Emma Thomas', job: 'Producer' },
    { name: 'Christopher Nolan', job: 'Director' },
  ],
  usCertifications: [{ certification: 'PG-13', type: 3 }],
  ...overrides,
});

const tvDetails = (overrides: Partial<TmdbTvDetails> = {}): TmdbTvDetails => ({
  id: 66732,
  title: 'Stranger Things',
  originalTitle: 'Stranger Things',
  overview: 'A boy vanishes.',
  firstAirDate: '2016-07-15',
  genres: [
    { id: 10765, name: 'Sci-Fi & Fantasy' },
    { id: 9648, name: 'Mystery' },
  ],
  originalLanguage: 'en',
  originCountries: ['US'],
  posterPath: '/st.jpg',
  backdropPath: '/st-wide.jpg',
  cast: [castRow(1, 'Winona Ryder', 0)],
  ...overrides,
});

describe('mapGenres — TMDB genre -> the house genre and the category words (PLAN 2.7)', () => {
  // Every row of the table in PLAN.md 2.7: [TMDB id, TMDB name, house genre, category words].
  it.each([
    [28, 'Action', 'Action', ['Action']],
    [12, 'Adventure', 'Adventure', ['Adventure']],
    [16, 'Animation', 'Animation', ['Animation']],
    [35, 'Comedy', 'Comedy', ['Comedy']],
    [80, 'Crime', 'Crime', ['Crime']],
    [99, 'Documentary', 'Documentary', ['Documentary']],
    [18, 'Drama', 'Drama', ['Drama']],
    [10751, 'Family', 'Family', ['Family']],
    [14, 'Fantasy', 'Fantasy', ['Fantasy']],
    [36, 'History', 'History', ['History']],
    [27, 'Horror', 'Horror', ['Horror']],
    [9648, 'Mystery', 'Mystery', ['Mystery']],
    [10749, 'Romance', 'Romance', ['Romance']],
    [53, 'Thriller', 'Thriller', ['Thriller']],
    [878, 'Science Fiction', 'Sci-Fi', ['Sci-Fi']],
    [10402, 'Music', 'Musical', ['Musical']],
    [10759, 'Action & Adventure', 'Action', ['Action', 'Adventure']],
    [10765, 'Sci-Fi & Fantasy', 'Sci-Fi', ['Sci-Fi', 'Fantasy']],
    [10762, 'Kids', 'Family', ['Family']],
    [10766, 'Soap', 'Drama', ['Drama']],
    [10770, 'TV Movie', null, ['TV Movie']],
    [10752, 'War', null, ['War']],
    [37, 'Western', null, ['Western']],
    [10763, 'News', null, ['News']],
    [10764, 'Reality', null, ['Reality']],
    [10767, 'Talk', null, ['Talk']],
    [10768, 'War & Politics', null, ['War & Politics']],
  ] as const)('%i %s -> %p', (id, name, genre, categoryWords) => {
    expect(mapGenres([{ id, name }])).toEqual({ genre, categoryWords });
  });

  it('covers every id the table knows, and only writes genres the admin offers', () => {
    expect([...KNOWN_TMDB_GENRE_IDS].sort((a, b) => a - b)).toEqual(
      [
        28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 9648, 10749, 53, 878,
        10402, 10759, 10765, 10762, 10766, 10770, 10752, 37, 10763, 10764,
        10767, 10768,
      ].sort((a, b) => a - b),
    );
    for (const id of KNOWN_TMDB_GENRE_IDS) {
      const { genre } = mapGenres([{ id, name: '' }]);
      if (genre !== null) expect(HOUSE_GENRES).toContain(genre);
    }
  });

  it('maps by id whatever name TMDB sends with it', () => {
    expect(mapGenres([{ id: 878, name: 'Ciencia ficción' }]).genre).toBe(
      'Sci-Fi',
    );
  });

  it('falls back to the name when the id is unknown', () => {
    expect(mapGenres([{ id: 0, name: 'Science Fiction' }])).toEqual({
      genre: 'Sci-Fi',
      categoryWords: ['Sci-Fi'],
    });
    expect(mapGenres([{ id: 999999, name: 'action & adventure' }])).toEqual({
      genre: 'Action',
      categoryWords: ['Action', 'Adventure'],
    });
  });

  it('a genre nobody knows is no genre, but its name is still offered to the categories', () => {
    expect(mapGenres([{ id: 424242, name: 'Anime' }])).toEqual({
      genre: null,
      categoryWords: ['Anime'],
    });
  });

  it('takes the FIRST genre that maps, in TMDB order, and offers every word once', () => {
    expect(
      mapGenres([
        { id: 10752, name: 'War' },
        { id: 18, name: 'Drama' },
        { id: 28, name: 'Action' },
        { id: 10759, name: 'Action & Adventure' },
      ]),
    ).toEqual({
      genre: 'Drama',
      categoryWords: ['War', 'Drama', 'Action', 'Adventure'],
    });
  });

  it('no genres: no genre and no words', () => {
    expect(mapGenres([])).toEqual({ genre: null, categoryWords: [] });
  });
});

describe('the type word and the language word (PLAN 2.8)', () => {
  // [original_language, type word, language word] — with no country given.
  it.each([
    ['en', 'English', 'English'],
    ['ko', 'Korean', 'Korean'],
    ['zh', 'Chinese', 'Chinese'],
    ['cn', 'Chinese', 'Chinese'],
    ['th', 'Thai', 'Thai'],
    ['ja', 'Japanese', 'Japanese'],
    ['hi', 'Indian', 'Hindi'],
    ['ta', 'Indian', null],
    ['te', 'Indian', null],
    ['ml', 'Indian', null],
    ['kn', 'Indian', null],
    ['bn', 'Indian', null],
    ['mr', 'Indian', null],
    ['pa', 'Indian', null],
    ['gu', 'Indian', null],
    ['my', 'Myanmar', 'Burmese'],
    ['es', 'Other', 'Spanish'],
    ['fr', 'Other', 'French'],
    ['de', 'Other', null],
    ['xx', 'Other', null],
  ] as const)('%s -> type %p, language %p', (code, type, language) => {
    expect(mapTypeWord(code, [])).toBe(type);
    expect(mapLanguageWord(code)).toBe(language);
  });

  it('reads the code whatever its case or padding', () => {
    expect(mapLanguageWord(' KO ')).toBe('Korean');
    expect(mapTypeWord('KO', [])).toBe('Korean');
  });

  // The language gave no type: the FIRST country decides.
  it.each([
    ['US', 'English'],
    ['GB', 'English'],
    ['CA', 'English'],
    ['AU', 'English'],
    ['NZ', 'English'],
    ['IE', 'English'],
    ['KR', 'Korean'],
    ['CN', 'Chinese'],
    ['HK', 'Chinese'],
    ['TW', 'Chinese'],
    ['TH', 'Thai'],
    ['JP', 'Japanese'],
    ['IN', 'Indian'],
    ['MM', 'Myanmar'],
    ['DE', 'Other'],
  ] as const)('a French-language film from %s is %p', (country, type) => {
    expect(mapTypeWord('fr', [country])).toBe(type);
  });

  it('the language wins over the country; only the first country is read', () => {
    expect(mapTypeWord('ko', ['US'])).toBe('Korean');
    expect(mapTypeWord('fr', ['FR', 'US'])).toBe('Other');
    expect(mapTypeWord('fr', ['us', 'FR'])).toBe('English');
  });

  it('a country alone still gives a type; nothing at all gives none', () => {
    expect(mapTypeWord(null, ['JP'])).toBe('Japanese');
    expect(mapTypeWord(null, ['BR'])).toBe('Other');
    expect(mapTypeWord(null, [])).toBeNull();
    expect(mapTypeWord('  ', [])).toBeNull();
    expect(mapLanguageWord(null)).toBeNull();
  });

  it('only ever writes words the admin lists carry', () => {
    const codes = ['en', 'ko', 'zh', 'cn', 'th', 'ja', 'hi', 'ta', 'my', 'es'];
    for (const code of codes) {
      const type = mapTypeWord(code, ['US']);
      const language = mapLanguageWord(code);
      expect(HOUSE_TYPES).toContain(type);
      if (language !== null) expect(HOUSE_LANGUAGES).toContain(language);
    }
  });
});

describe('mapAgeRating — the US certification (PLAN 2.8)', () => {
  it.each([
    ['G', 'G'],
    ['PG', 'PG'],
    ['PG-13', 'PG13'],
    ['R', 'R'],
    ['NC-17', 'NC17'],
  ] as const)('%s -> %s', (certification, rating) => {
    expect(mapAgeRating([{ certification, type: 3 }])).toBe(rating);
  });

  it('trims the padding TMDB leaves on some (`PG-13 `)', () => {
    expect(mapAgeRating([{ certification: 'PG-13 ', type: 3 }])).toBe('PG13');
    expect(mapAgeRating([{ certification: ' r ', type: 3 }])).toBe('R');
  });

  it.each(['NR', 'TV-MA', 'Unrated', 'X', '18'])(
    '%s is no rating of ours: staff choose',
    (certification) => {
      expect(mapAgeRating([{ certification, type: 3 }])).toBeNull();
    },
  );

  it('looks at the theatrical release (type 3) first, then at any release', () => {
    expect(
      mapAgeRating([
        { certification: 'R', type: 4 },
        { certification: 'PG-13', type: 3 },
      ]),
    ).toBe('PG13');
    expect(
      mapAgeRating([
        { certification: '', type: 3 },
        { certification: 'R', type: 4 },
      ]),
    ).toBe('R');
  });

  it('takes the first one that is not blank', () => {
    expect(
      mapAgeRating([
        { certification: '  ', type: 3 },
        { certification: 'PG', type: 3 },
        { certification: 'R', type: 3 },
      ]),
    ).toBe('PG');
  });

  it('no US release, or none with a certification: no rating', () => {
    expect(mapAgeRating([])).toBeNull();
    expect(mapAgeRating([{ certification: '', type: null }])).toBeNull();
  });
});

describe('mapDirector', () => {
  it('takes the first crew member whose job is exactly "Director"', () => {
    expect(
      mapDirector([
        { name: 'Wally Pfister', job: 'Director of Photography' },
        { name: 'Nilo Otero', job: 'Assistant Director' },
        { name: 'Lana Wachowski', job: 'Director' },
        { name: 'Lilly Wachowski', job: 'Director' },
      ]),
    ).toBe('Lana Wachowski');
  });

  it('is null when nobody directed, and cleans the name it takes', () => {
    expect(mapDirector([{ name: 'Emma Thomas', job: 'Producer' }])).toBeNull();
    expect(mapDirector([])).toBeNull();
    expect(mapDirector([{ name: '  Bong   Joon-ho ', job: 'Director' }])).toBe(
      'Bong Joon-ho',
    );
  });
});

describe('mapCast — the first ten, credited and named (PLAN 2.10)', () => {
  it('takes the first ten by billing order', () => {
    const people = Array.from({ length: 14 }, (_, index) =>
      castRow(100 + index, `Actor ${index}`, 13 - index),
    );

    const cast = mapCast(people);

    expect(cast).toHaveLength(TMDB_CAST_LIMIT);
    // Order 0 is the row built last.
    expect(cast[0]).toEqual({
      tmdbPersonId: 113,
      name: 'Actor 13',
      profilePath: '/photo113.jpg',
    });
    expect(cast.map((person) => person.tmdbPersonId)).toEqual([
      113, 112, 111, 110, 109, 108, 107, 106, 105, 104,
    ]);
  });

  it('skips people with no name and people credited only as uncredited', () => {
    const cast = mapCast([
      castRow(1, 'Lead', 0),
      castRow(2, '   ', 1),
      castRow(3, 'Extra', 2, { characters: ['Bartender (uncredited)'] }),
      castRow(4, 'Cameo', 3, { characters: ['Self (UNCREDITED)'] }),
      castRow(5, 'Second', 4),
    ]);

    expect(cast.map((person) => person.name)).toEqual(['Lead', 'Second']);
  });

  it('keeps a series regular who was uncredited in only one of several roles', () => {
    const cast = mapCast([
      castRow(1, 'Regular', 0, {
        characters: ['Guard (uncredited)', 'Captain Vega'],
      }),
      castRow(2, 'No Roles Listed', 1, { characters: [] }),
    ]);

    expect(cast.map((person) => person.name)).toEqual([
      'Regular',
      'No Roles Listed',
    ]);
  });

  it('skipped rows do not use up a place among the ten', () => {
    const people = [
      castRow(900, 'Ghost', 0, { characters: ['Crowd (uncredited)'] }),
      ...Array.from({ length: 10 }, (_, index) =>
        castRow(index + 1, `Actor ${index}`, index + 1),
      ),
    ];

    expect(mapCast(people)).toHaveLength(10);
  });

  it('takes a person listed twice once, at their first position', () => {
    const cast = mapCast([
      castRow(7, 'Eddie Murphy', 2, { characters: ['Sherman'] }),
      castRow(8, 'Other', 1),
      castRow(7, 'Eddie Murphy', 0, { characters: ['Buddy'] }),
    ]);

    expect(cast.map((person) => person.tmdbPersonId)).toEqual([7, 8]);
  });

  it('cleans the name and refuses a photo path that is not a TMDB one', () => {
    const cast = mapCast([
      castRow(1, '  Chloë   Grace  Moretz ', 0, {
        profilePath: 'https://evil.example/x.jpg',
      }),
      castRow(2, 'No Photo', 1, { profilePath: null }),
    ]);

    expect(cast).toEqual([
      { tmdbPersonId: 1, name: 'Chloë Grace Moretz', profilePath: null },
      { tmdbPersonId: 2, name: 'No Photo', profilePath: null },
    ]);
  });

  it('a row without a billing order sorts last', () => {
    const cast = mapCast([
      castRow(1, 'Unordered', Number.MAX_SAFE_INTEGER),
      castRow(2, 'First', 0),
    ]);

    expect(cast.map((person) => person.name)).toEqual(['First', 'Unordered']);
  });
});

describe('cleanPersonName', () => {
  it('collapses spaces, trims and stops at 120 characters', () => {
    expect(cleanPersonName('  Tom \t Hanks\n')).toBe('Tom Hanks');
    expect(cleanPersonName('x'.repeat(200))).toHaveLength(120);
  });

  it('stores one spelling of an accented letter (NFC)', () => {
    const decomposed = 'Chloe\u0308';
    expect(cleanPersonName(decomposed)).toBe('Chlo\u00eb');
    expect(cleanPersonName(decomposed)).toHaveLength(5);
  });
});

describe('yearOfDate', () => {
  it('reads the year, or null when there is no date', () => {
    expect(yearOfDate('2010-07-16')).toBe(2010);
    expect(yearOfDate('')).toBeNull();
    expect(yearOfDate('TBA')).toBeNull();
  });
});

describe('mapMovieDetails (PLAN 2.6)', () => {
  it('maps a film into our words', () => {
    expect(mapMovieDetails(movieDetails())).toEqual({
      tmdbId: 27205,
      match: { title: 'Inception', year: 2010 },
      title: 'Inception',
      description: 'A thief who steals corporate secrets through dreams.',
      releaseYear: 2010,
      duration: 148,
      genre: 'Action',
      language: 'English',
      country: 'English',
      director: 'Christopher Nolan',
      ageRating: 'PG13',
      posterPath: '/poster.jpg',
      coverPath: '/backdrop.jpg',
      categoryWords: ['Action', 'Sci-Fi', 'Adventure'],
      cast: [
        {
          tmdbPersonId: 6193,
          name: 'Leonardo DiCaprio',
          profilePath: '/photo6193.jpg',
        },
      ],
    });
  });

  it('what TMDB does not have is null — nothing is invented', () => {
    const proposal = mapMovieDetails(
      movieDetails({
        title: '   ',
        originalTitle: '',
        overview: '',
        releaseDate: '',
        runtime: null,
        genres: [],
        originalLanguage: null,
        productionCountries: [],
        posterPath: null,
        backdropPath: null,
        cast: [],
        crew: [],
        usCertifications: [],
      }),
    );

    expect(proposal).toEqual({
      tmdbId: 27205,
      match: { title: '', year: null },
      title: null,
      description: null,
      releaseYear: null,
      duration: null,
      genre: null,
      language: null,
      country: null,
      director: null,
      ageRating: null,
      posterPath: null,
      coverPath: null,
      categoryWords: [],
      cast: [],
    });
  });

  it('trims and cuts the texts to what the catalogue stores', () => {
    const proposal = mapMovieDetails(
      movieDetails({
        title: `  ${'T'.repeat(300)}  `,
        overview: `  ${'o'.repeat(5000)}  `,
      }),
    );

    expect(proposal.title).toHaveLength(200);
    expect(proposal.description).toHaveLength(4000);
  });

  it.each([
    [0, null],
    [-5, null],
    [0.4, null],
    [1, 1],
    [89.6, 90],
    [100_000_000, null],
  ])('runtime %p -> duration %p', (runtime, duration) => {
    expect(mapMovieDetails(movieDetails({ runtime })).duration).toBe(duration);
  });

  it.each([
    ['1887-12-31', null],
    ['1888-01-01', 1888],
    ['2100-06-01', 2100],
    ['2101-01-01', null],
  ])('release date %s -> releaseYear %p', (releaseDate, year) => {
    expect(mapMovieDetails(movieDetails({ releaseDate })).releaseYear).toBe(
      year,
    );
  });

  it("refuses a picture path that is not TMDB's own shape", () => {
    const proposal = mapMovieDetails(
      movieDetails({
        posterPath: '/a/../../etc/passwd.jpg',
        backdropPath: 'https://evil.example/x.jpg',
      }),
    );

    expect(proposal.posterPath).toBeNull();
    expect(proposal.coverPath).toBeNull();
  });

  it('shows the original title as the match when TMDB has no title', () => {
    expect(
      mapMovieDetails(movieDetails({ title: '', originalTitle: '기생충' }))
        .match,
    ).toEqual({ title: '기생충', year: 2010 });
  });
});

describe('mapTvDetails', () => {
  it('maps a show: name, first-air year, origin country — and no runtime, director or age rating', () => {
    expect(mapTvDetails(tvDetails())).toEqual({
      tmdbId: 66732,
      match: { title: 'Stranger Things', year: 2016 },
      title: 'Stranger Things',
      description: 'A boy vanishes.',
      releaseYear: 2016,
      duration: null,
      genre: 'Sci-Fi',
      language: 'English',
      country: 'English',
      director: null,
      ageRating: null,
      posterPath: '/st.jpg',
      coverPath: '/st-wide.jpg',
      categoryWords: ['Sci-Fi', 'Fantasy', 'Mystery'],
      cast: [
        { tmdbPersonId: 1, name: 'Winona Ryder', profilePath: '/photo1.jpg' },
      ],
    });
  });

  it('takes the type from the origin country when the language has none', () => {
    expect(
      mapTvDetails(
        tvDetails({ originalLanguage: 'es', originCountries: ['KR'] }),
      ).country,
    ).toBe('Korean');
  });
});

describe('matchCategories — existing categories only (PLAN 2.7)', () => {
  const categories = [
    { id: 'c-action', name: 'Action' },
    { id: 'c-scifi', name: 'Sci Fi' },
    { id: 'c-war', name: 'war' },
    { id: 'c-kdrama', name: 'K-Drama' },
  ];

  it('connects a category whose name is the same word, however it is written', () => {
    expect(matchCategories(['Action', 'Sci-Fi', 'War'], categories)).toEqual({
      matched: [
        { id: 'c-action', name: 'Action' },
        { id: 'c-scifi', name: 'Sci Fi' },
        { id: 'c-war', name: 'war' },
      ],
      unmatched: [],
    });
  });

  it('reports the words that have no category — none is ever created', () => {
    expect(matchCategories(['Action', 'Western', 'News'], categories)).toEqual({
      matched: [{ id: 'c-action', name: 'Action' }],
      unmatched: ['Western', 'News'],
    });
  });

  it('connects every category that carries the word, each once', () => {
    const twins = [
      { id: 'a', name: 'Sci-Fi' },
      { id: 'b', name: 'SciFi' },
    ];

    expect(matchCategories(['Sci-Fi', 'sci fi'], twins).matched).toEqual(twins);
  });

  it('no words or no categories: nothing matched', () => {
    expect(matchCategories([], categories)).toEqual({
      matched: [],
      unmatched: [],
    });
    expect(matchCategories(['Action'], [])).toEqual({
      matched: [],
      unmatched: ['Action'],
    });
  });
});
