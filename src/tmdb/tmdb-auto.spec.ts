import {
  applyChanges,
  decideField,
  descriptionHash,
  fieldStanding,
  isUntouched,
  mergeAutoList,
  previewLineState,
  readTmdbAuto,
  sameIdSet,
  sameImage,
  type TmdbAuto,
  type TmdbFieldStanding,
  type TmdbTitleView,
} from './tmdb-auto';
import { TMDB_MOVIE_FIELDS, type TmdbField } from './tmdb.types';

/** MinioService.keyFromPublicUrl in small: the object key is whatever follows the bucket. */
const keyOf = (url: string): string | null => {
  const at = url.indexOf('/movies/');
  return at === -1 ? null : url.slice(at + '/movies/'.length);
};

const POSTER = 'http://cache.local/movies/images/movie/tmdb-poster.jpg';
const COVER = 'http://cache.local/movies/images/movie/tmdb-cover.jpg';

/** A movie as the upload placeholder leaves it: nothing but the born title and year. */
const placeholderView = (
  overrides: Partial<TmdbTitleView> = {},
): TmdbTitleView => ({
  title: 'Inception',
  description: '',
  releaseYear: 2010,
  duration: 0,
  genre: '',
  language: '',
  country: null,
  director: null,
  ageRating: null,
  posterUrl: null,
  coverUrl: null,
  categoryIds: [],
  actorIds: [],
  ...overrides,
});

/** A movie right after a fill wrote every field, and the tmdbAuto that fill left. */
const filledView = (overrides: Partial<TmdbTitleView> = {}): TmdbTitleView => ({
  title: 'Inception',
  description: 'A thief who steals secrets.',
  releaseYear: 2010,
  duration: 148,
  genre: 'Action',
  language: 'English',
  country: 'English',
  director: 'Christopher Nolan',
  ageRating: 'PG13',
  posterUrl: POSTER,
  coverUrl: COVER,
  categoryIds: ['c-1', 'c-2'],
  actorIds: ['a-1', 'a-2'],
  ...overrides,
});

const filledAuto = (overrides: Partial<TmdbAuto> = {}): TmdbAuto => ({
  v: 1,
  match: { title: 'Inception', year: 2010 },
  title: 'Inception',
  descriptionHash: descriptionHash('A thief who steals secrets.'),
  releaseYear: 2010,
  duration: 148,
  genre: 'Action',
  language: 'English',
  country: 'English',
  director: 'Christopher Nolan',
  ageRating: 'PG13',
  posterUrl: POSTER,
  posterPath: '/poster.jpg',
  coverUrl: COVER,
  coverPath: '/cover.jpg',
  categoryIds: ['c-1', 'c-2'],
  actorIds: ['a-1', 'a-2'],
  ...overrides,
});

const standing = (
  field: TmdbField,
  view: TmdbTitleView,
  auto: TmdbAuto | null,
): TmdbFieldStanding => fieldStanding(field, view, auto, keyOf);

describe('readTmdbAuto', () => {
  it('is null for a title that has none, and for anything that is not version 1', () => {
    expect(readTmdbAuto(null)).toBeNull();
    expect(readTmdbAuto(undefined)).toBeNull();
    expect(readTmdbAuto('{"v":1}')).toBeNull();
    expect(readTmdbAuto([{ v: 1 }])).toBeNull();
    expect(readTmdbAuto({})).toBeNull();
    expect(readTmdbAuto({ v: 2, title: 'x' })).toBeNull();
  });

  it('reads the baseline the upload placeholder writes', () => {
    expect(
      readTmdbAuto({ v: 1, title: 'Inception', releaseYear: 2010 }),
    ).toEqual({ v: 1, title: 'Inception', releaseYear: 2010 });
  });

  it('reads back everything a fill writes', () => {
    expect(readTmdbAuto(JSON.parse(JSON.stringify(filledAuto())))).toEqual(
      filledAuto(),
    );
  });

  it('reads a key of the wrong type as absent — the field then counts as changed by hand', () => {
    expect(
      readTmdbAuto({
        v: 1,
        title: 42,
        releaseYear: '2010',
        duration: 1.5,
        genre: null,
        ageRating: 'PG-13',
        posterUrl: ['x'],
        categoryIds: ['c-1', 7],
        actorIds: 'a-1',
        match: { title: 'Inception', year: 'soon' },
        somethingElse: true,
      }),
    ).toEqual({ v: 1, match: { title: 'Inception', year: null } });
  });
});

describe('descriptionHash', () => {
  it('is the SHA-256 of the text, outer blanks ignored', () => {
    expect(descriptionHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(descriptionHash('  abc\n')).toBe(descriptionHash('abc'));
    expect(descriptionHash('abc.')).not.toBe(descriptionHash('abc'));
  });
});

describe('sameIdSet / sameImage', () => {
  it('compares two id lists as sets', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIdSet(['a', 'a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });

  it('compares two pictures by object key, so the host a URL was saved under does not matter', () => {
    expect(
      sameImage(
        POSTER,
        'http://192.168.1.5:8080/movies/images/movie/tmdb-poster.jpg',
        keyOf,
      ),
    ).toBe(true);
    expect(sameImage(POSTER, COVER, keyOf)).toBe(false);
    expect(sameImage(POSTER, null, keyOf)).toBe(false);
    expect(sameImage(null, null, keyOf)).toBe(false);
    // Not one of ours: equal only as text.
    expect(sameImage('https://x/a.jpg', 'https://x/a.jpg', keyOf)).toBe(true);
    expect(sameImage('https://x/a.jpg', 'https://y/a.jpg', keyOf)).toBe(false);
  });
});

describe('fieldStanding — the untouched rule, field by field (PLAN 2.9)', () => {
  // Every field with an empty placeholder: it is `empty` on a fresh upload.
  it.each([
    'description',
    'duration',
    'genre',
    'language',
    'country',
    'director',
    'ageRating',
    'poster',
    'cover',
    'categories',
    'cast',
  ] as const)('%s holding its empty placeholder is empty', (field) => {
    const baseline: TmdbAuto = { v: 1, title: 'Inception', releaseYear: 2010 };
    expect(standing(field, placeholderView(), baseline)).toBe('empty');
    expect(standing(field, placeholderView(), null)).toBe('empty');
    // Even a remembered value does not make an empty field anything else.
    expect(standing(field, placeholderView(), filledAuto())).toBe('empty');
  });

  it.each(TMDB_MOVIE_FIELDS)(
    '%s still holding what the fill wrote is auto',
    (field) => {
      expect(standing(field, filledView(), filledAuto())).toBe('auto');
    },
  );

  // What staff typing something else looks like, per field.
  it.each<[TmdbField, Partial<TmdbTitleView>]>([
    ['title', { title: 'Inception (Director Cut)' }],
    ['description', { description: 'Our own words.' }],
    ['releaseYear', { releaseYear: 2011 }],
    ['duration', { duration: 150 }],
    ['genre', { genre: 'Thriller' }],
    ['language', { language: 'Burmese' }],
    ['country', { country: 'Other' }],
    ['director', { director: 'Someone Else' }],
    ['ageRating', { ageRating: 'R' }],
    [
      'poster',
      { posterUrl: 'http://cache.local/movies/images/movie/staff-upload.jpg' },
    ],
    [
      'cover',
      { coverUrl: 'http://cache.local/movies/images/movie/staff-wide.jpg' },
    ],
    ['categories', { categoryIds: ['c-1', 'c-2', 'c-staff'] }],
    ['cast', { actorIds: ['a-1'] }],
  ])('%s changed by staff is hand', (field, change) => {
    expect(standing(field, filledView(change), filledAuto())).toBe('hand');
  });

  it("a row with no tmdbAuto: title and year are staff's, the rest follows the placeholder rule", () => {
    const older = filledView({ director: null, posterUrl: null });

    expect(standing('title', older, null)).toBe('hand');
    expect(standing('releaseYear', older, null)).toBe('hand');
    expect(standing('description', older, null)).toBe('hand');
    expect(standing('genre', older, null)).toBe('hand');
    expect(standing('categories', older, null)).toBe('hand');
    expect(standing('director', older, null)).toBe('empty');
    expect(standing('poster', older, null)).toBe('empty');
  });

  it('title and year have no empty placeholder: with the upload baseline they are auto until edited', () => {
    const baseline: TmdbAuto = { v: 1, title: 'Inception', releaseYear: 2010 };

    expect(standing('title', placeholderView(), baseline)).toBe('auto');
    expect(standing('releaseYear', placeholderView(), baseline)).toBe('auto');
    expect(
      standing('title', placeholderView({ title: 'Renamed' }), baseline),
    ).toBe('hand');
    expect(
      standing('releaseYear', placeholderView({ releaseYear: 1999 }), baseline),
    ).toBe('hand');
    // Never empty, whatever they hold.
    expect(standing('title', placeholderView({ title: '' }), null)).toBe(
      'hand',
    );
  });

  it('compares the description by its hash, outer blanks ignored', () => {
    expect(
      standing(
        'description',
        filledView({ description: '  A thief who steals secrets.\n' }),
        filledAuto(),
      ),
    ).toBe('auto');
    expect(
      standing(
        'description',
        filledView({ description: 'A thief who steals secrets!' }),
        filledAuto(),
      ),
    ).toBe('hand');
    expect(
      standing('description', filledView({ description: '   ' }), filledAuto()),
    ).toBe('empty');
  });

  it('compares a picture by object key: the same picture echoed back under another host is still auto', () => {
    expect(
      standing(
        'poster',
        filledView({
          posterUrl: 'http://10.0.0.7:8080/movies/images/movie/tmdb-poster.jpg',
        }),
        filledAuto(),
      ),
    ).toBe('auto');
    expect(
      standing('poster', filledView({ posterUrl: '' }), filledAuto()),
    ).toBe('empty');
  });

  it("the list rule: empty, the same set in any order, or staff's", () => {
    const auto = filledAuto();

    expect(standing('cast', filledView({ actorIds: [] }), auto)).toBe('empty');
    expect(
      standing('cast', filledView({ actorIds: ['a-2', 'a-1'] }), auto),
    ).toBe('auto');
    expect(
      standing('cast', filledView({ actorIds: ['a-1', 'a-2', 'a-9'] }), auto),
    ).toBe('hand');
    expect(standing('cast', filledView({ actorIds: ['a-2'] }), auto)).toBe(
      'hand',
    );
    expect(
      standing(
        'categories',
        filledView({ categoryIds: ['c-9'] }),
        filledAuto({ categoryIds: undefined }),
      ),
    ).toBe('hand');
  });

  it('untouched = empty or auto', () => {
    expect(isUntouched('empty')).toBe(true);
    expect(isUntouched('auto')).toBe(true);
    expect(isUntouched('hand')).toBe(false);
  });
});

describe('decideField — what a fill does with one field', () => {
  it('an automatic fill writes untouched fields and never one staff changed', () => {
    for (const field of TMDB_MOVIE_FIELDS) {
      expect(decideField(field, 'empty', true, 'automatic')).toBe('write');
      expect(decideField(field, 'auto', true, 'automatic')).toBe('write');
      expect(decideField(field, 'hand', true, 'automatic')).toBe('skip_hand');
      // Not even to take a value back.
      expect(decideField(field, 'hand', false, 'automatic')).toBe('skip_hand');
    }
  });

  it('a staff apply writes the field it was given, whoever wrote it last', () => {
    for (const field of TMDB_MOVIE_FIELDS) {
      if (field === 'duration') continue;
      expect(decideField(field, 'hand', true, 'staff')).toBe('write');
      expect(decideField(field, 'auto', true, 'staff')).toBe('write');
      expect(decideField(field, 'empty', true, 'staff')).toBe('write');
    }
  });

  it('a runtime that is there and is not the automatic one is never replaced, not even when asked', () => {
    expect(decideField('duration', 'hand', true, 'staff')).toBe('skip_hand');
    expect(decideField('duration', 'hand', true, 'automatic')).toBe(
      'skip_hand',
    );
    expect(decideField('duration', 'empty', true, 'staff')).toBe('write');
    expect(decideField('duration', 'auto', true, 'staff')).toBe('write');
  });

  it('TMDB has no value: an automatic value goes back to its placeholder, anything else is left', () => {
    const resettable = TMDB_MOVIE_FIELDS.filter(
      (field) => field !== 'title' && field !== 'releaseYear',
    );
    for (const field of resettable) {
      expect(decideField(field, 'auto', false, 'automatic')).toBe('reset');
      expect(decideField(field, 'auto', false, 'staff')).toBe('reset');
      expect(decideField(field, 'empty', false, 'automatic')).toBe(
        'skip_no_value',
      );
    }
    // Staff's own value is not taken away because TMDB has none.
    expect(decideField('genre', 'hand', false, 'staff')).toBe('skip_no_value');
  });

  it('the title and the year have no placeholder and are never taken back', () => {
    expect(decideField('title', 'auto', false, 'automatic')).toBe(
      'skip_no_value',
    );
    expect(decideField('releaseYear', 'auto', false, 'staff')).toBe(
      'skip_no_value',
    );
  });
});

describe('previewLineState', () => {
  it.each<[TmdbFieldStanding, boolean, boolean, string]>([
    ['empty', false, false, 'none'],
    ['hand', false, false, 'none'],
    ['auto', true, true, 'same'],
    ['hand', true, true, 'same'],
    ['empty', true, false, 'empty'],
    ['auto', true, false, 'auto'],
    ['hand', true, false, 'hand'],
  ])('%s, TMDB has a value: %p, already equal: %p -> %s', (...args) => {
    const [fieldStands, hasValue, same, state] = args;
    expect(previewLineState(fieldStands, hasValue, same)).toBe(state);
  });
});

describe('mergeAutoList — a list field after a fill', () => {
  it("keeps what staff added, drops the previous match's, adds the new match's", () => {
    expect(
      mergeAutoList(
        ['old-1', 'staff-1', 'old-2', 'staff-2'],
        ['old-1', 'old-2'],
        ['new-1', 'new-2'],
      ),
    ).toEqual(['staff-1', 'staff-2', 'new-1', 'new-2']);
  });

  it('never lists an id twice', () => {
    expect(mergeAutoList(['a', 'b'], undefined, ['b', 'c', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
    // In the old match and in the new one: it stays, once.
    expect(mergeAutoList(['a', 'b'], ['a', 'b'], ['b', 'c'])).toEqual([
      'b',
      'c',
    ]);
  });

  it("with nothing new, only the previous match's entries leave", () => {
    expect(mergeAutoList(['old', 'staff'], ['old'], [])).toEqual(['staff']);
  });
});

describe('applyChanges', () => {
  it('writes each field and remembers it in tmdbAuto', () => {
    const { view, auto } = applyChanges(
      placeholderView(),
      { v: 1, title: 'Inception 2010 1080p', releaseYear: 2026 },
      [
        { field: 'title', value: 'Inception' },
        { field: 'releaseYear', value: 2010 },
        { field: 'description', value: 'A thief who steals secrets.' },
        { field: 'duration', value: 148 },
        { field: 'genre', value: 'Action' },
        { field: 'language', value: 'English' },
        { field: 'country', value: 'English' },
        { field: 'director', value: 'Christopher Nolan' },
        { field: 'ageRating', value: 'PG13' },
        { field: 'poster', value: { url: POSTER, path: '/poster.jpg' } },
        { field: 'cover', value: { url: COVER, path: '/cover.jpg' } },
        { field: 'categories', value: ['c-1', 'c-2'] },
        { field: 'cast', value: ['a-1', 'a-2'] },
      ],
    );

    expect(view).toEqual(filledView());
    expect(auto).toEqual(filledAuto({ match: undefined }));
    // The text of the description is not copied, only its hash.
    expect(JSON.stringify(auto)).not.toContain('A thief');
  });

  it('every field it wrote then stands as auto', () => {
    const { view, auto } = applyChanges(placeholderView(), null, [
      { field: 'description', value: 'Text.' },
      { field: 'genre', value: 'Drama' },
      { field: 'cast', value: ['a-1'] },
    ]);

    expect(standing('description', view, auto)).toBe('auto');
    expect(standing('genre', view, auto)).toBe('auto');
    expect(standing('cast', view, auto)).toBe('auto');
    // Not written, so still what it was.
    expect(standing('language', view, auto)).toBe('empty');
    expect(standing('title', view, auto)).toBe('hand');
  });

  it('a null puts the field back to its empty placeholder and forgets its automatic value', () => {
    const { view, auto } = applyChanges(filledView(), filledAuto(), [
      { field: 'description', value: null },
      { field: 'duration', value: null },
      { field: 'genre', value: null },
      { field: 'language', value: null },
      { field: 'country', value: null },
      { field: 'director', value: null },
      { field: 'ageRating', value: null },
      { field: 'poster', value: null },
      { field: 'cover', value: null },
      { field: 'categories', value: null },
      { field: 'cast', value: null },
    ]);

    expect(view).toEqual(placeholderView());
    expect(auto).toEqual({
      v: 1,
      match: { title: 'Inception', year: 2010 },
      title: 'Inception',
      releaseYear: 2010,
    });
  });

  it("a list change swaps the previous match's entries for the new ones and keeps staff's", () => {
    const { view, auto } = applyChanges(
      filledView({
        categoryIds: ['c-1', 'c-staff', 'c-2'],
        actorIds: ['a-staff', 'a-1', 'a-2'],
      }),
      filledAuto(),
      [
        { field: 'categories', value: ['c-2', 'c-new'] },
        { field: 'cast', value: ['a-new'] },
      ],
    );

    expect(view.categoryIds).toEqual(['c-staff', 'c-2', 'c-new']);
    expect(view.actorIds).toEqual(['a-staff', 'a-new']);
    expect(auto.categoryIds).toEqual(['c-2', 'c-new']);
    expect(auto.actorIds).toEqual(['a-new']);
  });

  it('resetting a list removes only what the previous match put there', () => {
    const { view, auto } = applyChanges(
      filledView({ actorIds: ['a-1', 'a-staff', 'a-2'] }),
      filledAuto(),
      [{ field: 'cast', value: null }],
    );

    expect(view.actorIds).toEqual(['a-staff']);
    expect(auto.actorIds).toBeUndefined();
  });

  it('leaves the fields that are not named, and the objects it was given, exactly as they came', () => {
    const before = filledView();
    const remembered = filledAuto();
    const beforeCopy = structuredClone(before);
    const rememberedCopy = structuredClone(remembered);

    const { view, auto } = applyChanges(before, remembered, [
      { field: 'genre', value: 'Drama' },
    ]);

    expect(view).toEqual({ ...beforeCopy, genre: 'Drama' });
    expect(auto).toEqual({ ...rememberedCopy, genre: 'Drama' });
    expect(before).toEqual(beforeCopy);
    expect(remembered).toEqual(rememberedCopy);
  });

  it('starts a tmdbAuto for a title that had none', () => {
    const { auto } = applyChanges(placeholderView(), null, []);

    expect(auto).toEqual({ v: 1 });
  });
});
