import { Test, TestingModule } from '@nestjs/testing';
import {
  HomePromoArtPreset,
  HomePromoCtaTarget,
  HomePromoKind,
  MovieStatus,
  Role,
  type HomePromo,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateHomePromoDto,
  UpdateHomePromoDto,
} from './dto/home-promo.dto';
import {
  HOME_PROMO_ERRORS,
  HOME_SETTINGS_LOCK_NAMESPACE,
  HomePromosService,
  homePromoListLockKey,
  liveStateOf,
} from './home-promos.service';
import { HomeShowcaseService } from './home-showcase.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const actor = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const PROMO_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

function makePromo(overrides: Partial<HomePromo> = {}) {
  return {
    id: PROMO_ID,
    kind: HomePromoKind.HERO,
    titleEn: 'Go Premium',
    titleMm: 'Premium ယူပါ',
    kickerEn: null,
    kickerMm: null,
    bodyEn: null,
    bodyMm: null,
    ctaLabelEn: 'Subscribe',
    ctaLabelMm: 'စာရင်းသွင်းပါ',
    ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
    targetId: null,
    url: null,
    artPreset: HomePromoArtPreset.PREMIUM,
    imageUrl: null,
    dateText: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    sortOrder: 0,
    createdById: 'admin-1',
    createdAt: new Date('2026-10-08T00:00:00Z'),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
    createdBy: { id: 'admin-1', username: 'admin.blake', displayName: null },
    ...overrides,
  };
}

const heroDto = (
  overrides: Partial<CreateHomePromoDto> = {},
): CreateHomePromoDto => ({
  kind: HomePromoKind.HERO,
  titleEn: 'Go Premium',
  titleMm: 'Premium ယူပါ',
  ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
  ctaLabelEn: 'Subscribe',
  ctaLabelMm: 'စာရင်းသွင်းပါ',
  ...overrides,
});

const movieRow = {
  id: MOVIE_ID,
  title: 'Paper Lanterns',
  description: 'A film',
  posterUrl: 'STORED/poster.jpg',
  coverUrl: null,
  thumbnailUrl: null,
  genre: 'Drama',
  releaseYear: 2026,
  duration: 100,
  rating: 8,
  accessType: 'FREE',
  ageRating: null,
};

/** Catches the coded error a promise rejects with. */
async function codedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('HomePromosService', () => {
  let service: HomePromosService;
  let prisma: {
    homePromo: Record<
      'findMany' | 'findUnique' | 'create' | 'update' | 'delete' | 'aggregate',
      jest.Mock
    >;
    homeSettings: Record<'findFirst' | 'create' | 'update', jest.Mock>;
    movie: { findMany: jest.Mock };
    series: { findMany: jest.Mock };
    book: { findMany: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let showcase: { invalidate: jest.Mock };
  let minio: { imageUrl: jest.Mock; canonicalImageUrl: jest.Mock };

  beforeEach(async () => {
    prisma = {
      homePromo: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _max: { sortOrder: null },
        }),
      },
      homeSettings: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      series: { findMany: jest.fn().mockResolvedValue([]) },
      book: { findMany: jest.fn().mockResolvedValue([]) },
      // The interactive transaction hands the same mock back as `tx`.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    showcase = { invalidate: jest.fn() };
    minio = {
      // Re-hosting is visible in the output: STORED -> REQUEST.
      imageUrl: jest.fn((url: string | null) =>
        url ? url.replace('STORED', 'REQUEST') : null,
      ),
      canonicalImageUrl: jest.fn((url: string | null) =>
        url ? url.replace('REQUEST', 'STORED') : url,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HomePromosService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: HomeShowcaseService, useValue: showcase },
        { provide: MinioService, useValue: minio },
      ],
    }).compile();

    service = module.get(HomePromosService);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.homePromo.create.mockImplementation(
        ({ data }: { data: Partial<HomePromo> }) =>
          Promise.resolve(makePromo({ ...data, id: PROMO_ID })),
      );
    });

    it('applies the defaults, appends to its kind, stamps the creator, audits and drops the cache', async () => {
      prisma.homePromo.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _max: { sortOrder: 4 },
      });

      const result = await service.create(heroDto(), actor);

      const { data } = prisma.homePromo.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        kind: HomePromoKind.HERO,
        ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
        artPreset: HomePromoArtPreset.GENERIC,
        isActive: true,
        sortOrder: 5,
        createdById: 'admin-1',
        targetId: null,
        url: null,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'home_promo.create',
          actor,
          target: { type: 'home_promo', id: PROMO_ID, label: 'Go Premium' },
          after: expect.objectContaining({ kind: 'HERO' }) as unknown,
        }),
      );
      expect(audit.record.mock.calls[0][0]).not.toHaveProperty('before');
      expect(showcase.invalidate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ id: PROMO_ID, liveState: 'LIVE' });
    });

    it('counts, inserts and audits in ONE transaction under the per-list lock (no 31st promo from a race)', async () => {
      const order: string[] = [];
      prisma.$executeRaw.mockImplementation(() => {
        order.push('lock');
        return Promise.resolve(0);
      });
      prisma.homePromo.aggregate.mockImplementation(() => {
        order.push('count');
        return Promise.resolve({
          _count: { _all: 0 },
          _max: { sortOrder: null },
        });
      });
      prisma.homePromo.create.mockImplementation(
        ({ data }: { data: Partial<HomePromo> }) => {
          order.push('insert');
          return Promise.resolve(makePromo({ ...data, id: PROMO_ID }));
        },
      );
      audit.record.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve();
      });

      await service.create(heroDto({ kind: HomePromoKind.COMING_SOON }), actor);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['lock', 'count', 'insert', 'audit']);
      const [strings, key] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain('pg_advisory_xact_lock');
      expect(key).toBe(homePromoListLockKey(HomePromoKind.COMING_SOON));
      expect(key).not.toBe(homePromoListLockKey(HomePromoKind.HERO));
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'home_promo.create', tx: prisma }),
      );
    });

    it('starts an empty kind at position 0', async () => {
      await service.create(heroDto(), actor);
      expect(prisma.homePromo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sortOrder: 0 }) as unknown,
        }),
      );
    });

    it('refuses a full list with 409 HOME_PROMO_LIMIT_REACHED', async () => {
      prisma.homePromo.aggregate.mockResolvedValue({
        _count: { _all: 30 },
        _max: { sortOrder: 29 },
      });
      const error = await codedError(service.create(heroDto(), actor));
      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe(HOME_PROMO_ERRORS.LIMIT_REACHED);
      expect(prisma.homePromo.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<CreateHomePromoDto>, string]>([
      [
        'a hero button without its labels',
        { ctaLabelEn: null, ctaLabelMm: null },
        HOME_PROMO_ERRORS.CTA_LABEL_REQUIRED,
      ],
      [
        'an English kicker without the Burmese one',
        { kickerEn: 'New' },
        HOME_PROMO_ERRORS.TRANSLATION_MISSING,
      ],
      [
        'a Burmese body without the English one',
        { bodyMm: 'စာ' },
        HOME_PROMO_ERRORS.TRANSLATION_MISSING,
      ],
      [
        'a spotlight that links no title',
        { kind: HomePromoKind.SPOTLIGHT },
        HOME_PROMO_ERRORS.SPOTLIGHT_NEEDS_TITLE,
      ],
      [
        'a MOVIE button without a targetId',
        { ctaTarget: HomePromoCtaTarget.MOVIE },
        HOME_PROMO_ERRORS.TARGET_REQUIRED,
      ],
      [
        'a URL button without a url',
        { ctaTarget: HomePromoCtaTarget.URL },
        HOME_PROMO_ERRORS.URL_REQUIRED,
      ],
      [
        'a window that ends before it starts',
        {
          startsAt: '2026-10-10T00:00:00Z',
          endsAt: '2026-10-09T00:00:00Z',
        },
        HOME_PROMO_ERRORS.WINDOW_INVALID,
      ],
    ])('refuses %s with 400', async (_name, overrides, code) => {
      const error = await codedError(service.create(heroDto(overrides), actor));
      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(code);
      expect(prisma.homePromo.create).not.toHaveBeenCalled();
      expect(showcase.invalidate).not.toHaveBeenCalled();
    });

    it('names the missing half of a translation pair', async () => {
      const error = await codedError(
        service.create(heroDto({ kickerEn: 'New' }), actor),
      );
      expect(error.getResponse()).toMatchObject({ field: 'kickerMm' });
    });

    it('lets coming-soon cards and spotlights go without button labels', async () => {
      prisma.movie.findMany.mockResolvedValue([movieRow]);
      await service.create(
        heroDto({
          kind: HomePromoKind.SPOTLIGHT,
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
          ctaLabelEn: null,
          ctaLabelMm: null,
        }),
        actor,
      );
      await service.create(
        heroDto({
          kind: HomePromoKind.COMING_SOON,
          ctaTarget: HomePromoCtaTarget.NONE,
          ctaLabelEn: null,
          ctaLabelMm: null,
          dateText: 'December',
        }),
        actor,
      );
      expect(prisma.homePromo.create).toHaveBeenCalledTimes(2);
    });

    it('checks a linked movie exists as a standalone film (not an episode) but not that it is published', async () => {
      const error = await codedError(
        service.create(
          heroDto({ ctaTarget: HomePromoCtaTarget.MOVIE, targetId: MOVIE_ID }),
          actor,
        ),
      );
      expect(error.code).toBe(HOME_PROMO_ERRORS.TARGET_NOT_FOUND);
      const { where } = prisma.movie.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({ id: { in: [MOVIE_ID] }, seriesId: null });
      expect(where).not.toHaveProperty('status');
    });

    it('looks series and books up in their own tables', async () => {
      prisma.series.findMany.mockResolvedValue([
        {
          id: OTHER_ID,
          title: 'Rain Season',
          description: '',
          posterUrl: null,
          coverUrl: null,
          genre: 'Drama',
          releaseYear: 2026,
          rating: 0,
          accessType: 'SUBSCRIPTION',
        },
      ]);
      await service.create(
        heroDto({ ctaTarget: HomePromoCtaTarget.SERIES, targetId: OTHER_ID }),
        actor,
      );
      expect(prisma.series.findMany).toHaveBeenCalled();

      const error = await codedError(
        service.create(
          heroDto({ ctaTarget: HomePromoCtaTarget.BOOK, targetId: OTHER_ID }),
          actor,
        ),
      );
      expect(error.code).toBe(HOME_PROMO_ERRORS.TARGET_NOT_FOUND);
      expect(prisma.book.findMany).toHaveBeenCalled();
    });

    it('clears a leftover targetId / url the button type does not use, and stores the image canonical', async () => {
      await service.create(
        heroDto({
          targetId: MOVIE_ID,
          url: 'https://example.com',
          imageUrl: 'http://REQUEST/movies/images/promo/a.webp',
        }),
        actor,
      );
      const { data } = prisma.homePromo.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.targetId).toBeNull();
      expect(data.url).toBeNull();
      expect(data.imageUrl).toBe('http://STORED/movies/images/promo/a.webp');
    });

    it('stores the window as dates', async () => {
      await service.create(
        heroDto({
          startsAt: '2026-10-09T00:00:00Z',
          endsAt: '2026-10-10T00:00:00Z',
        }),
        actor,
      );
      const { data } = prisma.homePromo.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.startsAt).toEqual(new Date('2026-10-09T00:00:00Z'));
      expect(data.endsAt).toEqual(new Date('2026-10-10T00:00:00Z'));
    });
  });

  describe('update', () => {
    it('keeps absent fields, clears null ones, audits before/after and drops the cache', async () => {
      const before = makePromo({ kickerEn: 'New', kickerMm: 'အသစ်' });
      prisma.homePromo.findUnique.mockResolvedValue(before);
      prisma.homePromo.update.mockImplementation(
        ({ data }: { data: Partial<HomePromo> }) =>
          Promise.resolve({ ...before, ...data }),
      );

      const dto: UpdateHomePromoDto = {
        titleEn: 'Go Premium today',
        kickerEn: null,
        kickerMm: null,
      };
      await service.update(PROMO_ID, dto, actor);

      const { data } = prisma.homePromo.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        titleEn: 'Go Premium today',
        titleMm: 'Premium ယူပါ',
        kickerEn: null,
        kickerMm: null,
        ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
        ctaLabelEn: 'Subscribe',
      });
      expect(data).not.toHaveProperty('kind');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'home_promo.update',
          before: expect.objectContaining({ titleEn: 'Go Premium' }) as unknown,
          after: expect.objectContaining({
            titleEn: 'Go Premium today',
          }) as unknown,
        }),
      );
      expect(showcase.invalidate).toHaveBeenCalledTimes(1);
    });

    it('judges the MERGED promo: dropping one label of a hero button is refused', async () => {
      prisma.homePromo.findUnique.mockResolvedValue(makePromo());
      const error = await codedError(
        service.update(PROMO_ID, { ctaLabelMm: null }, actor),
      );
      expect(error.code).toBe(HOME_PROMO_ERRORS.TRANSLATION_MISSING);
      expect(prisma.homePromo.update).not.toHaveBeenCalled();
    });

    it('switching the button from a movie to a link clears the old targetId', async () => {
      const before = makePromo({
        ctaTarget: HomePromoCtaTarget.MOVIE,
        targetId: MOVIE_ID,
      });
      prisma.homePromo.findUnique.mockResolvedValue(before);
      prisma.homePromo.update.mockImplementation(
        ({ data }: { data: Partial<HomePromo> }) =>
          Promise.resolve({ ...before, ...data }),
      );
      await service.update(
        PROMO_ID,
        { ctaTarget: HomePromoCtaTarget.URL, url: 'https://example.com/x' },
        actor,
      );
      const { data } = prisma.homePromo.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        ctaTarget: HomePromoCtaTarget.URL,
        url: 'https://example.com/x',
        targetId: null,
      });
    });

    it('answers an unknown id with 404 HOME_PROMO_NOT_FOUND and writes nothing', async () => {
      prisma.homePromo.findUnique.mockResolvedValue(null);
      const error = await codedError(
        service.update(PROMO_ID, { titleEn: 'x' }, actor),
      );
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe(HOME_PROMO_ERRORS.NOT_FOUND);
      expect(prisma.homePromo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes, audits the before snapshot and drops the cache', async () => {
      prisma.homePromo.findUnique.mockResolvedValue(makePromo());
      await service.remove(PROMO_ID, actor);
      expect(prisma.homePromo.delete).toHaveBeenCalledWith({
        where: { id: PROMO_ID },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'home_promo.delete',
          target: { type: 'home_promo', id: PROMO_ID, label: 'Go Premium' },
          before: expect.objectContaining({ kind: 'HERO' }) as unknown,
        }),
      );
      expect(showcase.invalidate).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown id', async () => {
      prisma.homePromo.findUnique.mockResolvedValue(null);
      const error = await codedError(service.remove(PROMO_ID, actor));
      expect(error.code).toBe(HOME_PROMO_ERRORS.NOT_FOUND);
      expect(prisma.homePromo.delete).not.toHaveBeenCalled();
    });
  });

  describe('reorder', () => {
    it('writes each position, records ONE audit row inside the transaction and drops the cache', async () => {
      prisma.homePromo.findMany.mockResolvedValueOnce([
        { id: PROMO_ID },
        { id: OTHER_ID },
      ]);
      await service.reorder(
        { kind: HomePromoKind.HERO, ids: [OTHER_ID, PROMO_ID] },
        actor,
      );
      expect(prisma.homePromo.update).toHaveBeenNthCalledWith(1, {
        where: { id: OTHER_ID },
        data: { sortOrder: 0 },
      });
      expect(prisma.homePromo.update).toHaveBeenNthCalledWith(2, {
        where: { id: PROMO_ID },
        data: { sortOrder: 1 },
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'home_promo.reorder',
          target: expect.objectContaining({ id: null }) as unknown,
          metadata: {
            kind: 'HERO',
            before: [PROMO_ID, OTHER_ID],
            after: [OTHER_ID, PROMO_ID],
          },
          tx: prisma,
        }),
      );
      // The same per-list lock as create, so a create cannot slip in mid-reorder.
      const [, key] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(key).toBe(homePromoListLockKey(HomePromoKind.HERO));
      expect(showcase.invalidate).toHaveBeenCalledTimes(1);
    });

    it('refuses a partial or stale list with 400 HOME_PROMO_REORDER_MISMATCH', async () => {
      prisma.homePromo.findMany.mockResolvedValueOnce([
        { id: PROMO_ID },
        { id: OTHER_ID },
      ]);
      const error = await codedError(
        service.reorder({ kind: HomePromoKind.HERO, ids: [PROMO_ID] }, actor),
      );
      expect(error.code).toBe(HOME_PROMO_ERRORS.REORDER_MISMATCH);
      expect(prisma.homePromo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(showcase.invalidate).not.toHaveBeenCalled();
    });
  });

  describe('list / findOne (staff view)', () => {
    it('re-hosts images and reports a hidden or deleted target honestly', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        makePromo({
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
          imageUrl: 'http://STORED/movies/images/promo/a.webp',
        }),
        makePromo({
          id: OTHER_ID,
          ctaTarget: HomePromoCtaTarget.SERIES,
          targetId: OTHER_ID,
        }),
      ]);
      // The movie exists but is a draft: found by the "any status" pass,
      // absent from the USER-visible pass.
      prisma.movie.findMany.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.status === MovieStatus.PUBLISHED ? [] : [movieRow],
          ),
      );

      const [movie, series] = await service.list();

      expect(movie.imageUrl).toBe('http://REQUEST/movies/images/promo/a.webp');
      expect(movie.target).toEqual({
        type: 'MOVIE',
        id: MOVIE_ID,
        title: 'Paper Lanterns',
        imageUrl: 'REQUEST/poster.jpg',
        isVisible: false,
        missing: false,
      });
      expect(series.target).toMatchObject({
        type: 'SERIES',
        title: null,
        isVisible: false,
        missing: true,
      });
    });

    it('filters by kind', async () => {
      await service.list(HomePromoKind.COMING_SOON);
      expect(prisma.homePromo.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kind: 'COMING_SOON' } }),
      );
    });

    it('findOne 404s an unknown id', async () => {
      prisma.homePromo.findUnique.mockResolvedValue(null);
      const error = await codedError(service.findOne(PROMO_ID));
      expect(error.getStatus()).toBe(404);
    });
  });

  describe('settings', () => {
    it('reads the defaults before the first save, without writing', async () => {
      expect(await service.getSettings()).toEqual({
        webUrl: null,
        appStoreUrl: null,
        playStoreUrl: null,
        gamesTeaserEnabled: true,
        gamesTeaserDateText: null,
        updatedAt: null,
        updatedBy: null,
      });
      expect(prisma.homeSettings.create).not.toHaveBeenCalled();
    });

    it('creates the single row under the advisory lock on the first save, audited in the same transaction', async () => {
      prisma.homeSettings.create.mockResolvedValue({
        id: 'settings-1',
        webUrl: 'https://myanflix.example',
        appStoreUrl: null,
        playStoreUrl: null,
        gamesTeaserEnabled: false,
        gamesTeaserDateText: null,
      });

      await service.updateSettings(
        { webUrl: 'https://myanflix.example', gamesTeaserEnabled: false },
        actor,
      );

      const [strings, namespace] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain('pg_advisory_xact_lock');
      expect(namespace).toBe(HOME_SETTINGS_LOCK_NAMESPACE);
      expect(prisma.homeSettings.create).toHaveBeenCalledWith({
        data: {
          webUrl: 'https://myanflix.example',
          appStoreUrl: null,
          playStoreUrl: null,
          gamesTeaserEnabled: false,
          gamesTeaserDateText: null,
          updatedByUserId: 'admin-1',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'home_settings.update',
          target: {
            type: 'home_settings',
            id: 'settings-1',
            label: 'Home settings',
          },
          tx: prisma,
        }),
      );
      expect(showcase.invalidate).toHaveBeenCalledTimes(1);
    });

    it('replaces the existing row (PUT: an omitted link is cleared)', async () => {
      const current = {
        id: 'settings-1',
        webUrl: 'https://old.example',
        appStoreUrl: 'https://apps.apple.com/x',
        playStoreUrl: null,
        gamesTeaserEnabled: true,
        gamesTeaserDateText: '2027',
        createdAt: new Date(),
      };
      prisma.homeSettings.findFirst.mockResolvedValue(current);
      prisma.homeSettings.update.mockResolvedValue({
        ...current,
        appStoreUrl: null,
      });

      await service.updateSettings({ gamesTeaserEnabled: true }, actor);

      expect(prisma.homeSettings.update).toHaveBeenCalledWith({
        where: { id: 'settings-1' },
        data: expect.objectContaining({
          webUrl: null,
          appStoreUrl: null,
          gamesTeaserDateText: null,
        }) as unknown,
      });
      expect(prisma.homeSettings.create).not.toHaveBeenCalled();
    });
  });

  describe('liveStateOf', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    it.each([
      [{ isActive: false, startsAt: null, endsAt: null }, 'OFF'],
      [{ isActive: true, startsAt: null, endsAt: null }, 'LIVE'],
      [
        { isActive: true, startsAt: new Date('2026-10-09'), endsAt: null },
        'SCHEDULED',
      ],
      [
        {
          isActive: true,
          startsAt: null,
          endsAt: new Date('2026-10-08T12:00:00Z'),
        },
        'ENDED',
      ],
    ] as const)('%o -> %s', (promo, state) => {
      expect(liveStateOf(promo, now)).toBe(state);
    });
  });
});
