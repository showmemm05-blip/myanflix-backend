import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateHomePromoDto,
  HOME_PROMO_LIMITS,
  HomePromoQueryDto,
  ReorderHomePromosDto,
  UpdateHomePromoDto,
} from './home-promo.dto';
import { UpdateHomeSettingsDto } from './home-settings.dto';

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

const OWN_IMAGE = 'http://192.168.1.5:9000/movies/images/promo/abc.webp';
const UUID = '0b6c3f7e-6a1d-4b2c-9e8f-1a2b3c4d5e6f';

const VALID_CREATE = {
  kind: 'HERO',
  titleEn: 'Go Premium',
  titleMm: 'Premium ယူပါ',
  ctaTarget: 'SUBSCRIBE',
  ctaLabelEn: 'Subscribe',
  ctaLabelMm: 'စာရင်းသွင်းပါ',
  artPreset: 'PREMIUM',
};

describe('CreateHomePromoDto', () => {
  it('accepts a complete hero promo', async () => {
    expect((await errorsOf(CreateHomePromoDto, VALID_CREATE)).fields).toEqual(
      [],
    );
  });

  it('requires kind and both titles', async () => {
    expect((await errorsOf(CreateHomePromoDto, {})).fields).toEqual([
      'kind',
      'titleEn',
      'titleMm',
    ]);
  });

  it('trims titles and refuses a blank one', async () => {
    const { instance, fields } = await errorsOf(CreateHomePromoDto, {
      ...VALID_CREATE,
      titleEn: '  Go Premium  ',
      titleMm: '   ',
    });
    expect(instance.titleEn).toBe('Go Premium');
    expect(fields).toEqual(['titleMm']);
  });

  it('refuses unknown enums and unknown fields (forbidNonWhitelisted)', async () => {
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          kind: 'BANNER',
          ctaTarget: 'PLAY',
          artPreset: 'NEON',
          sortOrder: 4,
        })
      ).fields,
    ).toEqual(['artPreset', 'ctaTarget', 'kind', 'sortOrder']);
  });

  it('enforces the maximum lengths', async () => {
    const long = (n: number) => 'x'.repeat(n + 1);
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          titleEn: long(HOME_PROMO_LIMITS.title),
          kickerEn: long(HOME_PROMO_LIMITS.kicker),
          bodyMm: long(HOME_PROMO_LIMITS.body),
          ctaLabelEn: long(HOME_PROMO_LIMITS.ctaLabel),
          dateText: long(HOME_PROMO_LIMITS.dateText),
        })
      ).fields,
    ).toEqual(['bodyMm', 'ctaLabelEn', 'dateText', 'kickerEn', 'titleEn']);
  });

  it('accepts http and https links, LAN hosts included, and nothing else', async () => {
    for (const url of [
      'https://myanflix.example/offer',
      'http://192.168.1.5:3003/premium',
      'http://localhost:3003',
    ]) {
      expect(
        (await errorsOf(CreateHomePromoDto, { ...VALID_CREATE, url })).fields,
      ).toEqual([]);
    }
    for (const url of [
      'javascript:alert(1)',
      'ftp://files.example/x',
      'myanflix.example/no-protocol',
      `https://example.com/${'a'.repeat(HOME_PROMO_LIMITS.url)}`,
    ]) {
      expect(
        (await errorsOf(CreateHomePromoDto, { ...VALID_CREATE, url })).fields,
      ).toEqual(['url']);
    }
  });

  it('accepts only our own uploaded image URLs (payment-logo rule)', async () => {
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          imageUrl: OWN_IMAGE,
        })
      ).fields,
    ).toEqual([]);
    for (const imageUrl of [
      'https://evil.example/beacon.gif',
      'http://192.168.1.5:9000/movies/videos/x/original.mp4',
      'http://192.168.1.5:9000/movies/images/user/u1/1.png',
    ]) {
      expect(
        (await errorsOf(CreateHomePromoDto, { ...VALID_CREATE, imageUrl }))
          .fields,
      ).toEqual(['imageUrl']);
    }
  });

  it('turns blank optional texts into null', async () => {
    const { instance, fields } = await errorsOf(CreateHomePromoDto, {
      ...VALID_CREATE,
      kickerEn: '   ',
      imageUrl: '',
      startsAt: '',
    });
    expect(fields).toEqual([]);
    expect(instance.kickerEn).toBeNull();
    expect(instance.imageUrl).toBeNull();
    expect(instance.startsAt).toBeNull();
  });

  it('requires strict ISO timestamps for the window', async () => {
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          startsAt: '2026-10-08T00:00:00.000Z',
          endsAt: '2026-10-31T17:30:00+06:30',
        })
      ).fields,
    ).toEqual([]);
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          startsAt: 'next friday',
          endsAt: '2026-02-30T00:00:00Z',
        })
      ).fields,
    ).toEqual(['endsAt', 'startsAt']);
  });

  it('requires targetId to be a UUID', async () => {
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          ctaTarget: 'MOVIE',
          targetId: 'not-a-uuid',
        })
      ).fields,
    ).toEqual(['targetId']);
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          ctaTarget: 'MOVIE',
          targetId: UUID,
        })
      ).fields,
    ).toEqual([]);
  });

  it('reads isActive the way a human does and refuses junk', async () => {
    const off = await errorsOf(CreateHomePromoDto, {
      ...VALID_CREATE,
      isActive: 'false',
    });
    expect(off.fields).toEqual([]);
    expect(off.instance.isActive).toBe(false);
    expect(
      (
        await errorsOf(CreateHomePromoDto, {
          ...VALID_CREATE,
          isActive: 'maybe',
        })
      ).fields,
    ).toEqual(['isActive']);
  });
});

describe('UpdateHomePromoDto', () => {
  it('accepts an empty patch and yields no defined field (F-002)', async () => {
    const { instance, fields } = await errorsOf(UpdateHomePromoDto, {});
    expect(fields).toEqual([]);
    expect(
      Object.entries(instance).filter(([, value]) => value !== undefined),
    ).toEqual([]);
  });

  it('refuses an explicit null for the fields that cannot be empty', async () => {
    expect(
      (
        await errorsOf(UpdateHomePromoDto, {
          titleEn: null,
          titleMm: '',
          ctaTarget: null,
          artPreset: null,
          isActive: null,
        })
      ).fields,
    ).toEqual(['artPreset', 'ctaTarget', 'isActive', 'titleEn', 'titleMm']);
  });

  it('lets null clear the optional fields', async () => {
    expect(
      (
        await errorsOf(UpdateHomePromoDto, {
          kickerEn: null,
          kickerMm: null,
          targetId: null,
          url: null,
          imageUrl: null,
          dateText: null,
          startsAt: null,
          endsAt: null,
        })
      ).fields,
    ).toEqual([]);
  });

  it('cannot move a promo to another kind', async () => {
    expect(
      (await errorsOf(UpdateHomePromoDto, { kind: 'SPOTLIGHT' })).fields,
    ).toEqual(['kind']);
  });
});

describe('ReorderHomePromosDto', () => {
  it('accepts a kind and a list of unique UUIDs', async () => {
    expect(
      (await errorsOf(ReorderHomePromosDto, { kind: 'HERO', ids: [UUID] }))
        .fields,
    ).toEqual([]);
  });

  it('refuses duplicates, non-UUIDs and a missing kind', async () => {
    expect(
      (await errorsOf(ReorderHomePromosDto, { ids: [UUID, UUID] })).fields,
    ).toEqual(['ids', 'kind']);
    expect(
      (await errorsOf(ReorderHomePromosDto, { kind: 'HERO', ids: ['x'] }))
        .fields,
    ).toEqual(['ids']);
  });
});

describe('HomePromoQueryDto', () => {
  it('takes an optional kind filter', async () => {
    expect((await errorsOf(HomePromoQueryDto, {})).fields).toEqual([]);
    expect(
      (await errorsOf(HomePromoQueryDto, { kind: 'COMING_SOON' })).fields,
    ).toEqual([]);
    expect((await errorsOf(HomePromoQueryDto, { kind: 'x' })).fields).toEqual([
      'kind',
    ]);
  });
});

describe('UpdateHomeSettingsDto', () => {
  it('accepts the full settings', async () => {
    expect(
      (
        await errorsOf(UpdateHomeSettingsDto, {
          webUrl: 'https://myanflix.example',
          appStoreUrl: 'https://apps.apple.com/app/id1',
          playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
          gamesTeaserEnabled: true,
          gamesTeaserDateText: '2027',
        })
      ).fields,
    ).toEqual([]);
  });

  it('requires gamesTeaserEnabled and nothing else', async () => {
    expect((await errorsOf(UpdateHomeSettingsDto, {})).fields).toEqual([
      'gamesTeaserEnabled',
    ]);
    expect(
      (await errorsOf(UpdateHomeSettingsDto, { gamesTeaserEnabled: false }))
        .fields,
    ).toEqual([]);
  });

  it('refuses non-http links and turns blanks into null', async () => {
    const { instance, fields } = await errorsOf(UpdateHomeSettingsDto, {
      gamesTeaserEnabled: true,
      webUrl: 'javascript:alert(1)',
      appStoreUrl: '  ',
      gamesTeaserDateText: '',
    });
    expect(fields).toEqual(['webUrl']);
    expect(instance.appStoreUrl).toBeNull();
    expect(instance.gamesTeaserDateText).toBeNull();
  });
});
