import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminDreamQueryDto,
  DreamQueryDto,
  ExportDreamsQueryDto,
  ImportDreamsQueryDto,
  LOTTERY_DREAM_LIMITS,
  UpdateLotteryDreamDto,
} from './lottery-dream.dto';

/**
 * The same options as the global ValidationPipe in app.module.ts, so these
 * cases see exactly what a real request sees.
 */
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

const OWN_IMAGE = 'http://192.168.1.5:9000/movies/images/lottery/abc.webp';

describe('UpdateLotteryDreamDto', () => {
  it('accepts an empty body (nothing to change) with no defined field', async () => {
    const { instance, fields } = await errorsOf(UpdateLotteryDreamDto, {});
    expect(fields).toEqual([]);
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('trims names and turns a blank one into null (clear)', async () => {
    const { instance, fields } = await errorsOf(UpdateLotteryDreamDto, {
      nameEn: '  Snake ',
      nameMy: '   ',
    });
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({ nameEn: 'Snake', nameMy: null });
  });

  it('refuses a name over the limit and a non-string name', async () => {
    expect(
      (
        await errorsOf(UpdateLotteryDreamDto, {
          nameEn: 'x'.repeat(LOTTERY_DREAM_LIMITS.name + 1),
          nameMy: 7,
        })
      ).fields,
    ).toEqual(['nameEn', 'nameMy']);
  });

  it('takes only one of our own uploaded images as the picture, or null to clear it', async () => {
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { pictureUrl: OWN_IMAGE })).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { pictureUrl: '' })).instance
        .pictureUrl,
    ).toBeNull();
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { pictureUrl: null })).fields,
    ).toEqual([]);
    for (const bad of [
      'https://evil.example/beacon.gif',
      'http://192.168.1.5:9000/movies/videos/x/original.mp4',
      'http://192.168.1.5:9000/movies/images/user/u1/1.webp',
      'not a url',
    ]) {
      expect(
        (await errorsOf(UpdateLotteryDreamDto, { pictureUrl: bad })).fields,
      ).toEqual(['pictureUrl']);
    }
  });

  it('reads the switch as a real boolean and refuses null or junk', async () => {
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { isActive: 'false' })).instance
        .isActive,
    ).toBe(false);
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { isActive: true })).instance
        .isActive,
    ).toBe(true);
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { isActive: null })).fields,
    ).toEqual(['isActive']);
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { isActive: 'maybe' })).fields,
    ).toEqual(['isActive']);
  });

  it('refuses the fields a dream cannot change', async () => {
    expect(
      (await errorsOf(UpdateLotteryDreamDto, { book: '100', number: '07' }))
        .fields,
    ).toEqual(['book', 'number']);
  });
});

describe('DreamQueryDto', () => {
  it('needs a book and trims the search', async () => {
    expect((await errorsOf(DreamQueryDto, {})).fields).toEqual(['book']);
    expect((await errorsOf(DreamQueryDto, { book: '10' })).fields).toEqual([
      'book',
    ]);
    const { instance, fields } = await errorsOf(DreamQueryDto, {
      book: '100',
      q: ' sn ',
    });
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({ book: '100', q: 'sn' });
  });

  it('treats a blank search as no search', async () => {
    expect(
      (await errorsOf(DreamQueryDto, { book: '1000', q: '  ' })).instance.q,
    ).toBeNull();
  });
});

describe('AdminDreamQueryDto', () => {
  it('defaults to page 1 of 50, every book, every row', async () => {
    const { instance, fields } = await errorsOf(AdminDreamQueryDto, {});
    expect(fields).toEqual([]);
    expect(instance).toMatchObject({ page: 1, pageSize: 50 });
    expect(instance.book).toBeUndefined();
    expect(instance.filter).toBeUndefined();
  });

  it('reads the query strings as numbers and caps the page size at 100', async () => {
    const ok = await errorsOf(AdminDreamQueryDto, {
      page: '3',
      pageSize: '100',
      filter: 'missing_picture',
      book: '1000',
    });
    expect(ok.fields).toEqual([]);
    expect(ok.instance).toMatchObject({
      page: 3,
      pageSize: 100,
      filter: 'missing_picture',
      book: '1000',
    });
    expect(
      (await errorsOf(AdminDreamQueryDto, { pageSize: '101', page: '0' }))
        .fields,
    ).toEqual(['page', 'pageSize']);
    expect(
      (await errorsOf(AdminDreamQueryDto, { filter: 'named' })).fields,
    ).toEqual(['filter']);
  });
});

describe('ImportDreamsQueryDto / ExportDreamsQueryDto', () => {
  it('reads dryRun as a boolean and leaves it undefined when absent', async () => {
    expect(
      (await errorsOf(ImportDreamsQueryDto, { dryRun: 'true' })).instance
        .dryRun,
    ).toBe(true);
    expect(
      (await errorsOf(ImportDreamsQueryDto, { dryRun: '0' })).instance.dryRun,
    ).toBe(false);
    expect(
      (await errorsOf(ImportDreamsQueryDto, {})).instance.dryRun,
    ).toBeUndefined();
    expect(
      (await errorsOf(ImportDreamsQueryDto, { dryRun: 'maybe' })).fields,
    ).toEqual(['dryRun']);
  });

  it('exports one named book', async () => {
    expect((await errorsOf(ExportDreamsQueryDto, {})).fields).toEqual(['book']);
    expect(
      (await errorsOf(ExportDreamsQueryDto, { book: '100' })).fields,
    ).toEqual([]);
  });
});
