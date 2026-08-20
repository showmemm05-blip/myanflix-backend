import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommentStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { requestClientContext } from '../common/storage/request-host.context';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import type { CreateCommentDto } from './dto/create-comment.dto';
import type { CommentQueryDto } from './dto/comment-query.dto';

/** Hard bounds on a comment body, enforced here as well as in the DTO. */
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 1000;

/**
 * Ceiling on how many top-level comments one public read returns. The
 * clients render a whole thread rather than paginating it, so this exists
 * purely so a title that accumulates thousands of comments can never turn
 * one page load into an unbounded query.
 */
export const PUBLIC_COMMENT_LIMIT = 200;

/** Comment author as the clients render it — never the phone, never the IP. */
const AUTHOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
} as const;

export interface CommentAuthorView {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface CommentView {
  id: string;
  body: string;
  createdAt: Date;
  user: CommentAuthorView;
  replies: CommentView[];
}

interface CommentRow {
  id: string;
  body: string;
  createdAt: Date;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatar: string | null;
  };
}

/**
 * Comments on a movie or a series.
 *
 * Public to read, authenticated to write, one level of replies. The tracking
 * columns (platform, ipAddress) are captured from the request context on
 * write and never leave this module — the admin's Tracking > Comments view
 * (BACKEND 4) is the only thing that reads them, and it masks the IP unless
 * the caller holds TRACKING.PII_VIEW.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly resolver: PermissionResolverService,
  ) {}

  /**
   * Posts a comment or a reply.
   *
   * Every rule that a DTO cannot express lives here: exactly one target, the
   * target actually exists, and a reply attaches to a top-level comment on
   * that same title. The length/trim rules are re-checked (the DTO already
   * applies them) so the service is safe to call from anywhere, not just
   * through the validated HTTP pipe.
   */
  async create(userId: string, dto: CreateCommentDto): Promise<CommentView> {
    const movieId = dto.movieId ?? null;
    const seriesId = dto.seriesId ?? null;

    if ((movieId === null) === (seriesId === null)) {
      throw new BadRequestException(
        'A comment must belong to exactly one of a movie or a series',
      );
    }

    const body = (dto.body ?? '').trim();
    if (body.length < COMMENT_BODY_MIN) {
      throw new BadRequestException('A comment cannot be empty');
    }
    if (body.length > COMMENT_BODY_MAX) {
      throw new BadRequestException(
        `A comment cannot be longer than ${COMMENT_BODY_MAX} characters`,
      );
    }

    if (movieId) {
      const movie = await this.prisma.movie.findUnique({
        where: { id: movieId },
        select: { id: true },
      });
      if (!movie) throw new NotFoundException('Movie not found');
    } else {
      const series = await this.prisma.series.findUnique({
        where: { id: seriesId! },
        select: { id: true },
      });
      if (!series) throw new NotFoundException('Series not found');
    }

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.parentId },
        select: { id: true, parentId: true, movieId: true, seriesId: true },
      });
      if (!parent) throw new NotFoundException('Comment not found');
      // One level only: replying to a reply attaches to the thread it is
      // already in, so the tree can never get deeper than two.
      if (parent.parentId) {
        throw new BadRequestException('Replies cannot be replied to');
      }
      if (parent.movieId !== movieId || parent.seriesId !== seriesId) {
        throw new BadRequestException(
          'A reply must be on the same title as the comment it replies to',
        );
      }
    }

    const { ip, platform } = requestClientContext();

    const created = await this.prisma.comment.create({
      data: {
        userId,
        movieId,
        seriesId,
        parentId: dto.parentId ?? null,
        body,
        platform,
        ipAddress: ip,
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: AUTHOR_SELECT },
      },
    });

    return this.toView(created, []);
  }

  /**
   * A title's visible thread, newest first, each top-level comment carrying
   * its replies oldest-first (a reply chain reads in the order it was
   * written, while the thread itself leads with what is new).
   *
   * Hidden comments are filtered on both levels, so moderating a top-level
   * comment does not silently take its replies' visibility with it.
   */
  async findForTitle(query: CommentQueryDto): Promise<CommentView[]> {
    const movieId = query.movieId ?? null;
    const seriesId = query.seriesId ?? null;

    if ((movieId === null) === (seriesId === null)) {
      throw new BadRequestException(
        'Specify exactly one of movieId or seriesId',
      );
    }

    const comments = await this.prisma.comment.findMany({
      where: {
        movieId,
        seriesId,
        parentId: null,
        status: CommentStatus.VISIBLE,
      },
      orderBy: { createdAt: 'desc' },
      take: PUBLIC_COMMENT_LIMIT,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: AUTHOR_SELECT },
        replies: {
          where: { status: CommentStatus.VISIBLE },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            body: true,
            createdAt: true,
            user: { select: AUTHOR_SELECT },
          },
        },
      },
    });

    return comments.map((comment) =>
      this.toView(
        comment,
        comment.replies.map((reply) => this.toView(reply, [])),
      ),
    );
  }

  /**
   * Deletes a comment. The author may always delete their own; anyone else
   * needs TRACKING.COMMENTS_MODERATE.
   *
   * Not a decorator gate, because the permission is only consulted when the
   * caller is NOT the author — a regular user deleting their own comment
   * must never need a staff permission.
   */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    if (comment.userId !== actor.id) {
      const canModerate = await this.resolver.can(
        actor,
        'TRACKING.COMMENTS_MODERATE',
      );
      if (!canModerate) {
        throw new ForbiddenException('You can only delete your own comments');
      }
    }

    // Replies cascade with the parent (Comment.parent is onDelete: Cascade).
    await this.prisma.comment.delete({ where: { id } });
  }

  private toView(row: CommentRow, replies: CommentView[]): CommentView {
    return {
      id: row.id,
      body: row.body,
      createdAt: row.createdAt,
      user: {
        id: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName,
        // `avatar` is a MinIO object key; the URL is derived per request so
        // it follows whatever host the client is talking to.
        avatarUrl: row.user.avatar
          ? this.minioService.playbackUrl(row.user.avatar)
          : null,
      },
      replies,
    };
  }
}
