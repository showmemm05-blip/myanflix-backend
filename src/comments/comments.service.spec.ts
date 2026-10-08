import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ClientPlatform,
  CommentStatus,
  Role,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { requestHostContext } from '../common/storage/request-host.context';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  COMMENT_BODY_MAX,
  COMMENT_DAY_WINDOW_MS,
  COMMENT_MAX_PER_DAY,
  COMMENT_MAX_PER_MINUTE,
  COMMENT_MINUTE_WINDOW_MS,
  COMMENT_POST_LOCK_NAMESPACE,
  COMMENT_RATE_DAY_CODE,
  COMMENT_RATE_DAY_MESSAGE,
  COMMENT_RATE_MINUTE_CODE,
  COMMENT_RATE_MINUTE_MESSAGE,
  CommentsService,
  PUBLIC_COMMENT_LIMIT,
  REPLY_PREVIEW_LIMIT,
} from './comments.service';

/** A tagged-template call as jest records it: the strings, then the values. */
type RawCall = [TemplateStringsArray, ...unknown[]];

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';
const BOOK_ID = '44444444-4444-4444-8444-444444444444';

function makeActor(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    id: 'user-1',
    username: 'blake',
    role: Role.USER,
    appRoleId: null,
    ...overrides,
  };
}

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comment-1',
    body: 'Great movie',
    createdAt: new Date('2026-08-20T13:00:00.000Z'),
    user: {
      id: 'user-1',
      username: 'blake',
      displayName: 'Blake',
      avatar: null,
    },
    ...overrides,
  };
}

/** Runs `fn` as if it were inside an HTTP request with this client context. */
function inRequest<T>(
  ctx: { ip?: string | null; platform?: ClientPlatform },
  fn: () => Promise<T>,
): Promise<T> {
  return requestHostContext.run({ hostname: 'localhost', ...ctx }, fn);
}

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    comment: {
      create: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
    commentPostEvent: {
      count: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    movie: { findUnique: jest.Mock };
    series: { findUnique: jest.Mock };
    book: { findUnique: jest.Mock };
  };
  let resolver: { can: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      // The interactive transaction hands the callback the same mock, so a
      // test sees every statement the service runs inside it.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      comment: {
        create: jest.fn().mockResolvedValue(createdRow()),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({}),
      },
      commentPostEvent: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      movie: { findUnique: jest.fn().mockResolvedValue({ id: MOVIE_ID }) },
      series: { findUnique: jest.fn().mockResolvedValue({ id: SERIES_ID }) },
      book: { findUnique: jest.fn().mockResolvedValue({ id: BOOK_ID }) },
    };
    resolver = { can: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MinioService,
          useValue: {
            playbackUrl: jest.fn((key: string) => `http://host/${key}`),
          },
        },
        { provide: PermissionResolverService, useValue: resolver },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(CommentsService);
  });

  describe('create — exactly one of movieId / seriesId / bookId', () => {
    it('rejects a comment that names both a movie and a series', async () => {
      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          seriesId: SERIES_ID,
          body: 'Great',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a comment that names a movie and a book', async () => {
      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          bookId: BOOK_ID,
          body: 'Great',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a comment that names a series and a book', async () => {
      await expect(
        service.create('user-1', {
          seriesId: SERIES_ID,
          bookId: BOOK_ID,
          body: 'Great',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a comment that names all three targets', async () => {
      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          seriesId: SERIES_ID,
          bookId: BOOK_ID,
          body: 'Great',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a comment that names none', async () => {
      await expect(service.create('user-1', { body: 'Great' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('accepts a movie comment and stores seriesId / bookId as null', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            movieId: MOVIE_ID,
            seriesId: null,
            bookId: null,
          }),
        }),
      );
    });

    it('accepts a series comment and stores movieId / bookId as null', async () => {
      await service.create('user-1', { seriesId: SERIES_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            movieId: null,
            seriesId: SERIES_ID,
            bookId: null,
          }),
        }),
      );
    });

    it('accepts a book comment and stores movieId / seriesId as null', async () => {
      await service.create('user-1', { bookId: BOOK_ID, body: 'Great' });

      expect(prisma.book.findUnique).toHaveBeenCalledWith({
        where: { id: BOOK_ID },
        select: { id: true },
      });
      expect(prisma.movie.findUnique).not.toHaveBeenCalled();
      expect(prisma.series.findUnique).not.toHaveBeenCalled();
      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            movieId: null,
            seriesId: null,
            bookId: BOOK_ID,
          }),
        }),
      );
    });

    it('404s when the movie does not exist', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', { movieId: MOVIE_ID, body: 'Great' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the series does not exist', async () => {
      prisma.series.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', { seriesId: SERIES_ID, body: 'Great' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s when the book does not exist', async () => {
      prisma.book.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', { bookId: BOOK_ID, body: 'Great' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });
  });

  describe('create — body length and trimming', () => {
    it('rejects a body of nothing but whitespace', async () => {
      await expect(
        service.create('user-1', { movieId: MOVIE_ID, body: '   \n\t ' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('stores the body trimmed', async () => {
      await service.create('user-1', {
        movieId: MOVIE_ID,
        body: '   loved it   ',
      });

      const data = prisma.comment.create.mock.calls[0][0].data;
      expect(data.body).toBe('loved it');
    });

    it(`accepts a body of exactly ${COMMENT_BODY_MAX} characters`, async () => {
      await service.create('user-1', {
        movieId: MOVIE_ID,
        body: 'a'.repeat(COMMENT_BODY_MAX),
      });

      expect(prisma.comment.create).toHaveBeenCalled();
    });

    it(`rejects a body of ${COMMENT_BODY_MAX + 1} characters`, async () => {
      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          body: 'a'.repeat(COMMENT_BODY_MAX + 1),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('measures the length AFTER trimming, so padding cannot push a body over the limit', async () => {
      await service.create('user-1', {
        movieId: MOVIE_ID,
        body: `   ${'a'.repeat(COMMENT_BODY_MAX)}   `,
      });

      expect(prisma.comment.create).toHaveBeenCalled();
    });
  });

  describe('create — replies are one level deep', () => {
    it('accepts a reply to a top-level comment on the same title', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: MOVIE_ID,
        seriesId: null,
        bookId: null,
      });

      await service.create('user-1', {
        movieId: MOVIE_ID,
        parentId: PARENT_ID,
        body: 'agreed',
      });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ parentId: PARENT_ID }),
        }),
      );
    });

    it('accepts a reply to a top-level comment on the same book', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: null,
        seriesId: null,
        bookId: BOOK_ID,
      });

      await service.create('user-1', {
        bookId: BOOK_ID,
        parentId: PARENT_ID,
        body: 'agreed',
      });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parentId: PARENT_ID,
            bookId: BOOK_ID,
          }),
        }),
      );
    });

    it('rejects a reply to a reply — the thread can never get three levels deep', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: 'some-other-comment',
        movieId: MOVIE_ID,
        seriesId: null,
        bookId: null,
      });

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a reply whose parent is on a different title', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: 'a-different-movie',
        seriesId: null,
        bookId: null,
      });

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a reply on a book whose parent is on a movie', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: MOVIE_ID,
        seriesId: null,
        bookId: null,
      });

      await expect(
        service.create('user-1', {
          bookId: BOOK_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a reply on a movie whose parent is on a book', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: null,
        seriesId: null,
        bookId: BOOK_ID,
      });

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects a reply whose parent is on a different book', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: null,
        seriesId: null,
        bookId: 'a-different-book',
      });

      await expect(
        service.create('user-1', {
          bookId: BOOK_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('404s when the parent comment does not exist', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — platform and IP capture', () => {
    it('records the platform and IP of the request that posted it', async () => {
      await inRequest(
        { ip: '203.0.113.7', platform: ClientPlatform.MOBILE },
        () => service.create('user-1', { movieId: MOVIE_ID, body: 'Great' }),
      );

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platform: ClientPlatform.MOBILE,
            ipAddress: '203.0.113.7',
          }),
        }),
      );
    });

    it('falls back to UNKNOWN / null outside a request', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platform: ClientPlatform.UNKNOWN,
            ipAddress: null,
          }),
        }),
      );
    });

    it('takes the author from the authenticated caller, never from the body', async () => {
      await service.create('user-1', {
        movieId: MOVIE_ID,
        body: 'Great',
      } as never);

      const data = prisma.comment.create.mock.calls[0][0].data;
      expect(data.userId).toBe('user-1');
    });

    it('never returns the platform or IP it just stored', async () => {
      const result = await inRequest(
        { ip: '203.0.113.7', platform: ClientPlatform.MOBILE },
        () => service.create('user-1', { movieId: MOVIE_ID, body: 'Great' }),
      );

      expect(result).not.toHaveProperty('ipAddress');
      expect(result).not.toHaveProperty('platform');
    });
  });

  /**
   * Security audit 2026-10-06, M-6. Posting used to rely on the site-wide
   * per-IP backstop alone; one account could post hundreds of replies a
   * minute. The limits are counted in the database, from the account's own
   * post events — not from its surviving comments, which a hard delete would
   * hand back — inside one transaction under a per-account advisory lock.
   */
  describe('create — per-account posting limits', () => {
    /** The `where` of every post-event count, oldest window first. */
    function countWindows() {
      return prisma.commentPostEvent.count.mock.calls
        .map(
          (call) =>
            (call[0] as { where: { userId: string; createdAt: { gte: Date } } })
              .where,
        )
        .sort((a, b) => a.createdAt.gte.getTime() - b.createdAt.gte.getTime());
    }

    /** `count` answers per window: `minute` inside the last minute, `day` otherwise. */
    function countsOf(minute: number, day: number) {
      prisma.commentPostEvent.count.mockImplementation(
        ({ where }: { where: { createdAt: { gte: Date } } }) =>
          Promise.resolve(
            where.createdAt.gte.getTime() >
              Date.now() - COMMENT_MINUTE_WINDOW_MS - 1000
              ? minute
              : day,
          ),
      );
    }

    it("counts this account's post events in the last minute and the last day", async () => {
      const before = Date.now();
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.commentPostEvent.count).toHaveBeenCalledTimes(2);
      const windows = countWindows();
      expect(windows.every((w) => w.userId === 'user-1')).toBe(true);
      // Oldest bound is the day window, newest is the minute window.
      expect(
        before - windows[0].createdAt.gte.getTime() - COMMENT_DAY_WINDOW_MS,
      ).toBeLessThan(1000);
      expect(
        before - windows[1].createdAt.gte.getTime() - COMMENT_MINUTE_WINDOW_MS,
      ).toBeLessThan(1000);
    });

    it('counts post events, never the surviving comments — deleting comments cannot reset the limit', async () => {
      // The account deleted everything it posted: no comment rows survive,
      // but its ten post events from the last minute are still there.
      prisma.comment.count.mockResolvedValue(0);
      prisma.commentPostEvent.count.mockResolvedValue(COMMENT_MAX_PER_MINUTE);

      await expect(
        service.create('user-1', { movieId: MOVIE_ID, body: 'again' }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      expect(prisma.comment.count).not.toHaveBeenCalled();
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it(`refuses the ${COMMENT_MAX_PER_MINUTE + 1}th comment in a minute with a coded 429, writing nothing`, async () => {
      prisma.commentPostEvent.count.mockResolvedValue(COMMENT_MAX_PER_MINUTE);

      const call = service.create('user-1', { movieId: MOVIE_ID, body: 'x' });

      await expect(call).rejects.toThrow(HttpException);
      await expect(call).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: COMMENT_RATE_MINUTE_CODE,
        message: COMMENT_RATE_MINUTE_MESSAGE,
      });
      expect(prisma.comment.create).not.toHaveBeenCalled();
      expect(prisma.commentPostEvent.create).not.toHaveBeenCalled();
      expect(prisma.commentPostEvent.deleteMany).not.toHaveBeenCalled();
    });

    it(`refuses the ${COMMENT_MAX_PER_DAY + 1}th comment in a day with a coded 429, even when the last minute was quiet`, async () => {
      countsOf(0, COMMENT_MAX_PER_DAY);

      const call = service.create('user-1', { movieId: MOVIE_ID, body: 'x' });

      await expect(call).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: COMMENT_RATE_DAY_CODE,
        message: COMMENT_RATE_DAY_MESSAGE,
      });
      expect(prisma.comment.create).not.toHaveBeenCalled();
      expect(prisma.commentPostEvent.create).not.toHaveBeenCalled();
    });

    it('applies the same limits to replies — a reply flood is the cheap attack', async () => {
      prisma.commentPostEvent.count.mockResolvedValue(COMMENT_MAX_PER_MINUTE);
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: null,
        movieId: MOVIE_ID,
        seriesId: null,
        bookId: null,
      });

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'spam',
        }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it(`still accepts the ${COMMENT_MAX_PER_MINUTE}th comment of the minute`, async () => {
      prisma.commentPostEvent.count.mockResolvedValue(
        COMMENT_MAX_PER_MINUTE - 1,
      );

      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledTimes(1);
    });

    it('records one post event for this account in the same transaction as the comment', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.commentPostEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.commentPostEvent.create).toHaveBeenCalledWith({
        data: { userId: 'user-1' },
      });
      expect(
        prisma.commentPostEvent.create.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.comment.create.mock.invocationCallOrder[0]);
    });

    it('takes the per-account advisory lock first, inside the transaction, before counting or writing', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const lock = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(lock[0].join('?')).toContain(
        `pg_advisory_xact_lock(hashtext('${COMMENT_POST_LOCK_NAMESPACE}'), hashtext(?))`,
      );
      expect(lock.slice(1)).toEqual(['user-1']);

      const locked = prisma.$executeRaw.mock.invocationCallOrder[0];
      expect(locked).toBeGreaterThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
      for (const later of [
        prisma.commentPostEvent.count,
        prisma.commentPostEvent.create,
        prisma.comment.create,
      ]) {
        expect(locked).toBeLessThan(later.mock.invocationCallOrder[0]);
      }
    });

    it('locks on the account, so two accounts never wait on each other', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'one' });
      await service.create('user-2', { movieId: MOVIE_ID, body: 'two' });

      const [first, second] = prisma.$executeRaw.mock.calls as RawCall[];
      expect(first.slice(1)).toEqual(['user-1']);
      expect(second.slice(1)).toEqual(['user-2']);
    });

    it("prunes only this account's events older than the day window, and only once the post is allowed", async () => {
      const before = Date.now();
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.commentPostEvent.deleteMany).toHaveBeenCalledTimes(1);
      const { where } = prisma.commentPostEvent.deleteMany.mock.calls[0][0] as {
        where: { userId: string; createdAt: { lt: Date } };
      };
      expect(where.userId).toBe('user-1');
      expect(
        before - where.createdAt.lt.getTime() - COMMENT_DAY_WINDOW_MS,
      ).toBeLessThan(1000);
      const pruned =
        prisma.commentPostEvent.deleteMany.mock.invocationCallOrder[0];
      expect(pruned).toBeGreaterThan(
        prisma.commentPostEvent.count.mock.invocationCallOrder[1],
      );
      expect(pruned).toBeLessThan(
        prisma.commentPostEvent.create.mock.invocationCallOrder[0],
      );
    });

    it('spends no allowance on a post that fails validation — a missing title never reaches the transaction', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-1', { movieId: MOVIE_ID, body: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.commentPostEvent.create).not.toHaveBeenCalled();
    });

    it('reports a fresh comment with no replies and nothing more to load', async () => {
      const view = await service.create('user-1', {
        movieId: MOVIE_ID,
        body: 'Great',
      });

      expect(view.replies).toEqual([]);
      expect(view.replyCount).toBe(0);
      expect(view.hasMoreReplies).toBe(false);
    });
  });

  describe('findForTitle', () => {
    it('requires exactly one of movieId / seriesId / bookId', async () => {
      await expect(service.findForTitle({})).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.findForTitle({ movieId: MOVIE_ID, seriesId: SERIES_ID }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.findForTitle({ movieId: MOVIE_ID, bookId: BOOK_ID }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.findForTitle({
          movieId: MOVIE_ID,
          seriesId: SERIES_ID,
          bookId: BOOK_ID,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('reads a book thread with movieId / seriesId pinned to null', async () => {
      await service.findForTitle({ bookId: BOOK_ID });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            movieId: null,
            seriesId: null,
            bookId: BOOK_ID,
            parentId: null,
            status: CommentStatus.VISIBLE,
          },
        }),
      );
    });

    it('reads only VISIBLE top-level comments, newest first', async () => {
      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            movieId: MOVIE_ID,
            seriesId: null,
            bookId: null,
            parentId: null,
            status: CommentStatus.VISIBLE,
          },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('filters hidden replies too, and reads them oldest-first', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow(), _count: { replies: 3 } },
      ]);

      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.comment.findMany.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          where: {
            parentId: { in: ['comment-1'] },
            status: CommentStatus.VISIBLE,
          },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('nests replies under their parent and resolves the avatar key to a URL', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        {
          ...createdRow({
            user: {
              id: 'user-1',
              username: 'blake',
              displayName: 'Blake',
              avatar: 'images/user/user-1/1757606400000.png',
            },
          }),
          _count: { replies: 1 },
        },
      ]);
      prisma.comment.findMany.mockResolvedValueOnce([
        createdRow({ id: 'comment-2', parentId: 'comment-1', body: 'agreed' }),
      ]);

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.user.avatarUrl).toBe(
        'http://host/images/user/user-1/1757606400000.png',
      );
      expect(comment.replies.map((reply) => reply.id)).toEqual(['comment-2']);
      expect(comment.replies[0].replies).toEqual([]);
      expect(comment.replyCount).toBe(1);
      expect(comment.hasMoreReplies).toBe(false);
    });

    it('leaves avatarUrl null for a user with no avatar', async () => {
      prisma.comment.findMany.mockResolvedValue([
        { ...createdRow(), _count: { replies: 0 } },
      ]);

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.user.avatarUrl).toBeNull();
    });
  });

  /**
   * Security audit 2026-10-06, M-6: the thread read loaded EVERY visible
   * reply under each of the 200 top-level comments. Now it carries a
   * bounded preview per comment plus the true count, and the top level is
   * paged — with defaults that give the clients exactly what they read
   * before.
   */
  describe('findForTitle — bounded replies and paging', () => {
    it(`loads at most ${REPLY_PREVIEW_LIMIT} replies per comment, plus the visible-reply count`, async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow({ id: 'busy' }), _count: { replies: 5000 } },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'r-1' }, { id: 'r-2' }]);

      await service.findForTitle({ movieId: MOVIE_ID });

      const select = prisma.comment.findMany.mock.calls[0][0].select;
      // Performance audit 2026-10-07 (db-13): no nested `replies: { take }` —
      // Prisma applied that take in memory, after loading every reply.
      expect(select).not.toHaveProperty('replies');
      expect(select._count).toEqual({
        select: { replies: { where: { status: CommentStatus.VISIBLE } } },
      });
      // A comment with more replies than the preview has its preview picked
      // by a grouped query with a real per-comment cap...
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const sql = strings.join('?');
      expect(sql).toContain('row_number() OVER');
      expect(sql).toContain('PARTITION BY c."parentId"');
      expect(sql).toContain('ORDER BY c."createdAt" ASC, c.id ASC');
      expect(sql).toContain("c.status = 'VISIBLE'");
      expect(values).toContain(REPLY_PREVIEW_LIMIT);
      // ...and only those rows are read, still VISIBLE-filtered, oldest first.
      expect(prisma.comment.findMany.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          where: {
            status: CommentStatus.VISIBLE,
            id: { in: ['r-1', 'r-2'] },
          },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('reads replies only for comments that have some — at most two reads however many comments are busy', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow({ id: 'none' }), _count: { replies: 0 } },
        { ...createdRow({ id: 'small-a' }), _count: { replies: 2 } },
        { ...createdRow({ id: 'busy' }), _count: { replies: 40 } },
        { ...createdRow({ id: 'small-b' }), _count: { replies: 1 } },
        { ...createdRow({ id: 'busy-2' }), _count: { replies: 900 } },
      ]);
      const busyRows = [
        ...Array.from({ length: REPLY_PREVIEW_LIMIT }, (_, i) =>
          createdRow({ id: `busy-${i}`, parentId: 'busy' }),
        ),
        ...Array.from({ length: REPLY_PREVIEW_LIMIT }, (_, i) =>
          createdRow({ id: `busy2-${i}`, parentId: 'busy-2' }),
        ),
      ];
      prisma.$queryRaw.mockResolvedValueOnce(
        busyRows.map((row) => ({ id: row.id })),
      );
      prisma.comment.findMany.mockResolvedValueOnce([
        createdRow({ id: 'a1', parentId: 'small-a' }),
        createdRow({ id: 'b1', parentId: 'small-b' }),
        ...busyRows,
        createdRow({ id: 'a2', parentId: 'small-a' }),
      ]);

      const thread = await service.findForTitle({ movieId: MOVIE_ID });

      // One grouped id query for BOTH busy comments, one shared row read.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.comment.findMany).toHaveBeenCalledTimes(2);
      const ranked = prisma.$queryRaw.mock.calls[0] as unknown[];
      expect(JSON.stringify(ranked.slice(1))).toContain('busy-2');
      expect(prisma.comment.findMany.mock.calls[1][0]).not.toHaveProperty(
        'take',
      );
      expect(prisma.comment.findMany.mock.calls[1][0].where).toEqual({
        status: CommentStatus.VISIBLE,
        OR: [
          { parentId: { in: ['small-a', 'small-b'] } },
          { id: { in: busyRows.map((row) => row.id) } },
        ],
      });
      const byId = new Map(thread.map((c) => [c.id, c]));
      expect(byId.get('none')?.replies).toEqual([]);
      expect(byId.get('small-a')?.replies.map((r) => r.id)).toEqual([
        'a1',
        'a2',
      ]);
      expect(byId.get('small-b')?.replies.map((r) => r.id)).toEqual(['b1']);
      expect(byId.get('busy')?.replies).toHaveLength(REPLY_PREVIEW_LIMIT);
      expect(byId.get('busy')?.hasMoreReplies).toBe(true);
      expect(byId.get('busy-2')?.replies).toHaveLength(REPLY_PREVIEW_LIMIT);
      expect(byId.get('busy-2')?.replyCount).toBe(900);
      // Thread order is untouched: newest-first as the top query returned.
      expect(thread.map((c) => c.id)).toEqual([
        'none',
        'small-a',
        'busy',
        'small-b',
        'busy-2',
      ]);
      // No reply carries the internal parentId key.
      expect(byId.get('small-a')?.replies[0]).not.toHaveProperty('parentId');
    });

    it('skips the grouped query when no comment has more replies than the preview', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow(), _count: { replies: REPLY_PREVIEW_LIMIT } },
      ]);

      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.comment.findMany).toHaveBeenCalledTimes(2);
    });

    it('never carries more than the preview even if a reply lands between the count and the read', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow(), _count: { replies: REPLY_PREVIEW_LIMIT } },
      ]);
      prisma.comment.findMany.mockResolvedValueOnce(
        Array.from({ length: REPLY_PREVIEW_LIMIT + 1 }, (_, i) =>
          createdRow({ id: `r-${i}`, parentId: 'comment-1' }),
        ),
      );

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.replies).toHaveLength(REPLY_PREVIEW_LIMIT);
    });

    it('reads no replies at all for a thread with none', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow(), _count: { replies: 0 } },
      ]);

      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.comment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('says when a comment has more replies than the preview carries', async () => {
      const preview = Array.from({ length: REPLY_PREVIEW_LIMIT }, (_, i) =>
        createdRow({ id: `reply-${i}`, parentId: 'comment-1' }),
      );
      prisma.comment.findMany.mockResolvedValueOnce([
        { ...createdRow(), _count: { replies: 5000 } },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce(
        preview.map((row) => ({ id: row.id })),
      );
      prisma.comment.findMany.mockResolvedValueOnce(preview);

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.replies).toHaveLength(REPLY_PREVIEW_LIMIT);
      expect(comment.replyCount).toBe(5000);
      expect(comment.hasMoreReplies).toBe(true);
    });

    it(`defaults to the first page of ${PUBLIC_COMMENT_LIMIT} — what the clients read today`, async () => {
      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: PUBLIC_COMMENT_LIMIT }),
      );
    });

    it('pages the top level by page/limit', async () => {
      await service.findForTitle({ movieId: MOVIE_ID, page: 3, limit: 25 });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
    });

    it(`never takes more than ${PUBLIC_COMMENT_LIMIT} top-level comments, whatever limit is asked for`, async () => {
      await service.findForTitle({ movieId: MOVIE_ID, limit: 10_000 });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: PUBLIC_COMMENT_LIMIT }),
      );
    });
  });

  describe('findReplies', () => {
    const topLevel = {
      id: PARENT_ID,
      parentId: null,
      status: CommentStatus.VISIBLE,
    };

    it("reads one page of a visible top-level comment's visible replies, oldest first", async () => {
      prisma.comment.findUnique.mockResolvedValue(topLevel);
      prisma.comment.findMany.mockResolvedValue([
        createdRow({ id: 'reply-21' }),
        createdRow({ id: 'reply-22' }),
      ]);
      prisma.comment.count.mockResolvedValue(42);

      const result = await service.findReplies(PARENT_ID, {
        page: 2,
        limit: 20,
      });

      expect(prisma.comment.findMany).toHaveBeenCalledWith({
        where: { parentId: PARENT_ID, status: CommentStatus.VISIBLE },
        orderBy: { createdAt: 'asc' },
        skip: 20,
        take: 20,
        select: expect.objectContaining({ id: true, body: true }),
      });
      expect(prisma.comment.count).toHaveBeenCalledWith({
        where: { parentId: PARENT_ID, status: CommentStatus.VISIBLE },
      });
      expect(result.items.map((reply) => reply.id)).toEqual([
        'reply-21',
        'reply-22',
      ]);
      expect(result.items[0].replies).toEqual([]);
      expect(result).toMatchObject({ total: 42, page: 2, limit: 20 });
    });

    it(`defaults to page 1 of ${REPLY_PREVIEW_LIMIT}`, async () => {
      prisma.comment.findUnique.mockResolvedValue(topLevel);

      const result = await service.findReplies(PARENT_ID, {});

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: REPLY_PREVIEW_LIMIT }),
      );
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        limit: REPLY_PREVIEW_LIMIT,
      });
    });

    it('404s for a comment that does not exist', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(service.findReplies(PARENT_ID, {})).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('404s for a hidden comment — its replies are not in the thread either', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        ...topLevel,
        status: CommentStatus.HIDDEN,
      });

      await expect(service.findReplies(PARENT_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s for a reply — one level only, so it has no replies of its own', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        ...topLevel,
        parentId: '55555555-5555-4555-8555-555555555555',
      });

      await expect(service.findReplies(PARENT_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('lets the author delete their own comment without any permission', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'comment-1',
        userId: 'user-1',
      });

      await service.remove('comment-1', makeActor({ id: 'user-1' }));

      expect(prisma.comment.delete).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
      });
      expect(resolver.can).not.toHaveBeenCalled();
    });

    it("never touches the author's post events — a delete hands no posting allowance back", async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'comment-1',
        userId: 'user-1',
      });

      await service.remove('comment-1', makeActor({ id: 'user-1' }));

      expect(prisma.commentPostEvent.deleteMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses another user's comment without TRACKING.COMMENTS_MODERATE", async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'comment-1',
        userId: 'someone-else',
      });
      resolver.can.mockResolvedValue(false);

      await expect(
        service.remove('comment-1', makeActor({ id: 'user-1' })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.comment.delete).not.toHaveBeenCalled();
    });

    it("allows a moderator to delete another user's comment", async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: 'comment-1',
        userId: 'someone-else',
      });
      resolver.can.mockResolvedValue(true);

      await service.remove(
        'comment-1',
        makeActor({ id: 'staff-1', role: Role.ADMIN }),
      );

      expect(resolver.can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'staff-1' }),
        'TRACKING.COMMENTS_MODERATE',
      );
      expect(prisma.comment.delete).toHaveBeenCalled();
    });

    it('404s for a comment that does not exist', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(service.remove('comment-1', makeActor())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
