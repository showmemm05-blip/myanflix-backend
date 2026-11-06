/**
 * Old-vs-new parity on a REAL Postgres for the comment-thread reply preview
 * (performance audit 2026-10-07, db-13). The "old" side is one bounded read
 * per top-level comment — the same VISIBLE filter, oldest-first order and
 * REPLY_PREVIEW_LIMIT the thread has always used; the "new" side is
 * CommentsService.findForTitle as it is now (one shared read plus one
 * grouped row_number() query for the busy comments).
 *
 * Skipped unless PARITY_DATABASE_URL is set. It WRITES rows, so it refuses
 * any database whose name does not end in "_parity": run it only against a
 * throwaway database that has every migration applied, e.g.
 *
 *   PARITY_DATABASE_URL=postgresql://u@127.0.0.1:55600/myanflix_parity \
 *     npx jest src/comments/comments-reply-preview.parity
 */
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import type { MinioService } from '../common/storage/minio.service';
import { CommentStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionResolverService } from '../roles/permission-resolver.service';
import {
  CommentsService,
  memberTagOf,
  REPLY_PREVIEW_LIMIT,
} from './comments.service';

const URL = process.env.PARITY_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

const RUN = `cparity-${process.pid}-${Date.now()}`;

describeDb('comment reply preview parity on a real database', () => {
  let prisma: PrismaService;
  let service: CommentsService;
  const movieIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const name = new globalThis.URL(URL!).pathname.replace(/^\//, '');
    if (!name.endsWith('_parity')) {
      throw new Error(
        `PARITY_DATABASE_URL must name a throwaway *_parity database (got "${name}")`,
      );
    }
    prisma = new PrismaService({
      get: (key: string) => (key === 'DATABASE_URL' ? URL : undefined),
    } as unknown as ConfigService);
    await prisma.$connect();
    service = new CommentsService(
      prisma,
      { playbackUrl: (key: string) => `http://host/${key}` } as MinioService,
      {} as PermissionResolverService,
      {} as AuditService,
    );

    // The user index leads the id, so the five `Member #<tag>` pseudonyms
    // the thread shows (first characters of the id) tell the users apart.
    const users = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}-${RUN}`,
      username: `${RUN}-u${i}`,
      password: 'x',
      phone: `+9597${String(i).padStart(7, '0')}`,
    }));
    await prisma.user.createMany({ data: users });
    userIds.push(...users.map((u) => u.id));

    // Two movies, so a second title's replies prove nothing leaks across.
    for (const suffix of ['a', 'b']) {
      const movie = await prisma.movie.create({
        data: {
          id: `${RUN}-m${suffix}`,
          title: `${RUN} ${suffix}`,
          description: 'parity',
          genre: 'Drama',
          language: 'my',
          releaseYear: 2026,
          duration: 90,
        },
      });
      movieIds.push(movie.id);
    }

    // Reply counts per top-level comment: none, a few, exactly the limit,
    // one over, and several busy ones (with hidden replies mixed in, so the
    // VISIBLE filter decides who is in the preview).
    const shapes = [
      0,
      3,
      REPLY_PREVIEW_LIMIT,
      REPLY_PREVIEW_LIMIT + 1,
      45,
      0,
      7,
      120,
      60,
      2,
    ];
    const base = Date.UTC(2026, 8, 1);
    const rows: {
      id: string;
      userId: string;
      movieId: string;
      parentId: string | null;
      body: string;
      status: CommentStatus;
      createdAt: Date;
    }[] = [];
    let tick = 0;
    for (const movieId of movieIds) {
      shapes.forEach((replies, t) => {
        const topId = `${movieId}-t${t}`;
        rows.push({
          id: topId,
          userId: userIds[t % userIds.length],
          movieId,
          parentId: null,
          body: `top ${t}`,
          status: t === 5 ? CommentStatus.HIDDEN : CommentStatus.VISIBLE,
          createdAt: new Date(base + tick++ * 1000),
        });
        for (let r = 0; r < replies; r++) {
          rows.push({
            id: `${topId}-r${r}`,
            userId: userIds[r % userIds.length],
            movieId,
            parentId: topId,
            body: `reply ${r}`,
            // Every 4th reply hidden, including some early ones.
            status: r % 4 === 1 ? CommentStatus.HIDDEN : CommentStatus.VISIBLE,
            // Written out of order, so the order comes from createdAt.
            createdAt: new Date(
              base + 10_000_000 + ((r * 7919) % 100_000) * 1000 + t,
            ),
          });
        }
      });
    }
    await prisma.comment.createMany({ data: rows });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.comment.deleteMany({ where: { movieId: { in: movieIds } } });
    await prisma.movie.deleteMany({ where: { id: { in: movieIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('returns exactly the replies, counts and flags the per-comment reads did', async () => {
    for (const movieId of movieIds) {
      const thread = await service.findForTitle({ movieId });

      const tops = await prisma.comment.findMany({
        where: {
          movieId,
          seriesId: null,
          bookId: null,
          parentId: null,
          status: CommentStatus.VISIBLE,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(thread.map((c) => c.id)).toEqual(tops.map((t) => t.id));

      for (const comment of thread) {
        const old = await prisma.comment.findMany({
          where: { parentId: comment.id, status: CommentStatus.VISIBLE },
          orderBy: { createdAt: 'asc' },
          take: REPLY_PREVIEW_LIMIT,
          select: { id: true, body: true, createdAt: true, userId: true },
        });
        const total = await prisma.comment.count({
          where: { parentId: comment.id, status: CommentStatus.VISIBLE },
        });
        expect(comment.replies.map((r) => r.id)).toEqual(old.map((r) => r.id));
        expect(comment.replies.map((r) => r.body)).toEqual(
          old.map((r) => r.body),
        );
        // Read as a guest: the author is the pseudonym, never the id.
        expect(comment.replies.map((r) => r.user.memberTag)).toEqual(
          old.map((r) => memberTagOf(r.userId)),
        );
        for (const reply of comment.replies) {
          expect(reply.user).not.toHaveProperty('id');
          expect(reply.user).not.toHaveProperty('username');
        }
        expect(comment.replyCount).toBe(total);
        expect(comment.hasMoreReplies).toBe(total > old.length);
        for (const reply of comment.replies) {
          expect(reply).not.toHaveProperty('parentId');
          expect(reply.replies).toEqual([]);
        }
      }
      // The busy ones really were busy, so the grouped query was exercised.
      expect(thread.filter((c) => c.hasMoreReplies).length).toBeGreaterThan(2);
    }
  });

  it('uses at most two reply reads however many comments are busy', async () => {
    const spy = jest.spyOn(prisma, '$queryRaw');
    const findMany = jest.spyOn(prisma.comment, 'findMany');
    try {
      await service.findForTitle({ movieId: movieIds[0] });
      expect(spy).toHaveBeenCalledTimes(1);
      // The thread read plus one shared reply read.
      expect(findMany).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      findMany.mockRestore();
    }
  });
});
