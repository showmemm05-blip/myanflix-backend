import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminWinnersQueryDto,
  PUBLIC_WINNERS_LIMIT_DEFAULT,
  PUBLIC_WINNERS_LIMIT_MAX,
  PublicWinnersQueryDto,
  PublishDrawDto,
  PublishPreviewQueryDto,
} from './lottery-publish.dto';

/** The same options as the global ValidationPipe in app.module.ts. */
const TRANSFORM = { enableImplicitConversion: true } as const;

async function errorsOf<T extends object>(
  Dto: new () => T,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(Dto, body, TRANSFORM);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, fields: errors.map((e) => e.property).sort() };
}

describe('PublishDrawDto / PublishPreviewQueryDto', () => {
  it.each([PublishDrawDto, PublishPreviewQueryDto])(
    '%p accepts no rate, or a positive rate with up to four decimals (a numeric string too)',
    async (Dto) => {
      expect((await errorsOf(Dto, {})).fields).toEqual([]);
      const { instance, fields } = await errorsOf(Dto, {
        exchangeRate: '75.1234',
      });
      expect(fields).toEqual([]);
      expect(instance).toEqual({ exchangeRate: 75.1234 });
      expect((await errorsOf(Dto, { exchangeRate: 1 })).fields).toEqual([]);
    },
  );

  it.each([PublishDrawDto, PublishPreviewQueryDto])(
    '%p refuses a zero, negative, five-decimal, oversized or non-numeric rate, and an unknown field',
    async (Dto) => {
      for (const exchangeRate of [
        0,
        -1,
        75.12345,
        10_001,
        100_000_000,
        'abc',
      ]) {
        expect((await errorsOf(Dto, { exchangeRate })).fields).toEqual([
          'exchangeRate',
        ]);
      }
      expect((await errorsOf(Dto, { rate: 75 })).fields).toEqual(['rate']);
    },
  );
});

describe('AdminWinnersQueryDto', () => {
  it('defaults to page 1 of 20 with no search, trims the search and reads numeric strings', async () => {
    const empty = await errorsOf(AdminWinnersQueryDto, {});
    expect(empty.fields).toEqual([]);
    expect(empty.instance).toEqual({ page: 1, pageSize: 20 });

    const { instance, fields } = await errorsOf(AdminWinnersQueryDto, {
      q: '  mya ',
      page: '3',
      pageSize: '200',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({ q: 'mya', page: 3, pageSize: 200 });

    const blank = await errorsOf(AdminWinnersQueryDto, { q: '   ' });
    expect(blank.fields).toEqual([]);
    expect(blank.instance.q).toBeNull();
  });

  it('refuses page 0, a page size over 200, a long search and an unknown field', async () => {
    expect((await errorsOf(AdminWinnersQueryDto, { page: 0 })).fields).toEqual([
      'page',
    ]);
    expect(
      (await errorsOf(AdminWinnersQueryDto, { pageSize: 201 })).fields,
    ).toEqual(['pageSize']);
    expect(
      (await errorsOf(AdminWinnersQueryDto, { q: 'x'.repeat(101) })).fields,
    ).toEqual(['q']);
    expect(
      (await errorsOf(AdminWinnersQueryDto, { status: 'won' })).fields,
    ).toEqual(['status']);
  });
});

describe('PublicWinnersQueryDto', () => {
  it('defaults the limit to 20 and allows up to 50', async () => {
    expect(PUBLIC_WINNERS_LIMIT_DEFAULT).toBe(20);
    expect(PUBLIC_WINNERS_LIMIT_MAX).toBe(50);
    const empty = await errorsOf(PublicWinnersQueryDto, {});
    expect(empty.fields).toEqual([]);
    expect(empty.instance).toEqual({ limit: 20 });
    const { instance, fields } = await errorsOf(PublicWinnersQueryDto, {
      limit: '50',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({ limit: 50 });
  });

  it('refuses a limit of 0, over 50, a fraction, a word, and an unknown field', async () => {
    for (const limit of [0, 51, 2.5, 'abc']) {
      expect((await errorsOf(PublicWinnersQueryDto, { limit })).fields).toEqual(
        ['limit'],
      );
    }
    expect((await errorsOf(PublicWinnersQueryDto, { page: 1 })).fields).toEqual(
      ['page'],
    );
  });
});
