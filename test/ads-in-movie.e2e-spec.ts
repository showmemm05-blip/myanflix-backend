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
  AdvertisementPlaybackStatus,
  MovieStatus,
  Role,
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

interface VideoAd {
  playbackId: string;
  advertisementId: string;
  videoUrl: string;
}

interface Session {
  preroll: VideoAd | null;
  breaks: {
    intervalSeconds: number;
    doneThroughSeconds: number;
    endGuardSeconds: number;
    askAheadSeconds: number;
  } | null;
  corner: {
    playbackId: string;
    advertisementId: string;
    imageUrl: string;
    linkUrl: string | null;
    showSeconds: number | null;
    repeatSeconds: number | null;
    closable: boolean;
    firstShowAfterSeconds: number;
  } | null;
}

interface AdView {
  id: string;
  format: string;
  liveState: string;
  counters: Record<string, number>;
}

const RULES = {
  adsEnabled: true,
  midrollIntervalMinutes: 0,
  duringMovieAudience: 'ALL',
};

/**
 * In-movie ads end to end (2026-11-04): the session (ad before the movie,
 * the break plan, the corner picture), the mid-roll decisions, the corner
 * counters, the admin's type rules and the picture route — the real
 * AppModule against the isolated e2e database. Video and picture keys are
 * written straight into the rows: MinIO is only contacted by the picture
 * route's refusals, which never get that far.
 */
describe('In-movie ads (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  const userIds: string[] = [];
  const movieIds: string[] = [];
  const planIds: string[] = [];
  let adminToken: string;
  let uploaderToken: string;
  let movieId: string;
  let otherMovieId: string;

  const movieBase = {
    description: 'in-movie ads fixture',
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

  async function makeUser(role: Role): Promise<string> {
    const user = await prisma.user.create({
      data: {
        username: `inad_${role.toLowerCase()}_${randomUUID().slice(0, 8)}`,
        password: 'unused-in-these-tests',
        role,
        status: UserStatus.ACTIVE,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeMovie(title: string): Promise<string> {
    const movie = await prisma.movie.create({
      data: { ...movieBase, title, status: MovieStatus.PUBLISHED },
    });
    movieIds.push(movie.id);
    return movie.id;
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

    await prisma.advertisement.deleteMany({});
    await prisma.adSettings.deleteMany({});

    adminToken = await signToken(await makeUser(Role.ADMIN));
    uploaderToken = await signToken(await makeUser(Role.CONTENT_UPLOADER));
    const suffix = randomUUID().slice(0, 8);
    movieId = await makeMovie(`Breaks ${suffix}`);
    otherMovieId = await makeMovie(`Other ${suffix}`);
  });

  afterAll(async () => {
    await prisma.advertisement.deleteMany({});
    await prisma.adSettings.deleteMany({});
    await prisma.userSubscription.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.subscriptionPlan.deleteMany({
      where: { id: { in: planIds } },
    });
    await prisma.movie.deleteMany({ where: { id: { in: movieIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  afterEach(async () => {
    await prisma.advertisement.deleteMany({});
    await setRules({});
  });

  const api = () => request(app.getHttpServer());
  const as = (token: string) => (test: request.Test) =>
    test.set('Authorization', `Bearer ${token}`);
  const asAdmin = (test: request.Test) => as(adminToken)(test);

  async function setRules(over: Partial<typeof RULES>): Promise<void> {
    await asAdmin(
      api()
        .put('/api/ads/admin/settings')
        .send({ ...RULES, ...over }),
    ).expect(200);
  }

  async function viewer(): Promise<{ id: string; token: string }> {
    const id = await makeUser(Role.USER);
    return { id, token: await signToken(id) };
  }

  /** A live VIDEO ad, its video written straight into the row. */
  async function makeVideoAd(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await asAdmin(
      api()
        .post('/api/ads/admin')
        .send({ title: 'Video', ...body }),
    ).expect(201);
    const id = (res.body as Envelope<AdView>).data.id;
    await prisma.advertisement.update({
      where: { id },
      data: {
        videoKey: `ads/${id}/v-c6592c79/video.mp4`,
        videoBytes: 4242,
        durationSeconds: 15,
        videoAttachedAt: new Date(),
        isActive: true,
      },
    });
    return id;
  }

  /** A live CORNER ad, its picture written straight into the row. */
  async function makeCornerAd(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await asAdmin(
      api()
        .post('/api/ads/admin')
        .send({ title: 'Corner', format: 'CORNER', ...body }),
    ).expect(201);
    const id = (res.body as Envelope<AdView>).data.id;
    await prisma.advertisement.update({
      where: { id },
      data: {
        imageKey: `images/ad/${id}/ab12cd34.gif`,
        imageBytes: 2048,
        imageWidth: 300,
        imageHeight: 100,
        imageAttachedAt: new Date(),
        isActive: true,
      },
    });
    return id;
  }

  async function session(token: string, id = movieId): Promise<Session> {
    const res = await as(token)(
      api().post('/api/ads/session').send({ movieId: id }),
    ).expect(200);
    return (res.body as Envelope<Session>).data;
  }

  async function midroll(
    token: string,
    breakAtSeconds: number,
    id = movieId,
  ): Promise<VideoAd | null> {
    const res = await as(token)(
      api().post('/api/ads/midroll').send({ movieId: id, breakAtSeconds }),
    ).expect(200);
    return (res.body as Envelope<{ ad: VideoAd | null }>).data.ad;
  }

  async function send(
    token: string,
    playbackId: string,
    event: string,
    positionSeconds?: number,
  ): Promise<string> {
    const res = await as(token)(
      api()
        .post(`/api/ads/playbacks/${playbackId}/events`)
        .send(
          positionSeconds === undefined
            ? { event }
            : { event, positionSeconds },
        ),
    ).expect(200);
    return (res.body as Envelope<{ status: string }>).data.status;
  }

  describe('the playback rules', () => {
    it('validates every field and audits the change', async () => {
      await asAdmin(
        api().put('/api/ads/admin/settings').send({ adsEnabled: true }),
      ).expect(400);
      await asAdmin(
        api()
          .put('/api/ads/admin/settings')
          .send({ ...RULES, midrollIntervalMinutes: 241 }),
      ).expect(400);
      await asAdmin(
        api()
          .put('/api/ads/admin/settings')
          .send({ ...RULES, duringMovieAudience: 'SOME' }),
      ).expect(400);
      await as(uploaderToken)(
        api().put('/api/ads/admin/settings').send(RULES),
      ).expect(403);
      await setRules({
        midrollIntervalMinutes: 30,
        duringMovieAudience: 'NON_PREMIUM',
      });
      const read = await asAdmin(api().get('/api/ads/admin/settings')).expect(
        200,
      );
      expect(
        (read.body as Envelope<Record<string, unknown>>).data,
      ).toMatchObject({
        ...RULES,
        midrollIntervalMinutes: 30,
        duringMovieAudience: 'NON_PREMIUM',
        liveCounts: { preroll: 0, breaks: 0, corner: 0 },
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'advertisement_settings.update' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.after).toMatchObject({ midrollIntervalMinutes: 30 });
    });

    it('switched off: no ads anywhere and no rows written', async () => {
      await makeVideoAd({ playsAtBreaks: true });
      await makeCornerAd();
      await setRules({ adsEnabled: false, midrollIntervalMinutes: 30 });
      const v = await viewer();
      expect(await session(v.token)).toEqual({
        preroll: null,
        breaks: null,
        corner: null,
      });
      expect(await midroll(v.token, 1800)).toBeNull();
      const legacy = await as(v.token)(
        api().post('/api/ads/preroll').send({ movieId }),
      ).expect(200);
      expect((legacy.body as Envelope<{ ad: unknown }>).data.ad).toBeNull();
      expect(
        await prisma.advertisementPlayback.count({ where: { userId: v.id } }),
      ).toBe(0);
    });
  });

  describe('the session', () => {
    it('gives the ad before the movie, the break plan and the corner in one answer', async () => {
      const videoId = await makeVideoAd({ playsAtBreaks: true });
      const cornerId = await makeCornerAd({
        linkUrl: 'https://shop.example.com/deal',
        cornerShowSeconds: 10,
        cornerRepeatMinutes: 15,
      });
      await setRules({ midrollIntervalMinutes: 30 });
      const v = await viewer();
      const s = await session(v.token);
      expect(s.preroll?.advertisementId).toBe(videoId);
      expect(s.breaks).toEqual({
        intervalSeconds: 1800,
        doneThroughSeconds: 0,
        endGuardSeconds: 120,
        askAheadSeconds: 20,
      });
      expect(s.corner).toMatchObject({
        advertisementId: cornerId,
        linkUrl: 'https://shop.example.com/deal',
        showSeconds: 10,
        repeatSeconds: 900,
        closable: true,
        firstShowAfterSeconds: 60,
      });
      expect(s.corner?.imageUrl).toMatch(
        new RegExp(`/movies/images/ad/${cornerId}/ab12cd34\\.gif$`),
      );
      // A refresh hands both open rows back.
      const again = await session(v.token);
      expect(again.preroll?.playbackId).toBe(s.preroll?.playbackId);
      expect(again.corner?.playbackId).toBe(s.corner?.playbackId);
      const rows = await prisma.advertisementPlayback.findMany({
        where: { userId: v.id },
        select: { placement: true },
      });
      expect(rows.map((r) => r.placement).sort()).toEqual([
        'CORNER',
        'PREROLL',
      ]);
    });

    it('no break plan without an interval or without an ad that plays at breaks', async () => {
      await makeVideoAd();
      const v = await viewer();
      await setRules({ midrollIntervalMinutes: 30 });
      expect((await session(v.token)).breaks).toBeNull();
      await setRules({ midrollIntervalMinutes: 0 });
      await makeVideoAd({ playsAtBreaks: true });
      expect((await session(v.token)).breaks).toBeNull();
    });

    it('a corner picture and a break-only video ad are never the ad before the movie', async () => {
      await makeVideoAd({ playsBeforeMovie: false, playsAtBreaks: true });
      await makeCornerAd();
      const v = await viewer();
      expect((await session(v.token)).preroll).toBeNull();
      const legacy = await as(v.token)(
        api().post('/api/ads/preroll').send({ movieId }),
      ).expect(200);
      expect((legacy.body as Envelope<{ ad: unknown }>).data.ad).toBeNull();
    });

    it('"Only viewers without Premium": a member gets no breaks or corner, but still the ad before the movie', async () => {
      const videoId = await makeVideoAd({ playsAtBreaks: true });
      await makeCornerAd();
      await setRules({
        midrollIntervalMinutes: 30,
        duringMovieAudience: 'NON_PREMIUM',
      });
      const member = await viewer();
      const plan = await prisma.subscriptionPlan.create({
        data: { name: `Ads plan ${randomUUID().slice(0, 8)}`, price: 5000 },
      });
      planIds.push(plan.id);
      await prisma.userSubscription.create({
        data: {
          userId: member.id,
          planId: plan.id,
          amount: plan.price,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const s = await session(member.token);
      expect(s.preroll?.advertisementId).toBe(videoId);
      expect(s.breaks).toBeNull();
      expect(s.corner).toBeNull();
      expect(await midroll(member.token, 1800)).toBeNull();

      const free = await viewer();
      const f = await session(free.token);
      expect(f.breaks).not.toBeNull();
      expect(f.corner).not.toBeNull();
    });
  });

  describe('mid-roll breaks', () => {
    beforeEach(async () => {
      await setRules({ midrollIntervalMinutes: 30 });
    });

    it('decides a break once, hands it back on a refresh, remembers it when played', async () => {
      const breakAd = await makeVideoAd({
        playsBeforeMovie: false,
        playsAtBreaks: true,
      });
      const v = await viewer();
      const first = await midroll(v.token, 1800);
      expect(first?.advertisementId).toBe(breakAd);
      expect((await midroll(v.token, 1800))?.playbackId).toBe(
        first?.playbackId,
      );
      expect(await send(v.token, first!.playbackId, 'started')).toBe('STARTED');
      expect(await send(v.token, first!.playbackId, 'completed')).toBe(
        'COMPLETED',
      );
      // Played: never again, and never one before it; the next session knows.
      expect(await midroll(v.token, 1800)).toBeNull();
      expect(await midroll(v.token, 60)).toBeNull();
      expect((await session(v.token)).breaks?.doneThroughSeconds).toBe(1800);
      expect(await midroll(v.token, 3600)).not.toBeNull();
      // Another title keeps its own breaks.
      expect(await midroll(v.token, 1800, otherMovieId)).not.toBeNull();
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: first!.playbackId },
      });
      expect(row).toMatchObject({ placement: 'MIDROLL', breakAtSeconds: 1800 });
    });

    it('a jump past an asked-about break moves that decision to the furthest break', async () => {
      await makeVideoAd({ playsBeforeMovie: false, playsAtBreaks: true });
      const v = await viewer();
      const asked = await midroll(v.token, 1800); // asked ~20 s ahead, never played
      const jumped = await midroll(v.token, 5400); // the viewer jumped over 1800, 3600, 5400
      expect(jumped?.playbackId).toBe(asked?.playbackId);
      expect(await send(v.token, jumped!.playbackId, 'started')).toBe(
        'STARTED',
      );
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: jumped!.playbackId },
      });
      expect(row.breakAtSeconds).toBe(5400);
      expect((await session(v.token)).breaks?.doneThroughSeconds).toBe(5400);
      expect(await midroll(v.token, 3600)).toBeNull();
    });

    it('refuses a break that is not a whole minute, and a title that does not exist', async () => {
      const v = await viewer();
      await as(v.token)(
        api().post('/api/ads/midroll').send({ movieId, breakAtSeconds: 1810 }),
      ).expect(400);
      await as(v.token)(
        api()
          .post('/api/ads/midroll')
          .send({ movieId: randomUUID(), breakAtSeconds: 1800 }),
      ).expect(404);
    });

    it('a break never disturbs the open decision before the movie', async () => {
      await makeVideoAd({ playsAtBreaks: true });
      const v = await viewer();
      const open = await session(v.token);
      await midroll(v.token, 1800);
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: open.preroll!.playbackId },
      });
      expect(row.status).toBe(AdvertisementPlaybackStatus.PENDING);
      expect((await session(v.token)).preroll?.playbackId).toBe(
        open.preroll!.playbackId,
      );
    });

    it('a break just played does not stop the ad before the movie on the next open', async () => {
      await makeVideoAd({ playsAtBreaks: true });
      const v = await viewer();
      const b = await midroll(v.token, 1800);
      await send(v.token, b!.playbackId, 'started');
      expect((await session(v.token)).preroll).not.toBeNull();
    });

    it('the per-ad cap counts every placement', async () => {
      await makeVideoAd({
        playsAtBreaks: true,
        maxImpressionsPerUserPerDay: 1,
      });
      const v = await viewer();
      const s = await session(v.token);
      await send(v.token, s.preroll!.playbackId, 'started');
      expect(await midroll(v.token, 1800)).toBeNull();
    });
  });

  describe('the corner picture', () => {
    it('counts showings and taps, and a close ends it for the viewing', async () => {
      const cornerId = await makeCornerAd({
        linkUrl: 'https://shop.example.com',
      });
      const v = await viewer();
      const c = (await session(v.token)).corner!;
      expect(await send(v.token, c.playbackId, 'started')).toBe('STARTED');
      await send(v.token, c.playbackId, 'shown');
      await send(v.token, c.playbackId, 'shown');
      await send(v.token, c.playbackId, 'clicked');
      expect(await send(v.token, c.playbackId, 'completed')).toBe('STARTED');
      expect((await session(v.token)).corner?.playbackId).toBe(c.playbackId);
      expect(await send(v.token, c.playbackId, 'skipped', 12)).toBe('SKIPPED');
      expect((await session(v.token)).corner).toBeNull();

      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: c.playbackId },
      });
      expect(row).toMatchObject({ repeatCount: 2, clickCount: 1 });
      const list = await asAdmin(
        api().get('/api/ads/admin?format=CORNER'),
      ).expect(200);
      const view = (list.body as Envelope<{ items: AdView[] }>).data.items.find(
        (ad) => ad.id === cornerId,
      );
      expect(view?.counters).toMatchObject({
        impressions: 1,
        shows: 3,
        clicks: 1,
        closes: 1,
        skips: 0,
      });
      // Today in Myanmar time (the default period is the last 7 FULL days).
      const today = new Date(Date.now() + 390 * 60_000)
        .toISOString()
        .slice(0, 10);
      const overview = await asAdmin(
        api().get(
          `/api/ads/admin/analytics/overview?placement=CORNER&from=${today}&to=${today}`,
        ),
      ).expect(200);
      expect(
        (overview.body as Envelope<{ current: Record<string, unknown> }>).data
          .current,
      ).toMatchObject({ impressions: 1, shows: 3, clicks: 1, closes: 1 });
    });

    it('"shown" and "clicked" do nothing to a video play', async () => {
      await makeVideoAd();
      const v = await viewer();
      const s = await session(v.token);
      await send(v.token, s.preroll!.playbackId, 'started');
      await send(v.token, s.preroll!.playbackId, 'clicked');
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: s.preroll!.playbackId },
      });
      expect(row.clickCount).toBe(0);
    });
  });

  describe('admin rules for the two types', () => {
    it('a corner ad keeps its type, refuses video fields, and needs its picture to go live', async () => {
      const res = await asAdmin(
        api()
          .post('/api/ads/admin')
          .send({ title: 'Corner', format: 'CORNER' }),
      ).expect(201);
      const id = (res.body as Envelope<AdView>).data.id;
      expect((res.body as Envelope<AdView>).data.liveState).toBe('NO_VIDEO');
      await asAdmin(
        api().patch(`/api/ads/admin/${id}`).send({ format: 'VIDEO' }),
      ).expect(400);
      const mismatch = await asAdmin(
        api()
          .patch(`/api/ads/admin/${id}`)
          .send({ isSkippable: true, skipAfterSeconds: 5 }),
      ).expect(400);
      expect((mismatch.body as ErrorEnvelope).code).toBe('AD_FORMAT_MISMATCH');
      const off = await asAdmin(
        api().patch(`/api/ads/admin/${id}`).send({ isActive: true }),
      ).expect(400);
      expect((off.body as ErrorEnvelope).code).toBe('AD_IMAGE_REQUIRED');
      const attach = await asAdmin(
        api()
          .post(`/api/ads/admin/${id}/video/attach`)
          .send({ relativePath: 'video.mp4' }),
      ).expect(400);
      expect((attach.body as ErrorEnvelope).code).toBe('AD_FORMAT_MISMATCH');
    });

    it('a video ad must play somewhere', async () => {
      const res = await asAdmin(
        api().post('/api/ads/admin').send({
          title: 'Nowhere',
          playsBeforeMovie: false,
          playsAtBreaks: false,
        }),
      ).expect(400);
      expect((res.body as ErrorEnvelope).code).toBe('AD_SLOTS_REQUIRED');
    });

    it('the picture route: staff with ADS.MANAGE only, corner ads only, pictures only', async () => {
      const corner = await asAdmin(
        api()
          .post('/api/ads/admin')
          .send({ title: 'Corner', format: 'CORNER' }),
      ).expect(201);
      const cornerId = (corner.body as Envelope<AdView>).data.id;
      const videoId = (
        (
          await asAdmin(
            api().post('/api/ads/admin').send({ title: 'Video' }),
          ).expect(201)
        ).body as Envelope<AdView>
      ).data.id;
      const gifHeader = Buffer.from('GIF89a\x2c\x01\x64\x00', 'latin1');

      const v = await viewer();
      await as(v.token)(
        api()
          .post(`/api/ads/admin/${cornerId}/image`)
          .attach('file', gifHeader, 'a.gif'),
      ).expect(403);
      await as(uploaderToken)(
        api()
          .post(`/api/ads/admin/${cornerId}/image`)
          .attach('file', gifHeader, 'a.gif'),
      ).expect(403);
      const wrongType = await asAdmin(
        api()
          .post(`/api/ads/admin/${videoId}/image`)
          .attach('file', gifHeader, 'a.gif'),
      ).expect(400);
      expect((wrongType.body as ErrorEnvelope).code).toBe('AD_FORMAT_MISMATCH');
      const pdf = await asAdmin(
        api()
          .post(`/api/ads/admin/${cornerId}/image`)
          .attach('file', Buffer.from('%PDF-1.7 nope'), 'a.pdf'),
      ).expect(400);
      expect((pdf.body as ErrorEnvelope).code).toBe('AD_IMAGE_UNSUPPORTED');
      const big = Buffer.alloc(4 * 1024 * 1024);
      big.write('GIF89a', 0, 'latin1');
      const tooBig = await asAdmin(
        api()
          .post(`/api/ads/admin/${cornerId}/image`)
          .attach('file', big, 'big.gif'),
      ).expect(413);
      expect((tooBig.body as ErrorEnvelope).code).toBe('AD_IMAGE_TOO_LARGE');
    });
  });
});
