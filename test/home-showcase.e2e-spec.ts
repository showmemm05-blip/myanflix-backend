import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  BookStatus,
  BookType,
  MovieStatus,
  Role,
  SeriesStatus,
  UserStatus,
} from '../src/generated/prisma/client';

interface Envelope<T> {
  success: boolean;
  data: T;
}

interface ErrorEnvelope {
  success: false;
  message: string;
  code?: string;
}

interface PromoView {
  id: string;
  kind: string;
  titleEn: string;
  ctaTarget: string;
  target: { type: string; id: string } | null;
}

interface Showcase {
  hero: PromoView[];
  spotlight: {
    source: string;
    promo: PromoView | null;
    title: { type: string; id: string };
  } | null;
  comingSoon: PromoView[];
  settings: Record<string, unknown>;
}

/** Anything that would let a guest reach playback data. */
const FORBIDDEN_KEY = /hls|playlist|objectKey|stream|video/i;

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.add(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

/**
 * The home showcase end to end: the real AppModule (global JwtAuthGuard,
 * real JwtStrategy, real PermissionsGuard resolving the seeded roles from
 * the database — so the home_promos migration's ADMIN grants are what is
 * being proven) against the isolated e2e database.
 */
describe('Home showcase + Home promos (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  const userIds: string[] = [];
  let adminId: string;
  let adminToken: string;
  let userToken: string;
  let uploaderToken: string;
  let publishedMovieId: string;
  let draftMovieId: string;
  let publishedSeriesId: string;
  let publishedBookId: string;

  const movieBase = {
    description: 'home showcase fixture',
    genre: 'Drama',
    language: 'Burmese',
    releaseYear: 2026,
    duration: 95,
  };

  const signToken = (id: string) =>
    jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );

  async function makeUser(role: Role, suffix: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        username: `home_${role.toLowerCase()}_${suffix}`,
        password: 'unused-in-these-tests',
        role,
        status: UserStatus.ACTIVE,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    // A clean slate for the two home tables (throwaway database).
    await prisma.homePromo.deleteMany({});
    await prisma.homeSettings.deleteMany({});

    const suffix = randomUUID().slice(0, 8);
    adminId = await makeUser(Role.ADMIN, suffix);
    adminToken = await signToken(adminId);
    userToken = await signToken(await makeUser(Role.USER, suffix));
    uploaderToken = await signToken(
      await makeUser(Role.CONTENT_UPLOADER, suffix),
    );

    draftMovieId = (
      await prisma.movie.create({
        data: { ...movieBase, title: `Draft ${suffix}` },
      })
    ).id;
    publishedSeriesId = (
      await prisma.series.create({
        data: {
          title: `Rain Season ${suffix}`,
          description: 'series fixture',
          genre: 'Drama',
          language: 'Burmese',
          releaseYear: 2026,
          status: SeriesStatus.PUBLISHED,
        },
      })
    ).id;
    publishedBookId = (
      await prisma.book.create({
        data: {
          title: `Golden Letters ${suffix}`,
          author: 'Ma Ma',
          description: 'book fixture',
          type: BookType.EDITOR,
          editions: {
            create: { language: 'my', status: BookStatus.PUBLISHED },
          },
        },
      })
    ).id;
    // Created last so it is the newest published movie (the spotlight
    // fallback).
    publishedMovieId = (
      await prisma.movie.create({
        data: {
          ...movieBase,
          title: `Paper Lanterns ${suffix}`,
          status: MovieStatus.PUBLISHED,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.homePromo.deleteMany({});
    await prisma.homeSettings.deleteMany({});
    await prisma.movie.deleteMany({
      where: { id: { in: [publishedMovieId, draftMovieId] } },
    });
    await prisma.series.deleteMany({ where: { id: publishedSeriesId } });
    await prisma.book.deleteMany({ where: { id: publishedBookId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const asAdmin = (test: request.Test) =>
    test.set('Authorization', `Bearer ${adminToken}`);

  async function showcase(token?: string): Promise<Showcase> {
    let test = api().get('/api/home/showcase');
    if (token) test = test.set('Authorization', `Bearer ${token}`);
    const res = await test.expect(200);
    const body = res.body as Envelope<Showcase>;
    expect(body.success).toBe(true);
    expect(
      [...collectKeys(body)].filter((key) => FORBIDDEN_KEY.test(key)),
    ).toEqual([]);
    return body.data;
  }

  async function createPromo(body: Record<string, unknown>) {
    const res = await asAdmin(api().post('/api/home/promos').send(body));
    return res;
  }

  const hero = (extra: Record<string, unknown> = {}) => ({
    kind: 'HERO',
    titleEn: 'Go Premium',
    titleMm: 'Premium ယူပါ',
    ctaTarget: 'SUBSCRIBE',
    ctaLabelEn: 'Subscribe',
    ctaLabelMm: 'စာရင်းသွင်းပါ',
    artPreset: 'PREMIUM',
    ...extra,
  });

  describe('before anything is set', () => {
    it('a guest gets an empty showcase, the default settings and the newest movie as spotlight', async () => {
      const data = await showcase();
      expect(data.hero).toEqual([]);
      expect(data.comingSoon).toEqual([]);
      expect(data.settings).toEqual({
        webUrl: null,
        appStoreUrl: null,
        playStoreUrl: null,
        gamesTeaserEnabled: true,
        gamesTeaserDateText: null,
      });
      expect(data.spotlight).toMatchObject({
        source: 'NEWEST_MOVIE',
        promo: null,
        title: { type: 'MOVIE', id: publishedMovieId },
      });
    });

    it('a bad token on the public route is still a 401 (clients refresh on it)', async () => {
      await api()
        .get('/api/home/showcase')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('permissions (seeded by the home_promos migration)', () => {
    it('401 without a token on every staff route', async () => {
      await api().get('/api/home/promos').expect(401);
      await api().post('/api/home/promos').send(hero()).expect(401);
      await api().get('/api/home/settings').expect(401);
      await api()
        .put('/api/home/settings')
        .send({ gamesTeaserEnabled: true })
        .expect(401);
    });

    it.each([
      ['USER', () => userToken],
      ['CONTENT_UPLOADER', () => uploaderToken],
    ])('403 for %s', async (_role, token) => {
      const auth = `Bearer ${token()}`;
      await api()
        .get('/api/home/promos')
        .set('Authorization', auth)
        .expect(403);
      await api()
        .post('/api/home/promos')
        .set('Authorization', auth)
        .send(hero())
        .expect(403);
      await api()
        .put('/api/home/settings')
        .set('Authorization', auth)
        .send({ gamesTeaserEnabled: true })
        .expect(403);
    });

    it('ADMIN may read and manage', async () => {
      await asAdmin(api().get('/api/home/promos')).expect(200);
      await asAdmin(api().get('/api/home/settings')).expect(200);
    });
  });

  describe('promos reach the showcase at once, filtered for the viewer', () => {
    let subscribeId: string;
    let draftLinkId: string;
    let bookSlideId: string;
    let movieSlideId: string;

    it('creates promos and answers each with the staff view', async () => {
      const subscribe = await createPromo(hero()).then((r) => {
        expect(r.status).toBe(201);
        return (r.body as Envelope<PromoView & { sortOrder: number }>).data;
      });
      subscribeId = subscribe.id;
      expect(subscribe.sortOrder).toBe(0);

      const draftLink = await createPromo(
        hero({
          titleEn: 'Draft film',
          ctaTarget: 'MOVIE',
          targetId: draftMovieId,
          ctaLabelEn: 'Watch',
          ctaLabelMm: 'ကြည့်ရန်',
        }),
      );
      expect(draftLink.status).toBe(201);
      const draftView = (
        draftLink.body as Envelope<{
          id: string;
          target: { isVisible: boolean; missing: boolean };
        }>
      ).data;
      draftLinkId = draftView.id;
      // The admin sees why it will not show.
      expect(draftView.target).toMatchObject({
        isVisible: false,
        missing: false,
      });

      bookSlideId = (
        (
          await createPromo(
            hero({
              titleEn: 'Read this',
              ctaTarget: 'BOOK',
              targetId: publishedBookId,
              ctaLabelEn: 'Read',
              ctaLabelMm: 'ဖတ်ရန်',
            }),
          )
        ).body as Envelope<PromoView>
      ).data.id;

      movieSlideId = (
        (
          await createPromo(
            hero({
              titleEn: 'Watch this',
              ctaTarget: 'MOVIE',
              targetId: publishedMovieId,
              ctaLabelEn: 'Watch',
              ctaLabelMm: 'ကြည့်ရန်',
            }),
          )
        ).body as Envelope<PromoView>
      ).data.id;

      // Scheduled for tomorrow: stored, not shown.
      await createPromo(
        hero({
          titleEn: 'Tomorrow',
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      ).then((r) => expect(r.status).toBe(201));

      await createPromo({
        kind: 'SPOTLIGHT',
        titleEn: 'New this week',
        titleMm: 'ဒီအပတ် အသစ်',
        ctaTarget: 'SERIES',
        targetId: publishedSeriesId,
      }).then((r) => expect(r.status).toBe(201));

      await createPromo({
        kind: 'COMING_SOON',
        titleEn: 'Season 2',
        titleMm: 'ဒုတိယ ရာသီ',
        ctaTarget: 'MOVIE',
        targetId: draftMovieId,
        dateText: 'December',
        artPreset: 'GENERIC',
      }).then((r) => expect(r.status).toBe(201));
    });

    it('a guest sees live slides only, no draft link, no book', async () => {
      const data = await showcase();
      expect(data.hero.map((p) => p.id)).toEqual([subscribeId, movieSlideId]);
      expect(data.hero[1].target).toMatchObject({
        type: 'MOVIE',
        id: publishedMovieId,
      });
      expect(data.spotlight).toMatchObject({
        source: 'PROMO',
        promo: { titleEn: 'New this week' },
        title: { type: 'SERIES', id: publishedSeriesId },
      });
      // Coming soon keeps the card for the unreleased title, minus the link.
      expect(data.comingSoon).toEqual([
        expect.objectContaining({
          titleEn: 'Season 2',
          ctaTarget: 'NONE',
          target: null,
          dateText: 'December',
        }),
      ]);
      expect(data.hero.map((p) => p.id)).not.toContain(draftLinkId);
    });

    it('a signed-in user also gets the book slide', async () => {
      const data = await showcase(userToken);
      expect(data.hero.map((p) => p.id)).toEqual([
        subscribeId,
        bookSlideId,
        movieSlideId,
      ]);
    });

    it('publishing the linked movie brings its slide back after an edit drops the cache', async () => {
      await prisma.movie.update({
        where: { id: draftMovieId },
        data: { status: MovieStatus.PUBLISHED },
      });
      // Any staff change invalidates the 60 s cache immediately.
      await asAdmin(
        api()
          .patch(`/api/home/promos/${draftLinkId}`)
          .send({ titleEn: 'Now showing' }),
      ).expect(200);
      const data = await showcase();
      expect(data.hero.map((p) => p.titleEn)).toContain('Now showing');
      expect(data.comingSoon[0]).toMatchObject({
        ctaTarget: 'MOVIE',
        target: { id: draftMovieId },
      });
      await prisma.movie.update({
        where: { id: draftMovieId },
        data: { status: MovieStatus.DRAFT },
      });
    });

    it('unpublishing a linked title on another page hides it on the very next load (no promo edit, no TTL wait)', async () => {
      // Warm the 60 s cache with the movie slide in it.
      expect((await showcase()).hero.map((p) => p.id)).toContain(movieSlideId);
      expect((await showcase()).hero.map((p) => p.id)).toContain(movieSlideId);

      // Not through Home promos: nothing calls invalidate().
      await prisma.movie.update({
        where: { id: publishedMovieId },
        data: { status: MovieStatus.DRAFT },
      });
      const data = await showcase();
      expect(data.hero.map((p) => p.id)).not.toContain(movieSlideId);
      expect(JSON.stringify(data)).not.toContain(publishedMovieId);

      await prisma.movie.update({
        where: { id: publishedMovieId },
        data: { status: MovieStatus.PUBLISHED },
      });
    });

    it('reorders a kind as one audited change', async () => {
      const list = (
        (await asAdmin(api().get('/api/home/promos?kind=HERO')).expect(200))
          .body as Envelope<PromoView[]>
      ).data;
      const reversed = list.map((p) => p.id).reverse();
      const res = await asAdmin(
        api()
          .patch('/api/home/promos/reorder')
          .send({ kind: 'HERO', ids: reversed }),
      ).expect(200);
      expect((res.body as Envelope<PromoView[]>).data.map((p) => p.id)).toEqual(
        reversed,
      );

      const partial = await asAdmin(
        api()
          .patch('/api/home/promos/reorder')
          .send({ kind: 'HERO', ids: reversed.slice(1) }),
      ).expect(400);
      expect((partial.body as ErrorEnvelope).code).toBe(
        'HOME_PROMO_REORDER_MISMATCH',
      );
    });

    it('deletes a promo and then 404s it', async () => {
      await asAdmin(api().delete(`/api/home/promos/${bookSlideId}`)).expect(
        204,
      );
      const res = await asAdmin(
        api().get(`/api/home/promos/${bookSlideId}`),
      ).expect(404);
      expect((res.body as ErrorEnvelope).code).toBe('HOME_PROMO_NOT_FOUND');
      expect((await showcase(userToken)).hero.map((p) => p.id)).not.toContain(
        bookSlideId,
      );
    });
  });

  describe('validation', () => {
    it.each([
      [
        'a target that does not exist',
        hero({
          ctaTarget: 'MOVIE',
          targetId: randomUUID(),
        }),
        'HOME_PROMO_TARGET_NOT_FOUND',
      ],
      [
        'a spotlight without a title',
        { kind: 'SPOTLIGHT', titleEn: 'x', titleMm: 'x' },
        'HOME_PROMO_SPOTLIGHT_NEEDS_TITLE',
      ],
      [
        'a hero button without labels',
        hero({ ctaLabelEn: null, ctaLabelMm: null }),
        'HOME_PROMO_CTA_LABEL_REQUIRED',
      ],
      [
        'a half translation',
        hero({ bodyEn: 'Only English' }),
        'HOME_PROMO_TRANSLATION_MISSING',
      ],
    ])('refuses %s with its code', async (_name, body, code) => {
      const res = await createPromo(body).then((r) => r);
      expect(res.status).toBe(400);
      expect((res.body as ErrorEnvelope).code).toBe(code);
    });

    it('refuses an off-site image and an unknown field (plain 400)', async () => {
      await createPromo(
        hero({ imageUrl: 'https://evil.example/beacon.gif' }),
      ).then((r) => expect(r.status).toBe(400));
      await createPromo(hero({ createdById: adminId })).then((r) =>
        expect(r.status).toBe(400),
      );
    });
  });

  describe('settings', () => {
    it('PUT saves the row and the showcase serves it at once', async () => {
      const res = await asAdmin(
        api().put('/api/home/settings').send({
          webUrl: 'https://myanflix.example',
          playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
          gamesTeaserEnabled: false,
          gamesTeaserDateText: '2027',
        }),
      ).expect(200);
      expect(
        (res.body as Envelope<{ updatedBy: { id: string } }>).data.updatedBy.id,
      ).toBe(adminId);
      expect((await showcase()).settings).toEqual({
        webUrl: 'https://myanflix.example',
        appStoreUrl: null,
        playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
        gamesTeaserEnabled: false,
        gamesTeaserDateText: '2027',
      });

      // A second save updates the same single row.
      await asAdmin(
        api().put('/api/home/settings').send({ gamesTeaserEnabled: true }),
      ).expect(200);
      expect(await prisma.homeSettings.count()).toBe(1);
      expect((await showcase()).settings.webUrl).toBeNull();
    });
  });

  describe('audit log', () => {
    it('recorded every staff change with the admin as actor', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { actorId: adminId },
        select: { action: true, category: true, targetType: true },
      });
      const actions = new Set(rows.map((row) => row.action));
      expect([...actions].sort()).toEqual([
        'home_promo.create',
        'home_promo.delete',
        'home_promo.reorder',
        'home_promo.update',
        'home_settings.update',
      ]);
      expect(rows.filter((r) => r.action === 'home_promo.create')).toHaveLength(
        7,
      );
      for (const row of rows) expect(row.category).toBe('CONTENT');
    });
  });

  describe('per-list cap under a race', () => {
    it('four creates at once on a list of 29 let exactly one in (30, never 31)', async () => {
      const kind = 'COMING_SOON';
      const existing = await prisma.homePromo.count({ where: { kind } });
      const filler = 29 - existing;
      await prisma.homePromo.createMany({
        data: Array.from({ length: filler }, (_, index) => ({
          kind,
          titleEn: `Filler ${index}`,
          titleMm: `ဖြည့် ${index}`,
          sortOrder: 100 + index,
        })),
      });

      const statuses = (
        await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            createPromo({
              kind,
              titleEn: `Race ${index}`,
              titleMm: `ပြိုင် ${index}`,
            }),
          ),
        )
      ).map((res) => res.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(3);
      expect(await prisma.homePromo.count({ where: { kind } })).toBe(30);

      await prisma.homePromo.deleteMany({
        where: { kind, titleEn: { startsWith: 'Filler ' } },
      });
    });
  });
});
