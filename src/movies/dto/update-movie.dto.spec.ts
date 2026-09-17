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
