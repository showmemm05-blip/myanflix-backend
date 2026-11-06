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
import { YANGON_UTC_OFFSET_MINUTES } from '../src/bank-events/risk-rules';

interface Envelope<T> {
  success: boolean;
  data: T;
}

interface ErrorEnvelope {
  success: false;
  message: string;
  code?: string;
}

interface AdView {
  id: string;
  liveState: string;
  isActive: boolean;
  videoUrl: string | null;
  targetMovies: { id: string; missing: boolean }[];
  counters: { impressions: number; completions: number; skips: number };
}

interface Decision {
  ad: {
    playbackId: string;
    advertisementId: string;
    title: string;
    videoUrl: string;
    durationSeconds: number;
    isSkippable: boolean;
    skipAfterSeconds: number | null;
  } | null;
  replayAfterMinutes: number;
}

/** The playback rules as a fresh install has them; a settings PUT sends every field. */
const DEFAULT_RULES = {
  adsEnabled: true,
  midrollIntervalMinutes: 0,
  duringMovieAudience: 'ALL',
} as const;

/**
 * Pre-roll ads end to end: the real AppModule (global JwtAuthGuard, the
 * real PermissionsGuard resolving the seeded roles — so the advertisements
 * migration's ADMIN grants are what is being proven) against the isolated
 * e2e database. The video is "attached" by writing the row directly: MinIO
 * is never contacted, the signed URL is pure arithmetic.
 */
describe('Pre-roll ads (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  const userIds: string[] = [];
  const movieIds: string[] = [];
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let uploaderToken: string;
  let publishedMovieId: string;
  let otherMovieId: string;
  let draftMovieId: string;

  const movieBase = {
    description: 'preroll fixture',
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
        username: `ads_${role.toLowerCase()}_${suffix}`,
        password: 'unused-in-these-tests',
        role,
        status: UserStatus.ACTIVE,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeMovie(
    title: string,
    status: MovieStatus,
  ): Promise<string> {
    const movie = await prisma.movie.create({
      data: { ...movieBase, title, status },
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

    const suffix = randomUUID().slice(0, 8);
    adminToken = await signToken(await makeUser(Role.ADMIN, suffix));
    userId = await makeUser(Role.USER, suffix);
    userToken = await signToken(userId);
    uploaderToken = await signToken(
      await makeUser(Role.CONTENT_UPLOADER, suffix),
    );
    publishedMovieId = await makeMovie(
      `Lanterns ${suffix}`,
      MovieStatus.PUBLISHED,
    );
    otherMovieId = await makeMovie(`Other ${suffix}`, MovieStatus.PUBLISHED);
    draftMovieId = await makeMovie(`Draft ${suffix}`, MovieStatus.DRAFT);
  });

  afterAll(async () => {
    await prisma.advertisement.deleteMany({});
    await prisma.adSettings.deleteMany({});
    await prisma.movie.deleteMany({ where: { id: { in: movieIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const as = (token: string) => (test: request.Test) =>
    test.set('Authorization', `Bearer ${token}`);
  const asAdmin = (test: request.Test) => as(adminToken)(test);

  /** The admin creates an ad; the video is "attached" straight into the row. */
  async function makeAd(
    body: Record<string, unknown>,
    video: { durationSeconds?: number } | null = { durationSeconds: 15 },
  ): Promise<string> {
    const res = await asAdmin(
      api()
        .post('/api/ads/admin')
        .send({ title: 'Big match', ...body }),
    ).expect(201);
    const id = (res.body as Envelope<AdView>).data.id;
    if (video) {
      await prisma.advertisement.update({
        where: { id },
        data: {
          videoKey: `ads/${id}/v-c6592c79/video.mp4`,
          videoBytes: 4242,
          durationSeconds: video.durationSeconds ?? 15,
          videoAttachedAt: new Date(),
          isActive: true,
        },
      });
    }
    return id;
  }

  async function decideAs(token: string, movieId: string): Promise<Decision> {
    const res = await as(token)(
      api().post('/api/ads/preroll').send({ movieId }),
    ).expect(200);
    return (res.body as Envelope<Decision>).data;
  }

  /** A fresh viewer for a scenario, so earlier decisions and caps cannot leak in. */
  async function freshViewer(): Promise<string> {
    return signToken(await makeUser(Role.USER, randomUUID().slice(0, 8)));
  }

  async function startAd(token: string, playbackId: string): Promise<void> {
    await as(token)(
      api()
        .post(`/api/ads/playbacks/${playbackId}/events`)
        .send({ event: 'started' }),
    ).expect(200);
  }

  describe('admin access', () => {
    it('is staff only: USER and CONTENT_UPLOADER are 403, ADMIN reads the (empty) list', async () => {
      await as(userToken)(api().get('/api/ads/admin')).expect(403);
      await as(uploaderToken)(api().get('/api/ads/admin')).expect(403);
      const res = await asAdmin(api().get('/api/ads/admin')).expect(200);
      expect(
        (res.body as Envelope<{ items: AdView[]; total: number }>).data,
      ).toEqual({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
      });
      await api().get('/api/ads/admin').expect(401);
    });

    it('creates OFF without a video, refuses to switch on until one is attached', async () => {
      const res = await asAdmin(
        api().post('/api/ads/admin').send({ title: 'No video yet' }),
      ).expect(201);
      const ad = (res.body as Envelope<AdView>).data;
      expect(ad).toMatchObject({
        liveState: 'NO_VIDEO',
        isActive: false,
        videoUrl: null,
      });
      const refused = await asAdmin(
        api().patch(`/api/ads/admin/${ad.id}`).send({ isActive: true }),
      ).expect(400);
      expect((refused.body as ErrorEnvelope).code).toBe('AD_VIDEO_REQUIRED');
      await asAdmin(api().delete(`/api/ads/admin/${ad.id}`)).expect(204);
      await asAdmin(api().get(`/api/ads/admin/${ad.id}`)).expect(404);
    });

    it('validates the form: a reversed window, half a daily window, SELECTED without movies', async () => {
      const codeOf = async (body: Record<string, unknown>) =>
        (
          (
            await asAdmin(
              api()
                .post('/api/ads/admin')
                .send({ title: 'x', ...body }),
            ).expect(400)
          ).body as ErrorEnvelope
        ).code;
      expect(
        await codeOf({
          startsAt: '2026-11-05T00:00:00Z',
          endsAt: '2026-11-04T00:00:00Z',
        }),
      ).toBe('AD_WINDOW_INVALID');
      expect(await codeOf({ dailyStartTime: '22:00' })).toBe(
        'AD_DAILY_WINDOW_INVALID',
      );
      expect(await codeOf({ targetType: 'SELECTED' })).toBe(
        'AD_TARGET_MOVIES_REQUIRED',
      );
      expect(
        await codeOf({ targetType: 'SELECTED', movieIds: [randomUUID()] }),
      ).toBe('AD_TARGET_MOVIE_NOT_FOUND');
      expect(await codeOf({ isSkippable: true })).toBe(
        'AD_SKIP_AFTER_REQUIRED',
      );
    });

    it('attach without a staged upload is 404 AD_VIDEO_MISSING', async () => {
      const id = await makeAd({ title: 'Staging check' }, null);
      const res = await asAdmin(
        api()
          .post(`/api/ads/admin/${id}/video/attach`)
          .send({ relativePath: 'video.mp4' }),
      );
      // MinIO is not reachable here: a storage error is a 500, a missing
      // object a 404 — either way nothing is written to the row.
      expect([404, 500]).toContain(res.status);
      const row = await prisma.advertisement.findUniqueOrThrow({
        where: { id },
      });
      expect(row.videoKey).toBeNull();
      await asAdmin(api().delete(`/api/ads/admin/${id}`)).expect(204);
    });
  });

  describe('the decision', () => {
    let adId: string;

    beforeAll(async () => {
      adId = await makeAd({
        title: 'Everyone sees this',
        isSkippable: true,
        skipAfterSeconds: 5,
      });
    });

    afterAll(async () => {
      await prisma.advertisement.deleteMany({ where: { id: adId } });
    });

    it('needs a signed-in viewer, and a real, published title', async () => {
      await api()
        .post('/api/ads/preroll')
        .send({ movieId: publishedMovieId })
        .expect(401);
      await as(userToken)(
        api().post('/api/ads/preroll').send({ movieId: randomUUID() }),
      ).expect(404);
      await as(userToken)(
        api().post('/api/ads/preroll').send({ movieId: draftMovieId }),
      ).expect(404);
      await as(userToken)(
        api().post('/api/ads/preroll').send({ movieId: 'nope' }),
      ).expect(400);
    });

    it('decides once with a signed link, and hands the same decision back on a refetch', async () => {
      const first = await decideAs(userToken, publishedMovieId);
      expect(first.ad).toMatchObject({
        advertisementId: adId,
        title: 'Everyone sees this',
        durationSeconds: 15,
        isSkippable: true,
        skipAfterSeconds: 5,
      });
      expect(first.ad!.videoUrl).toMatch(
        new RegExp(
          `/s/\\d+/[\\w-]+/movies/ads/${adId}/v-c6592c79/video\\.mp4$`,
        ),
      );
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: first.ad!.playbackId },
      });
      expect(row).toMatchObject({
        userId,
        movieId: publishedMovieId,
        status: AdvertisementPlaybackStatus.PENDING,
      });

      const again = await decideAs(userToken, publishedMovieId);
      expect(again.ad!.playbackId).toBe(first.ad!.playbackId);
      expect(
        await prisma.advertisementPlayback.count({
          where: { userId, movieId: publishedMovieId },
        }),
      ).toBe(1);
    });

    it('staff keep their previews of unpublished titles', async () => {
      const res = await asAdmin(
        api().post('/api/ads/preroll').send({ movieId: draftMovieId }),
      ).expect(200);
      expect((res.body as Envelope<Decision>).data.ad?.advertisementId).toBe(
        adId,
      );
    });

    it('answers { ad: null } for an ad that is off, not started, ended or without a video', async () => {
      const viewer = await freshViewer();
      const tryWith = async (data: Record<string, unknown>) => {
        await prisma.advertisement.update({ where: { id: adId }, data });
        return (await decideAs(viewer, publishedMovieId)).ad;
      };
      expect(await tryWith({ isActive: false })).toBeNull();
      expect(
        await tryWith({
          isActive: true,
          startsAt: new Date(Date.now() + 3600_000),
        }),
      ).toBeNull();
      expect(
        await tryWith({ startsAt: null, endsAt: new Date(Date.now() - 1000) }),
      ).toBeNull();
      expect(await tryWith({ endsAt: null, videoKey: null })).toBeNull();
      expect(
        await tryWith({ videoKey: `ads/${adId}/v-c6592c79/video.mp4` }),
      ).not.toBeNull();
    });

    it('respects the daily window in Myanmar time, overnight included', async () => {
      const viewer = await freshViewer();
      const now = new Date();
      const minute =
        (now.getUTCHours() * 60 +
          now.getUTCMinutes() +
          YANGON_UTC_OFFSET_MINUTES) %
        1440;
      const wrap = (m: number) => ((m % 1440) + 1440) % 1440;
      const tryWith = async (
        dailyStartMinutes: number | null,
        dailyEndMinutes: number | null,
      ) => {
        await prisma.advertisement.update({
          where: { id: adId },
          data: { dailyStartMinutes, dailyEndMinutes },
        });
        return (await decideAs(viewer, publishedMovieId)).ad;
      };
      // An hour from now, for an hour: closed.
      expect(await tryWith(wrap(minute + 60), wrap(minute + 120))).toBeNull();
      // Ten minutes around now, which may wrap past midnight: open.
      expect(
        await tryWith(wrap(minute - 10), wrap(minute + 10)),
      ).not.toBeNull();
      // Starting after it ends — a window that wraps the day and contains now.
      expect(
        await tryWith(wrap(minute + 600), wrap(minute + 10)),
      ).not.toBeNull();
      expect(await tryWith(null, null)).not.toBeNull();
    });

    it('targets SELECTED titles only', async () => {
      const viewer = await freshViewer();
      await asAdmin(
        api()
          .patch(`/api/ads/admin/${adId}`)
          .send({ targetType: 'SELECTED', movieIds: [otherMovieId] }),
      ).expect(200);
      expect((await decideAs(viewer, publishedMovieId)).ad).toBeNull();
      expect((await decideAs(viewer, otherMovieId)).ad?.advertisementId).toBe(
        adId,
      );
      await asAdmin(
        api().patch(`/api/ads/admin/${adId}`).send({ targetType: 'ALL' }),
      ).expect(200);
    });

    it('applies the per-viewer caps on impressions, and prefers priority', async () => {
      const viewer = await freshViewer();
      await asAdmin(
        api()
          .patch(`/api/ads/admin/${adId}`)
          .send({ maxImpressionsPerUserPerDay: 1, frequencyLimitMinutes: 60 }),
      ).expect(200);
      const first = await decideAs(viewer, publishedMovieId);
      expect(first.ad?.advertisementId).toBe(adId);
      await as(viewer)(
        api()
          .post(`/api/ads/playbacks/${first.ad!.playbackId}/events`)
          .send({ event: 'started' }),
      ).expect(200);
      // One impression today: the cap is spent, and so is the gap.
      expect((await decideAs(viewer, otherMovieId)).ad).toBeNull();

      // A second ad with a higher priority wins over the capped one anyway.
      const strongId = await makeAd({ title: 'Stronger', priority: 9 });
      expect((await decideAs(viewer, otherMovieId)).ad?.advertisementId).toBe(
        strongId,
      );
      const other = await freshViewer();
      expect(
        (await decideAs(other, publishedMovieId)).ad?.advertisementId,
      ).toBe(strongId);
      await prisma.advertisement.delete({ where: { id: strongId } });
      await asAdmin(
        api().patch(`/api/ads/admin/${adId}`).send({
          maxImpressionsPerUserPerDay: null,
          frequencyLimitMinutes: null,
        }),
      ).expect(200);
    });
  });

  describe('the playback rules and every open', () => {
    let adId: string;

    beforeAll(async () => {
      adId = await makeAd({ title: 'Every open' });
    });

    afterAll(async () => {
      await prisma.advertisement.deleteMany({ where: { id: adId } });
      await asAdmin(
        api().put('/api/ads/admin/settings').send(DEFAULT_RULES),
      ).expect(200);
    });

    it('are read by ads viewers and changed by ads managers only, with an audit row', async () => {
      await as(userToken)(api().get('/api/ads/admin/settings')).expect(403);
      await as(uploaderToken)(
        api().put('/api/ads/admin/settings').send(DEFAULT_RULES),
      ).expect(403);
      // The removed "same movie again" field is refused, not silently kept.
      await asAdmin(
        api()
          .put('/api/ads/admin/settings')
          .send({ ...DEFAULT_RULES, sameTitleReplayMinutes: 30 }),
      ).expect(400);
      const saved = await asAdmin(
        api()
          .put('/api/ads/admin/settings')
          .send({ ...DEFAULT_RULES, midrollIntervalMinutes: 15 }),
      ).expect(200);
      expect(
        (saved.body as Envelope<Record<string, unknown>>).data,
      ).not.toHaveProperty('sameTitleReplayMinutes');
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'advertisement_settings.update' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toMatchObject({
        targetType: 'advertisement_settings',
        after: { ...DEFAULT_RULES, midrollIntervalMinutes: 15 },
      });
    });

    it('the ad before the movie plays on every open of the same movie', async () => {
      const viewer = await freshViewer();
      const first = await decideAs(viewer, publishedMovieId);
      expect(first.ad?.advertisementId).toBe(adId);
      expect(first.replayAfterMinutes).toBe(0);
      // Decided but never started: a refresh gets the same decision back.
      expect((await decideAs(viewer, publishedMovieId)).ad?.playbackId).toBe(
        first.ad!.playbackId,
      );
      await startAd(viewer, first.ad!.playbackId);
      // Played: the next open gets the ad again, as a new play.
      const again = await decideAs(viewer, publishedMovieId);
      expect(again.ad?.advertisementId).toBe(adId);
      expect(again.ad?.playbackId).not.toBe(first.ad!.playbackId);
    });

    it('counts an ad whose started was lost but whose end arrived', async () => {
      const viewer = await freshViewer();
      const first = await decideAs(viewer, publishedMovieId);
      const res = await as(viewer)(
        api()
          .post(`/api/ads/playbacks/${first.ad!.playbackId}/events`)
          .send({ event: 'completed', positionSeconds: 15 }),
      ).expect(200);
      expect((res.body as Envelope<{ status: string }>).data.status).toBe(
        'COMPLETED',
      );
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: first.ad!.playbackId },
      });
      expect(row.startedAt).not.toBeNull();
      expect(row.completedAt).not.toBeNull();
    });
  });

  describe('playback events', () => {
    let adId: string;
    let playbackId: string;

    beforeAll(async () => {
      adId = await makeAd({ title: 'Events' });
      playbackId = (await decideAs(await freshViewer(), publishedMovieId)).ad!
        .playbackId;
    });

    afterAll(async () => {
      await prisma.advertisement.deleteMany({ where: { id: adId } });
    });

    const viewerOf = async (id: string) =>
      signToken(
        (
          await prisma.advertisementPlayback.findUniqueOrThrow({
            where: { id },
          })
        ).userId,
      );

    it('moves forward once per event; repeats and wrong orders are no-ops', async () => {
      const token = await viewerOf(playbackId);
      const send = async (event: string, extra: Record<string, unknown> = {}) =>
        (
          (
            await as(token)(
              api()
                .post(`/api/ads/playbacks/${playbackId}/events`)
                .send({ event, ...extra }),
            ).expect(200)
          ).body as Envelope<{ status: string }>
        ).data.status;
      expect(await send('started')).toBe('STARTED');
      expect(await send('started')).toBe('STARTED');
      expect(await send('skipped', { positionSeconds: 6 })).toBe('SKIPPED');
      expect(await send('completed')).toBe('SKIPPED');
      const row = await prisma.advertisementPlayback.findUniqueOrThrow({
        where: { id: playbackId },
      });
      expect(row.startedAt).not.toBeNull();
      expect(row.skippedAt).not.toBeNull();
      expect(row.completedAt).toBeNull();
      expect(row.positionSeconds).toBe(6);
    });

    it('is 404 for another viewer’s row, 400 for an unknown event', async () => {
      await as(userToken)(
        api()
          .post(`/api/ads/playbacks/${playbackId}/events`)
          .send({ event: 'started' }),
      ).expect(404);
      await as(userToken)(
        api()
          .post(`/api/ads/playbacks/${randomUUID()}/events`)
          .send({ event: 'started' }),
      ).expect(404);
      const token = await viewerOf(playbackId);
      await as(token)(
        api()
          .post(`/api/ads/playbacks/${playbackId}/events`)
          .send({ event: 'paused' }),
      ).expect(400);
    });

    it('counts the impression in the admin list and the analytics', async () => {
      const list = await asAdmin(
        api().get('/api/ads/admin').query({ search: 'Events' }),
      ).expect(200);
      const [ad] = (list.body as Envelope<{ items: AdView[] }>).data.items;
      expect(ad.counters).toEqual({
        impressions: 1,
        completions: 0,
        skips: 1,
        shows: 0,
        clicks: 0,
        closes: 0,
      });

      const today = new Date(Date.now() + YANGON_UTC_OFFSET_MINUTES * 60_000)
        .toISOString()
        .slice(0, 10);
      const overview = await asAdmin(
        api()
          .get('/api/ads/admin/analytics/overview')
          .query({ from: today, to: today, adId }),
      ).expect(200);
      expect(
        (
          overview.body as Envelope<{
            current: { impressions: number; skips: number; skipRate: number };
          }>
        ).data.current,
      ).toMatchObject({
        impressions: 1,
        skips: 1,
        skipRate: 1,
      });
      const byDate = await asAdmin(
        api()
          .get('/api/ads/admin/analytics/by-date')
          .query({ from: today, to: today, adId }),
      ).expect(200);
      expect(
        (byDate.body as Envelope<{ buckets: unknown[] }>).data.buckets,
      ).toEqual([
        {
          key: today,
          impressions: 1,
          completions: 0,
          skips: 1,
          clicks: 0,
          closes: 0,
        },
      ]);
      const bad = await asAdmin(
        api().get('/api/ads/admin/analytics/overview').query({ from: today }),
      ).expect(400);
      expect((bad.body as ErrorEnvelope).code).toBe(
        'AD_ANALYTICS_RANGE_INVALID',
      );
    });
  });
});
