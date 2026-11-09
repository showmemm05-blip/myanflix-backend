import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccessType, MovieStatus } from '../../generated/prisma/client';
import { CreateMovieDto } from './create-movie.dto';
import { CreateUploadPlaceholderDto } from './create-upload-placeholder.dto';
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

/**
 * One description per language (owner, 2026-11-06). The DTOs only bound the
 * two texts; "at least one of them" is the service's rule, because on an
 * update it depends on what the row already holds.
 */
describe('CreateMovieDto / UpdateMovieDto — the description in each language', () => {
  const required = {
    title: 'T',
    genre: 'Drama',
    language: 'en',
    releaseYear: 2024,
    duration: 100,
  };
  const problems = async (dto: object) =>
    (await validate(dto)).map((error) => error.property);

  it('create accepts both texts, and a Burmese-only title (an empty English text)', async () => {
    expect(
      await problems(
        plainToInstance(CreateMovieDto, {
          ...required,
          description: 'A thief.',
          descriptionMm: 'သူခိုးတစ်ယောက်',
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        plainToInstance(CreateMovieDto, {
          ...required,
          description: '',
          descriptionMm: 'သူခိုးတစ်ယောက်',
        }),
      ),
    ).toEqual([]);
  });

  it('create still needs the description field itself — it may be empty, not missing', async () => {
    expect(await problems(plainToInstance(CreateMovieDto, required))).toEqual([
      'description',
    ]);
  });

  it('descriptionMm is optional, and "" is accepted so the box can be cleared', async () => {
    expect(
      await problems(plainToInstance(UpdateMovieDto, { descriptionMm: '' })),
    ).toEqual([]);
    expect(await problems(plainToInstance(UpdateMovieDto, {}))).toEqual([]);
    expect(
      plainToInstance(UpdateMovieDto, { title: 'T' }).descriptionMm,
    ).toBeUndefined();
  });

  it('update accepts an empty English description (the Burmese one may be the only one)', async () => {
    expect(
      await problems(plainToInstance(UpdateMovieDto, { description: '' })),
    ).toEqual([]);
  });

  it.each(['description', 'descriptionMm'])(
    '%s takes 4000 characters and refuses 4001',
    async (field) => {
      expect(
        await problems(
          plainToInstance(UpdateMovieDto, { [field]: 'မ'.repeat(4000) }),
        ),
      ).toEqual([]);
      expect(
        await problems(
          plainToInstance(UpdateMovieDto, { [field]: 'မ'.repeat(4001) }),
        ),
      ).toEqual([field]);
    },
  );

  it.each([42, ['x'], { text: 'x' }])(
    'refuses a descriptionMm that is not text (%p)',
    async (descriptionMm) => {
      expect(
        await problems(plainToInstance(UpdateMovieDto, { descriptionMm })),
      ).toEqual(['descriptionMm']);
    },
  );
});

describe('CreateUploadPlaceholderDto — the folder name', () => {
  const problems = async (body: object) =>
    (await validate(plainToInstance(CreateUploadPlaceholderDto, body))).map(
      (error) => error.property,
    );

  it('is optional — an admin build that predates it sends only the title', async () => {
    expect(await problems({ title: 'Inception 2010' })).toEqual([]);
  });

  it('accepts a raw folder name of up to 255 characters, dots and brackets included', async () => {
    expect(
      await problems({
        title: 'Inception 2010 1080p BluRay x264 YIFY',
        sourceName: 'Inception.2010.1080p.BluRay.x264-[YIFY]',
      }),
    ).toEqual([]);
    expect(await problems({ title: 'T', sourceName: 'x'.repeat(255) })).toEqual(
      [],
    );
  });

  it.each([
    ['256 characters', 'x'.repeat(256)],
    ['a number', 2010],
    ['a list', ['Inception']],
  ])('refuses %s', async (_what, sourceName) => {
    expect(await problems({ title: 'T', sourceName })).toEqual(['sourceName']);
  });
});
