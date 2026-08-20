import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClientPlatform, CommentStatus, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { requestHostContext } from '../common/storage/request-host.context';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CommentsService, COMMENT_BODY_MAX } from './comments.service';

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';

function makeActor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
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
    comment: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
    movie: { findUnique: jest.Mock };
    series: { findUnique: jest.Mock };
  };
  let resolver: { can: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      comment: {
        create: jest.fn().mockResolvedValue(createdRow()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({}),
      },
      movie: { findUnique: jest.fn().mockResolvedValue({ id: MOVIE_ID }) },
      series: { findUnique: jest.fn().mockResolvedValue({ id: SERIES_ID }) },
    };
    resolver = { can: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MinioService,
          useValue: { playbackUrl: jest.fn((key: string) => `http://host/${key}`) },
        },
        { provide: PermissionResolverService, useValue: resolver },
      ],
    }).compile();

    service = module.get(CommentsService);
  });

  describe('create — exactly one of movieId / seriesId', () => {
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

    it('rejects a comment that names neither', async () => {
      await expect(
        service.create('user-1', { body: 'Great' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('accepts a movie comment and stores seriesId as null', async () => {
      await service.create('user-1', { movieId: MOVIE_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ movieId: MOVIE_ID, seriesId: null }),
        }),
      );
    });

    it('accepts a series comment and stores movieId as null', async () => {
      await service.create('user-1', { seriesId: SERIES_ID, body: 'Great' });

      expect(prisma.comment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ movieId: null, seriesId: SERIES_ID }),
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

    it('rejects a reply to a reply — the thread can never get three levels deep', async () => {
      prisma.comment.findUnique.mockResolvedValue({
        id: PARENT_ID,
        parentId: 'some-other-comment',
        movieId: MOVIE_ID,
        seriesId: null,
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
      });

      await expect(
        service.create('user-1', {
          movieId: MOVIE_ID,
          parentId: PARENT_ID,
          body: 'agreed',
        }),
      ).rejects.toThrow(BadRequestException);
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

  describe('findForTitle', () => {
    it('requires exactly one of movieId / seriesId', async () => {
      await expect(service.findForTitle({})).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.findForTitle({ movieId: MOVIE_ID, seriesId: SERIES_ID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('reads only VISIBLE top-level comments, newest first', async () => {
      await service.findForTitle({ movieId: MOVIE_ID });

      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            movieId: MOVIE_ID,
            seriesId: null,
            parentId: null,
            status: CommentStatus.VISIBLE,
          },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('filters hidden replies too, and reads them oldest-first', async () => {
      await service.findForTitle({ movieId: MOVIE_ID });

      const select = prisma.comment.findMany.mock.calls[0][0].select;
      expect(select.replies).toEqual(
        expect.objectContaining({
          where: { status: CommentStatus.VISIBLE },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('nests replies under their parent and resolves the avatar key to a URL', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          ...createdRow({
            user: {
              id: 'user-1',
              username: 'blake',
              displayName: 'Blake',
              avatar: 'images/avatars/user-1.png',
            },
          }),
          replies: [createdRow({ id: 'comment-2', body: 'agreed' })],
        },
      ]);

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.user.avatarUrl).toBe('http://host/images/avatars/user-1.png');
      expect(comment.replies.map((reply) => reply.id)).toEqual(['comment-2']);
      expect(comment.replies[0].replies).toEqual([]);
    });

    it('leaves avatarUrl null for a user with no avatar', async () => {
      prisma.comment.findMany.mockResolvedValue([
        { ...createdRow(), replies: [] },
      ]);

      const [comment] = await service.findForTitle({ movieId: MOVIE_ID });

      expect(comment.user.avatarUrl).toBeNull();
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

      await expect(
        service.remove('comment-1', makeActor()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
