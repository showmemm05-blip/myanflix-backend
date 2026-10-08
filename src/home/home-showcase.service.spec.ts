import { Test, TestingModule } from '@nestjs/testing';
import {
  BookStatus,
  HomePromoArtPreset,
  HomePromoCtaTarget,
  HomePromoKind,
  MovieStatus,
  SeriesStatus,
  type HomePromo,
} from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HomeShowcaseService,
  SHOWCASE_CACHE_TTL_MS,
} from './home-showcase.service';

const NOW = new Date('2026-10-08T12:00:00Z');
const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const NEWEST_ID = '44444444-4444-4444-8444-444444444444';

let seq = 0;
function promo(overrides: Partial<HomePromo> = {}): HomePromo {
  seq += 1;
  return {
    id: `promo-${seq}`,
    kind: HomePromoKind.HERO,
    titleEn: `Promo ${seq}`,
    titleMm: `ကြော်ငြာ ${seq}`,
    kickerEn: null,
    kickerMm: null,
    bodyEn: null,
    bodyMm: null,
    ctaLabelEn: 'Go',
    ctaLabelMm: 'သွား',
    ctaTarget: HomePromoCtaTarget.SUBSCRIBE,
    targetId: null,
    url: null,
    artPreset: HomePromoArtPreset.PREMIUM,
    imageUrl: null,
    dateText: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    sortOrder: seq,
    createdById: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const movieRow = (id: string, title: string) => ({
  id,
  title,
  description: '  A   film\nabout lanterns ',
  posterUrl: 'STORED/poster.jpg',
  coverUrl: 'STORED/cover.jpg',
  thumbnailUrl: null,
  genre: 'Drama',
  releaseYear: 2026,
  duration: 100,
  rating: 8,
  accessType: 'FREE',
  ageRating: 'PG',
});

const seriesRow = {
  id: SERIES_ID,
  title: 'Rain Season',
  description: 'A series',
  posterUrl: null,
  coverUrl: null,
  genre: 'Drama',
  releaseYear: 2026,
  rating: 0,
  accessType: 'SUBSCRIPTION',
};

const bookRow = {
  id: BOOK_ID,
  title: 'Golden Letters',
  author: 'Ma Ma',
  description: 'A book',
  coverUrl: 'STORED/book.jpg',
};

/** A findMany mock that answers like Postgres: only the asked-for ids. */
const publishedRows = <T extends { id: string }>(rows: () => T[]) =>
  jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(rows().filter((row) => where.id.in.includes(row.id))),
  );

describe('HomeShowcaseService', () => {
  let service: HomeShowcaseService;
  /** What is USER-visible in the "database" right now, per table. */
  let published: {
    movie: ReturnType<typeof movieRow>[];
    series: (typeof seriesRow)[];
    book: (typeof bookRow)[];
  };
  let prisma: {
    homePromo: { findMany: jest.Mock };
    homeSettings: { findFirst: jest.Mock };
    movie: { findFirst: jest.Mock; findMany: jest.Mock };
    series: { findMany: jest.Mock };
    book: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    published = {
      movie: [movieRow(MOVIE_ID, 'Lanterns'), movieRow(NEWEST_ID, 'Newest')],
      series: [seriesRow],
      book: [bookRow],
    };
    prisma = {
      homePromo: { findMany: jest.fn().mockResolvedValue([]) },
      homeSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      movie: {
        findFirst: jest.fn().mockResolvedValue(movieRow(NEWEST_ID, 'Newest')),
        // The USER-visibility filter lives in the WHERE: these mocks answer
        // the way Postgres would for "MOVIE_ID is published".
        findMany: publishedRows(() => published.movie),
      },
      series: { findMany: publishedRows(() => published.series) },
      book: { findMany: publishedRows(() => published.book) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HomeShowcaseService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MinioService,
          useValue: {
            imageUrl: (url: string | null) =>
              url ? url.replace('STORED', 'REQUEST') : null,
          },
        },
      ],
    }).compile();

    service = module.get(HomeShowcaseService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('what is read', () => {
    it('asks only for active, not-yet-ended promos and USER-visible titles', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.MOVIE, targetId: MOVIE_ID }),
        promo({ ctaTarget: HomePromoCtaTarget.SERIES, targetId: SERIES_ID }),
        promo({ ctaTarget: HomePromoCtaTarget.BOOK, targetId: BOOK_ID }),
      ]);
      await service.getShowcase(true, NOW);

      const promoWhere = (
        prisma.homePromo.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(promoWhere.isActive).toBe(true);
      expect(promoWhere.OR).toEqual([
        { endsAt: null },
        { endsAt: { gt: expect.any(Date) as unknown } },
      ]);

      expect(prisma.movie.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: [MOVIE_ID] },
            status: MovieStatus.PUBLISHED,
            seriesId: null,
          },
        }),
      );
      expect(prisma.series.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [SERIES_ID] }, status: SeriesStatus.PUBLISHED },
        }),
      );
      expect(prisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: [BOOK_ID] },
            editions: { some: { status: BookStatus.PUBLISHED } },
          },
        }),
      );
      // The fallback spotlight: newest PUBLISHED standalone movie.
      expect(prisma.movie.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: MovieStatus.PUBLISHED, seriesId: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('never selects playback fields for a title card', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.MOVIE, targetId: MOVIE_ID }),
      ]);
      await service.getShowcase(false, NOW);
      const { select } = prisma.movie.findMany.mock.calls[0][0] as {
        select: Record<string, boolean>;
      };
      expect(Object.keys(select).join(',')).not.toMatch(
        /video|hls|stream|objectKey/i,
      );
    });
  });

  describe('hero', () => {
    it('keeps promo order and skips a slide whose linked title is not visible', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ titleEn: 'A' }),
        promo({
          titleEn: 'Hidden movie',
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: '99999999-9999-4999-8999-999999999999',
        }),
        promo({
          titleEn: 'B',
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
        }),
      ]);
      const { hero } = await service.getShowcase(false, NOW);
      expect(hero.map((slide) => slide.titleEn)).toEqual(['A', 'B']);
      expect(hero[0].target).toBeNull();
      expect(hero[1].target).toMatchObject({
        type: 'MOVIE',
        id: MOVIE_ID,
        title: 'Lanterns',
        description: 'A film about lanterns',
        posterUrl: 'REQUEST/poster.jpg',
        coverUrl: 'REQUEST/cover.jpg',
        durationMinutes: 100,
        accessType: 'FREE',
        author: null,
      });
    });

    it('links a book only for a signed-in viewer (guests cannot open /books)', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.BOOK, targetId: BOOK_ID }),
      ]);
      expect((await service.getShowcase(false, NOW)).hero).toEqual([]);
      const signedIn = await service.getShowcase(true, NOW);
      expect(signedIn.hero).toHaveLength(1);
      expect(signedIn.hero[0].target).toMatchObject({
        type: 'BOOK',
        author: 'Ma Ma',
        coverUrl: 'REQUEST/book.jpg',
        accessType: null,
      });
    });

    it('re-hosts the uploaded promo image per request', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ imageUrl: 'http://STORED/movies/images/promo/a.webp' }),
      ]);
      const { hero } = await service.getShowcase(false, NOW);
      expect(hero[0].imageUrl).toBe(
        'http://REQUEST/movies/images/promo/a.webp',
      );
    });
  });

  describe('time window', () => {
    it('shows a promo only inside [startsAt, endsAt), judged per request', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ titleEn: 'open' }),
        promo({ titleEn: 'starts now', startsAt: NOW }),
        promo({
          titleEn: 'later',
          startsAt: new Date(NOW.getTime() + 1000),
        }),
        promo({ titleEn: 'ending now', endsAt: NOW }),
        promo({
          titleEn: 'inside',
          startsAt: new Date(NOW.getTime() - 1000),
          endsAt: new Date(NOW.getTime() + 1000),
        }),
      ]);
      const titles = (await service.getShowcase(false, NOW)).hero.map(
        (slide) => slide.titleEn,
      );
      expect(titles).toEqual(['open', 'starts now', 'inside']);

      // Two seconds later, from the SAME cached read: 'later' is live and
      // 'inside' has ended — the window never waits for the cache.
      const later = (
        await service.getShowcase(false, new Date(NOW.getTime() + 2000))
      ).hero.map((slide) => slide.titleEn);
      expect(later).toEqual(['open', 'starts now', 'later']);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('spotlight', () => {
    it('uses the first live spotlight whose title the viewer can open', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({
          kind: HomePromoKind.SPOTLIGHT,
          titleEn: 'book spot',
          ctaTarget: HomePromoCtaTarget.BOOK,
          targetId: BOOK_ID,
        }),
        promo({
          kind: HomePromoKind.SPOTLIGHT,
          titleEn: 'series spot',
          ctaTarget: HomePromoCtaTarget.SERIES,
          targetId: SERIES_ID,
        }),
      ]);
      const guest = await service.getShowcase(false, NOW);
      expect(guest.spotlight).toMatchObject({
        source: 'PROMO',
        promo: { titleEn: 'series spot' },
        title: { type: 'SERIES', id: SERIES_ID },
      });
      const member = await service.getShowcase(true, NOW);
      expect(member.spotlight?.promo?.titleEn).toBe('book spot');
    });

    it('falls back to the newest published movie when no spotlight is live', async () => {
      const { spotlight } = await service.getShowcase(false, NOW);
      expect(spotlight).toEqual({
        source: 'NEWEST_MOVIE',
        promo: null,
        title: expect.objectContaining({
          type: 'MOVIE',
          id: NEWEST_ID,
          posterUrl: 'REQUEST/poster.jpg',
        }) as unknown,
      });
    });

    it('is null when there is no spotlight and no published movie', async () => {
      prisma.movie.findFirst.mockResolvedValue(null);
      expect((await service.getShowcase(false, NOW)).spotlight).toBeNull();
    });
  });

  describe('coming soon', () => {
    it('keeps a card whose title is not out yet, without its link', async () => {
      published.movie = []; // the linked movie is a draft
      prisma.homePromo.findMany.mockResolvedValue([
        promo({
          kind: HomePromoKind.COMING_SOON,
          titleEn: 'Season 2',
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
          dateText: 'December',
        }),
        promo({
          kind: HomePromoKind.COMING_SOON,
          titleEn: 'Plain',
          ctaTarget: HomePromoCtaTarget.NONE,
        }),
      ]);
      const { comingSoon, hero } = await service.getShowcase(false, NOW);
      expect(hero).toEqual([]);
      expect(comingSoon).toEqual([
        expect.objectContaining({
          titleEn: 'Season 2',
          ctaTarget: 'NONE',
          target: null,
          dateText: 'December',
        }),
        expect.objectContaining({ titleEn: 'Plain', ctaTarget: 'NONE' }),
      ]);
    });

    it('keeps the link once the title is published', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({
          kind: HomePromoKind.COMING_SOON,
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
        }),
      ]);
      const { comingSoon } = await service.getShowcase(false, NOW);
      expect(comingSoon[0]).toMatchObject({
        ctaTarget: 'MOVIE',
        target: { id: MOVIE_ID },
      });
    });
  });

  describe('settings', () => {
    it('serves the defaults until the admin saves any', async () => {
      expect((await service.getShowcase(false, NOW)).settings).toEqual({
        webUrl: null,
        appStoreUrl: null,
        playStoreUrl: null,
        gamesTeaserEnabled: true,
        gamesTeaserDateText: null,
      });
    });

    it('serves the saved row, without its bookkeeping', async () => {
      prisma.homeSettings.findFirst.mockResolvedValue({
        id: 's1',
        webUrl: 'https://myanflix.example',
        appStoreUrl: null,
        playStoreUrl: 'https://play.google.com/x',
        gamesTeaserEnabled: false,
        gamesTeaserDateText: '2027',
        updatedByUserId: 'admin-1',
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect((await service.getShowcase(false, NOW)).settings).toEqual({
        webUrl: 'https://myanflix.example',
        appStoreUrl: null,
        playStoreUrl: 'https://play.google.com/x',
        gamesTeaserEnabled: false,
        gamesTeaserDateText: '2027',
      });
    });
  });

  describe('cache', () => {
    it('serves repeat reads from memory for the TTL, then reads again', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
      await service.getShowcase(false, NOW);
      await service.getShowcase(true, NOW);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(NOW.getTime() + SHOWCASE_CACHE_TTL_MS - 1);
      await service.getShowcase(false, NOW);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(NOW.getTime() + SHOWCASE_CACHE_TTL_MS);
      await service.getShowcase(false, NOW);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(2);
    });

    it('invalidate() makes the very next read fresh', async () => {
      await service.getShowcase(false, NOW);
      prisma.homePromo.findMany.mockResolvedValue([promo({ titleEn: 'new' })]);
      service.invalidate();
      const { hero } = await service.getShowcase(false, NOW);
      expect(hero.map((slide) => slide.titleEn)).toEqual(['new']);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(2);
    });

    it('shares one database read between concurrent requests', async () => {
      await Promise.all([
        service.getShowcase(false, NOW),
        service.getShowcase(true, NOW),
        service.getShowcase(false, NOW),
      ]);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(1);
    });

    it('does not cache a read that an invalidate() overtook', async () => {
      let release!: (rows: HomePromo[]) => void;
      prisma.homePromo.findMany.mockReturnValueOnce(
        new Promise<HomePromo[]>((resolve) => {
          release = resolve;
        }),
      );
      const stale = service.getShowcase(false, NOW);
      await Promise.resolve();
      service.invalidate();
      release([promo({ titleEn: 'stale' })]);
      await stale;

      prisma.homePromo.findMany.mockResolvedValue([
        promo({ titleEn: 'fresh' }),
      ]);
      const { hero } = await service.getShowcase(false, NOW);
      expect(hero.map((slide) => slide.titleEn)).toEqual(['fresh']);
    });

    it('drops a title unpublished after the read, at once, not after the TTL', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({
          titleEn: 'film',
          ctaTarget: HomePromoCtaTarget.MOVIE,
          targetId: MOVIE_ID,
        }),
        promo({
          kind: HomePromoKind.SPOTLIGHT,
          titleEn: 'spot',
          ctaTarget: HomePromoCtaTarget.SERIES,
          targetId: SERIES_ID,
        }),
      ]);
      const first = await service.getShowcase(false, NOW);
      expect(first.hero.map((slide) => slide.titleEn)).toEqual(['film']);
      expect(first.spotlight?.title.id).toBe(SERIES_ID);

      // Another admin page unpublishes both, well inside the TTL.
      published.movie = published.movie.filter((row) => row.id !== MOVIE_ID);
      published.series = [];
      const next = await service.getShowcase(false, NOW);
      expect(next.hero).toEqual([]);
      expect(next.spotlight).toMatchObject({
        source: 'NEWEST_MOVIE',
        title: { id: NEWEST_ID },
      });
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(2);
    });

    it('re-reads the newest-movie fallback when that movie is unpublished', async () => {
      expect((await service.getShowcase(false, NOW)).spotlight?.title.id).toBe(
        NEWEST_ID,
      );
      published.movie = [];
      prisma.movie.findFirst.mockResolvedValue(null);
      expect((await service.getShowcase(false, NOW)).spotlight).toBeNull();
    });

    it('checks a cached answer by id only, and keeps the cache when nothing was hidden', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.BOOK, targetId: BOOK_ID }),
      ]);
      await service.getShowcase(true, NOW); // the read itself: no extra check
      expect(prisma.book.findMany).toHaveBeenCalledTimes(1);

      await service.getShowcase(true, NOW);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.book.findMany).toHaveBeenLastCalledWith({
        where: {
          id: { in: [BOOK_ID] },
          editions: { some: { status: BookStatus.PUBLISHED } },
        },
        select: { id: true },
      });
      expect(prisma.movie.findMany).toHaveBeenLastCalledWith({
        where: {
          id: { in: [NEWEST_ID] },
          status: MovieStatus.PUBLISHED,
          seriesId: null,
        },
        select: { id: true },
      });
    });

    it('shares one re-read between concurrent requests that find a hidden title', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.MOVIE, targetId: MOVIE_ID }),
      ]);
      await service.getShowcase(false, NOW);
      published.movie = published.movie.filter((row) => row.id !== MOVIE_ID);
      const answers = await Promise.all([
        service.getShowcase(false, NOW),
        service.getShowcase(true, NOW),
        service.getShowcase(false, NOW),
      ]);
      expect(answers.every((answer) => answer.hero.length === 0)).toBe(true);
      expect(prisma.homePromo.findMany).toHaveBeenCalledTimes(2);
    });

    it('never lets one viewer change what the next one sees', async () => {
      prisma.homePromo.findMany.mockResolvedValue([
        promo({ ctaTarget: HomePromoCtaTarget.BOOK, targetId: BOOK_ID }),
      ]);
      expect((await service.getShowcase(true, NOW)).hero).toHaveLength(1);
      expect((await service.getShowcase(false, NOW)).hero).toHaveLength(0);
      expect((await service.getShowcase(true, NOW)).hero).toHaveLength(1);
    });
  });
});
