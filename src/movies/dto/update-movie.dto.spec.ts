import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccessType, MovieStatus } from '../../generated/prisma/client';
import { CreateMovieDto } from './create-movie.dto';
import { UpdateMovieDto } from './update-movie.dto';

/**
 * F-002: a partial PUT must not resurrect a create-time default. The field is
 * asserted as "undefined / not an own property" rather than via Object.keys —
 * tsconfig targets ES2023, so every declared field is an own `undefined` prop.
 */
describe('UpdateMovieDto — no inherited accessType default', () => {
  it('{status: PUBLISHED} leaves accessType untouched and validates', async () => {
    const instance = plainToInstance(UpdateMovieDto, {
      status: MovieStatus.PUBLISHED,
    });

    expect(instance.accessType).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(instance, 'accessType')).toBe(
      false,
    );
    expect(await validate(instance)).toHaveLength(0);
  });

  it('{} carries no defined value at all', () => {
    const instance = plainToInstance(UpdateMovieDto, {}) as Record<
      string,
      unknown
    >;
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('keeps an explicit accessType', async () => {
    const instance = plainToInstance(UpdateMovieDto, {
      accessType: AccessType.FREE,
    });

    expect(instance.accessType).toBe(AccessType.FREE);
    expect(await validate(instance)).toHaveLength(0);
  });
});

describe('CreateMovieDto — accessType default belongs to Prisma', () => {
  it('leaves accessType undefined when the body omits it', async () => {
    const instance = plainToInstance(CreateMovieDto, {
      title: 'T',
      description: 'D',
      genre: 'Drama',
      language: 'en',
      releaseYear: 2024,
      duration: 100,
    });

    expect(instance.accessType).toBeUndefined();
    expect(await validate(instance)).toHaveLength(0);
  });
});

describe('UpdateMovieDto — rating', () => {
  it.each([0, 7.5, 10])('accepts %s', async (rating) => {
    const instance = plainToInstance(UpdateMovieDto, { rating });
    expect(instance.rating).toBe(rating);
    expect(await validate(instance)).toHaveLength(0);
  });

  it.each([-0.1, 10.1, 7.55])('rejects %s', async (rating) => {
    const errors = await validate(plainToInstance(UpdateMovieDto, { rating }));
    expect(errors.map((e) => e.property)).toEqual(['rating']);
  });

  it('coerces the string a form posts', async () => {
    const instance = plainToInstance(UpdateMovieDto, { rating: '8.2' });
    expect(instance.rating).toBe(8.2);
    expect(await validate(instance)).toHaveLength(0);
  });

  it('null clears to 0 instead of reaching the NOT NULL column', async () => {
    const instance = plainToInstance(UpdateMovieDto, { rating: null });
    expect(instance.rating).toBe(0);
    expect(await validate(instance)).toHaveLength(0);
  });

  it('omitted stays undefined so a partial PUT never zeroes it', async () => {
    const instance = plainToInstance(UpdateMovieDto, { title: 'T' });
    expect(instance.rating).toBeUndefined();
    expect(await validate(instance)).toHaveLength(0);
  });
});
