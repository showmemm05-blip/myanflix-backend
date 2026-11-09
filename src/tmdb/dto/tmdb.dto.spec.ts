import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { TMDB_MOVIE_FIELDS, TMDB_SERIES_FIELDS } from '../tmdb.types';
import {
  ApplyMovieTmdbDto,
  ApplySeriesTmdbDto,
  TMDB_STATE_IDS_MAX,
  TmdbEntryDto,
  TmdbMovieStatesQueryDto,
  TmdbSearchQueryDto,
  TmdbStatusQueryDto,
} from './tmdb.dto';

const uuid = (n: number) =>
  `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

/**
 * Validates the way the global pipe does: implicit conversion on (a query
 * string arrives as text), unknown properties refused.
 */
async function check<T extends object>(
  dto: ClassConstructor<T>,
  input: Record<string, unknown>,
): Promise<{ value: T; failed: string[] }> {
  const value = plainToInstance(dto, input, {
    enableImplicitConversion: true,
  });
  const errors = await validate(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { value, failed: errors.map((error) => error.property).sort() };
}

describe('TmdbStatusQueryDto — GET /tmdb/status', () => {
  it('fresh is optional; ?fresh=1 and ?fresh=true mean "Check again"', async () => {
    expect((await check(TmdbStatusQueryDto, {})).failed).toEqual([]);
    for (const fresh of ['1', 'true', true]) {
      const { value, failed } = await check(TmdbStatusQueryDto, { fresh });
      expect(failed).toEqual([]);
      expect(value.fresh).toBe(true);
    }
    for (const fresh of ['0', 'false']) {
      const { value, failed } = await check(TmdbStatusQueryDto, { fresh });
      expect(failed).toEqual([]);
      expect(value.fresh).toBe(false);
    }
  });

  it('refuses anything that is not a yes or a no', async () => {
    for (const fresh of ['yes', '', '2']) {
      expect((await check(TmdbStatusQueryDto, { fresh })).failed).toEqual([
        'fresh',
      ]);
    }
  });
});

describe('TmdbSearchQueryDto — GET /tmdb/search/*', () => {
  it('takes a name of 1 to 200 characters, outer blanks removed', async () => {
    const { value, failed } = await check(TmdbSearchQueryDto, {
      query: '  Inception  ',
    });

    expect(failed).toEqual([]);
    expect(value.query).toBe('Inception');
    expect(value.year).toBeUndefined();
    expect(
      (await check(TmdbSearchQueryDto, { query: 'x'.repeat(200) })).failed,
    ).toEqual([]);
  });

  it.each([
    ['missing', {}],
    ['empty', { query: '' }],
    ['only blanks', { query: '    ' }],
    ['too long', { query: 'x'.repeat(201) }],
  ])('refuses a name that is %s', async (_label, input) => {
    expect((await check(TmdbSearchQueryDto, input)).failed).toEqual(['query']);
  });

  it('reads the year from the query string as a number, 1888 to 2100', async () => {
    const { value, failed } = await check(TmdbSearchQueryDto, {
      query: 'Inception',
      year: '2010',
    });

    expect(failed).toEqual([]);
    expect(value.year).toBe(2010);
    for (const year of ['1888', '2100']) {
      expect(
        (await check(TmdbSearchQueryDto, { query: 'x', year })).failed,
      ).toEqual([]);
    }
  });

  it.each(['1887', '2101', '20.5', 'soon', '-2010'])(
    'refuses the year %p',
    async (year) => {
      expect(
        (await check(TmdbSearchQueryDto, { query: 'x', year })).failed,
      ).toEqual(['year']);
    },
  );

  it('refuses a property it does not know — no picture address or TMDB path can ride along', async () => {
    expect(
      (
        await check(TmdbSearchQueryDto, {
          query: 'x',
          imageUrl: 'https://evil.example/x.jpg',
        })
      ).failed,
    ).toEqual(['imageUrl']);
  });
});

describe('TmdbMovieStatesQueryDto — GET /tmdb/movies/state', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, index) => uuid(index + 1)).join(',');

  it('reads comma separated ids', async () => {
    const { value, failed } = await check(TmdbMovieStatesQueryDto, {
      ids: ` ${uuid(1)}, ${uuid(2)} ,`,
    });

    expect(failed).toEqual([]);
    expect(value.ids).toEqual([uuid(1), uuid(2)]);
  });

  it(`takes 1 to ${TMDB_STATE_IDS_MAX} ids`, async () => {
    expect(
      (await check(TmdbMovieStatesQueryDto, { ids: ids(1) })).failed,
    ).toEqual([]);
    expect(
      (await check(TmdbMovieStatesQueryDto, { ids: ids(TMDB_STATE_IDS_MAX) }))
        .failed,
    ).toEqual([]);
    expect(
      (
        await check(TmdbMovieStatesQueryDto, {
          ids: ids(TMDB_STATE_IDS_MAX + 1),
        })
      ).failed,
    ).toEqual(['ids']);
  });

  it.each([
    ['missing', {}],
    ['empty', { ids: '' }],
    ['only commas', { ids: ',,' }],
    ['not uuids', { ids: `${uuid(1)},not-a-uuid` }],
  ])('refuses ids that are %s', async (_label, input) => {
    expect((await check(TmdbMovieStatesQueryDto, input)).failed).toEqual([
      'ids',
    ]);
  });
});

describe('TmdbEntryDto — the TMDB entry of a preview or a new series', () => {
  it('takes a positive whole number', async () => {
    expect((await check(TmdbEntryDto, { tmdbId: 27205 })).failed).toEqual([]);
    expect((await check(TmdbEntryDto, { tmdbId: 1 })).failed).toEqual([]);
    expect((await check(TmdbEntryDto, { tmdbId: 2147483647 })).failed).toEqual(
      [],
    );
  });

  it.each([
    ['missing', {}],
    ['zero', { tmdbId: 0 }],
    ['negative', { tmdbId: -1 }],
    ['a fraction', { tmdbId: 1.5 }],
    ['a path', { tmdbId: '/movie/27205' }],
    ['an address', { tmdbId: 'https://api.themoviedb.org/3/movie/27205' }],
    ['null', { tmdbId: null }],
    ['larger than the tmdbId column can hold', { tmdbId: 2147483648 }],
  ])('refuses an id that is %s', async (_label, input) => {
    expect((await check(TmdbEntryDto, input)).failed).toEqual(['tmdbId']);
  });
});

describe('ApplyMovieTmdbDto / ApplySeriesTmdbDto — POST .../apply', () => {
  it('a movie may name any of its thirteen details', async () => {
    expect(
      (
        await check(ApplyMovieTmdbDto, {
          tmdbId: 27205,
          fields: [...TMDB_MOVIE_FIELDS],
        })
      ).failed,
    ).toEqual([]);
  });

  it('a series may name its ten — not a runtime, a director or an age rating', async () => {
    expect(
      (
        await check(ApplySeriesTmdbDto, {
          tmdbId: 66732,
          fields: [...TMDB_SERIES_FIELDS],
        })
      ).failed,
    ).toEqual([]);
    for (const field of ['duration', 'director', 'ageRating']) {
      expect(
        (await check(ApplySeriesTmdbDto, { tmdbId: 66732, fields: [field] }))
          .failed,
      ).toEqual(['fields']);
    }
  });

  it('an empty list is allowed: it links the title and writes no detail', async () => {
    expect(
      (await check(ApplyMovieTmdbDto, { tmdbId: 27205, fields: [] })).failed,
    ).toEqual([]);
  });

  it.each([
    ['missing', { tmdbId: 1 }],
    ['not a list', { tmdbId: 1, fields: 'title' }],
    ['a detail named twice', { tmdbId: 1, fields: ['title', 'title'] }],
    // Never writable through TMDB, whatever the caller asks for.
    ['the status', { tmdbId: 1, fields: ['status'] }],
    ['Free or paid', { tmdbId: 1, fields: ['accessType'] }],
    ['the star rating', { tmdbId: 1, fields: ['rating'] }],
    ['the Burmese description', { tmdbId: 1, fields: ['descriptionMm'] }],
    ['the thumbnail', { tmdbId: 1, fields: ['thumbnailUrl'] }],
    ['a column name instead of a detail', { tmdbId: 1, fields: ['posterUrl'] }],
  ])('refuses fields that are %s', async (_label, input) => {
    expect((await check(ApplyMovieTmdbDto, input)).failed).toEqual(['fields']);
    expect((await check(ApplySeriesTmdbDto, input)).failed).toEqual(['fields']);
  });

  it('still needs the TMDB id, and refuses a property it does not know', async () => {
    expect((await check(ApplyMovieTmdbDto, { fields: [] })).failed).toEqual([
      'tmdbId',
    ]);
    expect(
      (
        await check(ApplyMovieTmdbDto, {
          tmdbId: 1,
          fields: [],
          posterUrl: 'https://evil.example/x.jpg',
        })
      ).failed,
    ).toEqual(['posterUrl']);
  });
});
