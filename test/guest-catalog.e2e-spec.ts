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
  MovieStatus,
  Role,
  SeriesStatus,
  UserStatus,
} from '../src/generated/prisma/client';

/**
 * Anything that would let a guest reach playback data. Image URLs
 * (posterUrl/coverUrl/thumbnailUrl) are deliberately NOT in here — they are
 * the whole point of a browsable catalogue.
 */
const FORBIDDEN_KEY = /hls|playlist|objectKey|stream|video/i;

/** Every key at every depth of a JSON value. */
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

function forbiddenKeysIn(body: unknown): string[] {
  return [...collectKeys(body)].filter((key) => FORBIDDEN_KEY.test(key));
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

interface MovieItem {
  id: string;
  status: string;
  seriesId: string | null;
}

/** One comment of `GET /comments`, as far as the author-privacy checks read it. */
interface CommentItem {
  id: string;
  isMine: boolean;
  user: Record<string, unknown>;
  replies: CommentItem[];
}

/**
 * Guest access to the catalogue: the real AppModule (global JwtAuthGuard +
 * real JwtStrategy) against the isolated e2e database. Proves that a
 * request with no token reads PUBLISHED catalogue metadata only, that the
 * watching/purchase routes are still a 401, and that a staff token on the
 * very same routes keeps its full view.
 */
describe('Guest catalogue (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let adminId: string;
  let adminToken: string;
  let publishedMovieId: string;
  let draftMovieId: string;
  let publishedSeriesId: string;
  let draftSeriesId: string;
  let episodeId: string;
  let hiddenEpisodeId: string;
  let actorId: string;
  let categoryId: string;
  let commenterId: string;
  let commenterDigits: string;
  let commentId: string;

  const movieBase = {
    description: 'guest catalogue fixture',
    genre: 'Action',
    language: 'Burmese',
    releaseYear: 2026,
    duration: 100,
  };

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Pipe/filter/interceptor are registered globally by AppModule — see
    // the note in deposits.e2e-spec.ts.
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);

    const admin = await prisma.user.create({
      data: {
        username: `catalog_admin_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    adminId = admin.id;
    adminToken = await signToken(admin.id);

    const actor = await prisma.actor.create({
      data: { name: `Guest Actor ${suffix}` },
    });
    actorId = actor.id;

    const category = await prisma.category.create({
      data: { name: `Guest Category ${suffix}` },
    });
    categoryId = category.id;

    const published = await prisma.movie.create({
      data: {
        ...movieBase,
        title: `Published ${suffix}`,
        status: MovieStatus.PUBLISHED,
        actors: { connect: { id: actorId } },
      },
    });
    publishedMovieId = published.id;

    const draft = await prisma.movie.create({
      data: {
        ...movieBase,
        title: `Draft ${suffix}`,
        status: MovieStatus.DRAFT,
      },
    });
    draftMovieId = draft.id;

    const publishedSeries = await prisma.series.create({
      data: {
        title: `Published Series ${suffix}`,
        description: movieBase.description,
        genre: movieBase.genre,
        language: movieBase.language,
        releaseYear: 2026,
        status: SeriesStatus.PUBLISHED,
        categories: { connect: { id: categoryId } },
      },
    });
    publishedSeriesId = publishedSeries.id;

    const draftSeries = await prisma.series.create({
      data: {
        title: `Draft Series ${suffix}`,
        description: movieBase.description,
        genre: movieBase.genre,
        language: movieBase.language,
        releaseYear: 2026,
        status: SeriesStatus.DRAFT,
        categories: { connect: { id: categoryId } },
      },
    });
    draftSeriesId = draftSeries.id;

    // A PUBLISHED episode: visible under its series, never in /movies.
    const episode = await prisma.movie.create({
      data: {
        ...movieBase,
        title: `Episode ${suffix}`,
        status: MovieStatus.PUBLISHED,
        seriesId: publishedSeriesId,
        seasonNumber: 1,
        episodeNumber: 1,
      },
    });
    episodeId = episode.id;

    // A PUBLISHED episode of an UNPUBLISHED show: the show must not leak
    // through its episode.
    const hiddenEpisode = await prisma.movie.create({
      data: {
        ...movieBase,
        title: `Hidden Episode ${suffix}`,
        status: MovieStatus.PUBLISHED,
        seriesId: draftSeriesId,
        seasonNumber: 1,
        episodeNumber: 1,
      },
    });
    hiddenEpisodeId = hiddenEpisode.id;

    // A phone sign-up exactly as AuthService.createPhoneAccount makes one:
    // the username IS the phone's digits and no display name was ever set.
    // Its comment on the published movie is what the author-privacy checks
    // below read (SEC-007); the admin's reply makes the replies route and
    // the "someone else's comment" case real too.
    commenterDigits = `9597${String(Date.now()).slice(-7)}`;
    const commenter = await prisma.user.create({
      data: {
        username: `user_${commenterDigits}`,
        password: 'unused-in-these-tests',
        phone: `+${commenterDigits}`,
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    commenterId = commenter.id;
    const comment = await prisma.comment.create({
      data: {
        userId: commenterId,
        movieId: publishedMovieId,
        body: 'guest catalogue comment fixture',
      },
    });
    commentId = comment.id;
    await prisma.comment.create({
      data: {
        userId: adminId,
        movieId: publishedMovieId,
        parentId: commentId,
        body: 'guest catalogue reply fixture',
      },
    });
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite made.
    await prisma.comment.deleteMany({ where: { movieId: publishedMovieId } });
    await prisma.movie.deleteMany({
      where: {
        id: {
          in: [publishedMovieId, draftMovieId, episodeId, hiddenEpisodeId],
        },
      },
    });
    await prisma.series.deleteMany({
      where: { id: { in: [publishedSeriesId, draftSeriesId] } },
    });
    await prisma.actor.deleteMany({ where: { id: actorId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, commenterId] } },
    });
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  describe('GET /movies', () => {
    it('without a token: 200 with PUBLISHED standalone movies only', async () => {
      const res = await api().get('/api/movies').query({ limit: 100 });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: MovieItem[] }>;
      const ids = body.data.items.map((m) => m.id);
      expect(ids).toContain(publishedMovieId);
      expect(ids).not.toContain(draftMovieId);
      expect(ids).not.toContain(episodeId);
      for (const item of body.data.items) {
        expect(item.status).toBe(MovieStatus.PUBLISHED);
        expect(item.seriesId).toBeNull();
      }
      expect(forbiddenKeysIn(body)).toEqual([]);
    });

    it('with an admin token: still returns drafts (staff view unchanged)', async () => {
      const res = await api()
        .get('/api/movies')
        .query({ status: MovieStatus.DRAFT, limit: 100 })
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: MovieItem[] }>;
      expect(body.data.items.map((m) => m.id)).toContain(draftMovieId);
    });

    it('with a bad token: 401, not a silent guest downgrade', async () => {
      await api()
        .get('/api/movies')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('?ids= narrows only: a guest gets the PUBLISHED standalone movie, never the draft or the episode', async () => {
      const res = await api()
        .get('/api/movies')
        .query({ ids: [publishedMovieId, draftMovieId, episodeId].join(',') });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: MovieItem[]; total: number }>;
      expect(body.data.items.map((m) => m.id)).toEqual([publishedMovieId]);
      expect(body.data.total).toBe(1);
    });

    it('?ids= with a value that is not a uuid: 400', async () => {
      await api()
        .get('/api/movies')
        .query({ ids: `${publishedMovieId},not-a-uuid` })
        .expect(400);
    });

    it('facets and most-purchased are open to guests', async () => {
      await api().get('/api/movies/facets').expect(200);
      const res = await api().get('/api/movies/most-purchased').expect(200);
      expect(forbiddenKeysIn(res.body)).toEqual([]);
    });
  });

  describe('GET /movies/:id', () => {
    it('DRAFT without a token: 404', async () => {
      await api().get(`/api/movies/${draftMovieId}`).expect(404);
    });

    it('DRAFT with an admin token: 200', async () => {
      await api()
        .get(`/api/movies/${draftMovieId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('PUBLISHED episode of a DRAFT series: 404 without a token, 200 for staff', async () => {
      await api().get(`/api/movies/${hiddenEpisodeId}`).expect(404);
      await api()
        .get(`/api/movies/${hiddenEpisodeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('PUBLISHED without a token: 200 and carries no playback fields', async () => {
      const res = await api().get(`/api/movies/${publishedMovieId}`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ id: string; actors: unknown[] }>;
      expect(body.data.id).toBe(publishedMovieId);
      expect(body.data.actors).toHaveLength(1);
      expect(forbiddenKeysIn(body)).toEqual([]);
    });
  });

  describe('watching and purchases stay protected', () => {
    it('GET /videos/:id/stream without a token: 401', async () => {
      await api().get(`/api/videos/${publishedMovieId}/stream`).expect(401);
    });

    it('PATCH /videos/:id/watch-progress without a token: 401', async () => {
      await api()
        .patch(`/api/videos/${publishedMovieId}/watch-progress`)
        .send({ progress: 10 })
        .expect(401);
    });

    it('GET /videos/me/watch-history without a token: 401', async () => {
      await api().get('/api/videos/me/watch-history').expect(401);
    });

    it('GET /series/:id/player-episodes without a token: 401', async () => {
      await api()
        .get(`/api/series/${publishedSeriesId}/player-episodes`)
        .expect(401);
    });
  });

  describe('GET /series', () => {
    it('without a token: PUBLISHED series only, no playback fields', async () => {
      const res = await api().get('/api/series').query({ limit: 100 });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: { id: string }[] }>;
      const ids = body.data.items.map((s) => s.id);
      expect(ids).toContain(publishedSeriesId);
      expect(ids).not.toContain(draftSeriesId);
      expect(forbiddenKeysIn(body)).toEqual([]);
    });

    it('facets are open to guests', async () => {
      await api().get('/api/series/facets').expect(200);
    });

    it('?categoryId= returns that category only, and still PUBLISHED only for a guest', async () => {
      const res = await api().get('/api/series').query({ categoryId });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{
        items: { id: string; categories: { id: string }[] }[];
        total: number;
      }>;
      expect(body.data.items.map((s) => s.id)).toEqual([publishedSeriesId]);
      expect(body.data.total).toBe(1);

      // Staff see the draft in the same category too.
      const staff = await api()
        .get('/api/series')
        .query({ categoryId })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const staffBody = staff.body as Envelope<{ items: { id: string }[] }>;
      expect(staffBody.data.items.map((s) => s.id).sort()).toEqual(
        [publishedSeriesId, draftSeriesId].sort(),
      );
    });

    it('?ids= narrows only: a guest never gets the DRAFT series', async () => {
      const res = await api()
        .get('/api/series')
        .query({ ids: `${publishedSeriesId},${draftSeriesId}` });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: { id: string }[] }>;
      expect(body.data.items.map((s) => s.id)).toEqual([publishedSeriesId]);
    });

    it('?categoryId= or ?ids= that is not a uuid: 400', async () => {
      await api().get('/api/series').query({ categoryId: 'drama' }).expect(400);
      await api().get('/api/series').query({ ids: 'nope' }).expect(400);
    });

    it('/:id without a token: PUBLISHED is 200, DRAFT is 404', async () => {
      const res = await api().get(`/api/series/${publishedSeriesId}`);
      expect(res.status).toBe(200);
      expect(forbiddenKeysIn(res.body)).toEqual([]);

      await api().get(`/api/series/${draftSeriesId}`).expect(404);
    });

    it('/:id/episodes without a token: episode metadata only', async () => {
      const res = await api().get(`/api/series/${publishedSeriesId}/episodes`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ id: string }[]>;
      expect(body.data.map((e) => e.id)).toEqual([episodeId]);
      expect(forbiddenKeysIn(body)).toEqual([]);

      await api().get(`/api/series/${draftSeriesId}/episodes`).expect(404);
    });
  });

  /**
   * Security audit 2026-10-09, SEC-007: the public thread used to carry
   * every commenter's username — for a phone sign-up, the phone number —
   * and user id. Now an author is a display name or a `Member #<tag>`
   * pseudonym, and the id rides along only on the reader's own comments.
   */
  describe('GET /comments', () => {
    const memberTag = () => commenterId.slice(0, 4);

    /** Every key and value of the response, as one string to search. */
    const feedText = (body: unknown) => JSON.stringify(body);

    function findFixture(body: Envelope<CommentItem[]>): CommentItem {
      const comment = body.data.find((c) => c.id === commentId);
      expect(comment).toBeDefined();
      return comment!;
    }

    it('without a token: 200, and no author carries a username, a user id or a phone number', async () => {
      const res = await api()
        .get('/api/comments')
        .query({ movieId: publishedMovieId });
      expect(res.status).toBe(200);

      const body = res.body as Envelope<CommentItem[]>;
      const comment = findFixture(body);
      expect(comment.user).toEqual({
        displayName: `Member #${memberTag()}`,
        memberTag: memberTag(),
        avatarUrl: null,
      });
      expect(comment.isMine).toBe(false);
      expect(comment.replies[0].user).not.toHaveProperty('id');
      expect(comment.replies[0].isMine).toBe(false);
      // Not as a key, not inside any value: no `user_<digits>` username,
      // not the phone's digits, not the internal user id.
      expect([...collectKeys(body)]).not.toContain('username');
      expect(feedText(body)).not.toMatch(/user_\d/);
      expect(feedText(body)).not.toContain(commenterDigits);
      expect(feedText(body)).not.toContain(commenterId);
    });

    it('/:id/replies without a token: the same author shape', async () => {
      const res = await api().get(`/api/comments/${commentId}/replies`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<{ items: CommentItem[] }>;
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].user).not.toHaveProperty('username');
      expect(body.data.items[0].user).not.toHaveProperty('id');
      expect(body.data.items[0].isMine).toBe(false);
      expect(feedText(body)).not.toMatch(/user_\d/);
      expect(feedText(body)).not.toContain(adminId);
    });

    it("with the author's own token: isMine and the author id, still no username", async () => {
      const res = await api()
        .get('/api/comments')
        .query({ movieId: publishedMovieId })
        .set('Authorization', `Bearer ${await signToken(commenterId)}`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<CommentItem[]>;
      const comment = findFixture(body);
      expect(comment.isMine).toBe(true);
      expect(comment.user.id).toBe(commenterId);
      expect(comment.user.displayName).toBe(`Member #${memberTag()}`);
      // The admin's reply is still someone else's comment to them.
      expect(comment.replies[0].isMine).toBe(false);
      expect(comment.replies[0].user).not.toHaveProperty('id');
      expect([...collectKeys(body)]).not.toContain('username');
      expect(feedText(body)).not.toMatch(/user_\d/);
      expect(feedText(body)).not.toContain(commenterDigits);
    });

    it('with an admin token: no staff view here — the same anonymous thread', async () => {
      const res = await api()
        .get('/api/comments')
        .query({ movieId: publishedMovieId })
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);

      const body = res.body as Envelope<CommentItem[]>;
      const comment = findFixture(body);
      expect(comment.isMine).toBe(false);
      expect(comment.user).not.toHaveProperty('id');
      expect([...collectKeys(body)]).not.toContain('username');
      expect(feedText(body)).not.toContain(commenterDigits);
      expect(feedText(body)).not.toContain(commenterId);
    });

    it('with a bad token: 401, not a silent guest downgrade', async () => {
      await api()
        .get('/api/comments')
        .query({ movieId: publishedMovieId })
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  describe('GET /actors', () => {
    it('list and detail are open to guests and carry only cast metadata', async () => {
      const list = await api().get('/api/actors').query({ limit: 100 });
      expect(list.status).toBe(200);
      const listBody = list.body as Envelope<{ items: { id: string }[] }>;
      expect(listBody.data.items.map((a) => a.id)).toContain(actorId);
      expect(forbiddenKeysIn(listBody)).toEqual([]);

      const detail = await api().get(`/api/actors/${actorId}`);
      expect(detail.status).toBe(200);
      const detailBody = detail.body as Envelope<Record<string, unknown>>;
      expect(Object.keys(detailBody.data).sort()).toEqual(
        [
          'createdAt',
          'id',
          'imageUrl',
          'movieCount',
          'name',
          'seriesCount',
          'updatedAt',
        ].sort(),
      );
    });
  });
});
