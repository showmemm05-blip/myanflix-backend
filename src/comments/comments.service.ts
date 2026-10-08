import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommentStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { requestClientContext } from '../common/storage/request-host.context';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { AuditService } from '../audit/audit.service';
import { commentSnapshot, textPreview } from '../audit/audit-snapshots';
import type { CreateCommentDto } from './dto/create-comment.dto';
import type { CommentQueryDto } from './dto/comment-query.dto';

/** Hard bounds on a comment body, enforced here as well as in the DTO. */
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 1000;

/**
 * Ceiling on how many top-level comments one public read returns — the
 * default AND the maximum `limit` of `GET /comments`. The clients render a
 * whole thread rather than paginating it, so the default stays at the old
 * cap (nothing changes for them); a client that wants smaller pages passes
 * `page`/`limit`.
 */
export const PUBLIC_COMMENT_LIMIT = 200;

/**
 * How many replies ride along under each top-level comment in one thread
 * read. The rest are fetched a page at a time from `GET /comments/:id/replies`
 * — `replyCount` / `hasMoreReplies` on the comment say whether to bother.
 *
 * Before this cap every visible reply was loaded, so one account posting
 * thousands of replies under one comment turned the public thread read into
 * a multi-megabyte query for every visitor (security audit 2026-10-06, M-6).
 */
export const REPLY_PREVIEW_LIMIT = 20;

/**
 * Per-account posting limits, counted in the database (the feedback module's
 * pattern): no in-memory counter, so they survive a restart and hold across
 * every instance. Per USER rather than per IP — posting is authenticated, so
 * the account is the real identity, and an IP limit would punish everyone
 * behind one household NAT for one spammer. The site-wide 300/min/IP backstop
 * still applies on top.
 *
 * What is counted is the account's CommentPostEvent rows, one per post, not
 * its surviving comments: a comment delete is a hard delete, so counting
 * comments let an account hand its allowance back by deleting and posting
 * again. Post events are never deleted by a comment delete.
 */
export const COMMENT_MAX_PER_MINUTE = 10;
export const COMMENT_MAX_PER_DAY = 100;
export const COMMENT_MINUTE_WINDOW_MS = 60 * 1000;
export const COMMENT_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable codes on the 429 envelope, so a client can show its own wording. */
export const COMMENT_RATE_MINUTE_CODE = 'COMMENT_RATE_MINUTE';
export const COMMENT_RATE_DAY_CODE = 'COMMENT_RATE_DAY';

export const COMMENT_RATE_MINUTE_MESSAGE =
  'You are posting comments too quickly. Please wait a minute and try again.';
export const COMMENT_RATE_DAY_MESSAGE = `You have reached the limit of ${COMMENT_MAX_PER_DAY} comments per day. Please try again tomorrow.`;

/**
 * Namespace of the per-account advisory lock taken while a post is counted
 * and written — see CommentsService.create, which spells it as a literal in
 * the SQL so the lock key is fixed at the statement, not a parameter.
 */
export const COMMENT_POST_LOCK_NAMESPACE = 'comments.post';

/** The house pagination shape, as the replies page returns it. */
export interface PaginatedComments {
  items: CommentView[];
  total: number;
  page: number;
  limit: number;
}

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
  /**
   * For a top-level comment: its first REPLY_PREVIEW_LIMIT visible replies,
   * oldest first. For a reply: always empty (one level only).
   */
  replies: CommentView[];
  /** Every visible reply, whether or not it is in `replies`. */
  replyCount: number;
  /** `replyCount > replies.length` — there is a page to load. */
  hasMoreReplies: boolean;
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
 * Comments on a movie, a series or a book.
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
    private readonly audit: AuditService,
  ) {}

  /**
   * Posts a comment or a reply.
   *
   * Every rule that a DTO cannot express lives here: exactly one target, the
   * target actually exists, and a reply attaches to a top-level comment on
   * that same title. The length/trim rules are re-checked (the DTO already
   * applies them) so the service is safe to call from anywhere, not just
   * through the validated HTTP pipe.
   *
   * The posting limit is checked and the comment written in ONE transaction
   * under a per-account advisory lock, so two requests racing on the last
   * slot cannot both see "9 in the last minute" and both get through. The
   * lock is per account: only the same account's parallel posts wait on
   * each other.
   */
  async create(userId: string, dto: CreateCommentDto): Promise<CommentView> {
    const movieId = dto.movieId ?? null;
    const seriesId = dto.seriesId ?? null;
    const bookId = dto.bookId ?? null;

    const targets = [movieId, seriesId, bookId].filter(
      (id) => id !== null,
    ).length;
    if (targets !== 1) {
      throw new BadRequestException(
        'A comment must belong to exactly one of a movie, a series or a book',
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
    } else if (seriesId) {
      const series = await this.prisma.series.findUnique({
        where: { id: seriesId },
        select: { id: true },
      });
      if (!series) throw new NotFoundException('Series not found');
    } else {
      const book = await this.prisma.book.findUnique({
        where: { id: bookId! },
        select: { id: true },
      });
      if (!book) throw new NotFoundException('Book not found');
    }

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.parentId },
        select: {
          id: true,
          parentId: true,
          movieId: true,
          seriesId: true,
          bookId: true,
        },
      });
      if (!parent) throw new NotFoundException('Comment not found');
      // One level only: replying to a reply attaches to the thread it is
      // already in, so the tree can never get deeper than two.
      if (parent.parentId) {
        throw new BadRequestException('Replies cannot be replied to');
      }
      if (
        parent.movieId !== movieId ||
        parent.seriesId !== seriesId ||
        parent.bookId !== bookId
      ) {
        throw new BadRequestException(
          'A reply must be on the same title as the comment it replies to',
        );
      }
    }

    const { ip, platform } = requestClientContext();

    const created = await this.prisma.$transaction(async (tx) => {
      // Held until commit; released on the rollback a 429 causes too.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comments.post'), hashtext(${userId}))`;

      await this.assertWithinPostingLimits(tx, userId);

      // The post event and the comment land together or not at all.
      await tx.commentPostEvent.create({ data: { userId } });

      return tx.comment.create({
        data: {
          userId,
          movieId,
          seriesId,
          bookId,
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
    });

    return this.toView(created, []);
  }

  /**
   * One page of a title's visible thread, newest first, each top-level
   * comment carrying its first replies oldest-first (a reply chain reads in
   * the order it was written, while the thread itself leads with what is
   * new). Defaults to the first page of PUBLIC_COMMENT_LIMIT, which is what
   * the clients read.
   *
   * Hidden comments are filtered on both levels, so moderating a top-level
   * comment does not silently take its replies' visibility with it.
   */
  async findForTitle(query: CommentQueryDto): Promise<CommentView[]> {
    const movieId = query.movieId ?? null;
    const seriesId = query.seriesId ?? null;
    const bookId = query.bookId ?? null;
    const page = query.page ?? 1;
    const limit = Math.min(
      query.limit ?? PUBLIC_COMMENT_LIMIT,
      PUBLIC_COMMENT_LIMIT,
    );

    const targets = [movieId, seriesId, bookId].filter(
      (id) => id !== null,
    ).length;
    if (targets !== 1) {
      throw new BadRequestException(
        'Specify exactly one of movieId, seriesId or bookId',
      );
    }

    // All three set explicitly (nulls included) so a movie thread can never
    // leak into a book thread or vice versa.
    const comments = await this.prisma.comment.findMany({
      where: {
        movieId,
        seriesId,
        bookId,
        parentId: null,
        status: CommentStatus.VISIBLE,
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: AUTHOR_SELECT },
        // The visible-reply total, counted in the same query, so the client
        // knows whether a "load more replies" page exists — and so
        // replyPreviews knows which comments need a bounded read.
        _count: {
          select: { replies: { where: { status: CommentStatus.VISIBLE } } },
        },
      },
    });

    const previews = await this.replyPreviews(comments);
    return comments.map((comment) =>
      this.toView(
        comment,
        (previews.get(comment.id) ?? []).map((reply) => this.toView(reply, [])),
        comment._count.replies,
      ),
    );
  }

  /**
   * The first REPLY_PREVIEW_LIMIT visible replies of each top-level comment,
   * oldest first, keyed by parent id.
   *
   * Not a nested `replies: { take }` select: Prisma applies a nested `take`
   * in memory, so that read still loaded EVERY visible reply of every
   * comment on the page. Instead, using the visible-reply counts the thread
   * query already has:
   *  - comments with no replies cost nothing;
   *  - comments whose replies all fit in the preview are read by parent id,
   *    which returns exactly the rows the response carries;
   *  - comments with more replies than the preview first have their preview
   *    reply ids picked in ONE grouped query (busyPreviewIds), however many
   *    such comments the page holds.
   * Both kinds then share ONE row read, so a thread costs at most two
   * queries here, never one per busy comment. The same VISIBLE filter and
   * oldest-first order as before, so the response is unchanged.
   */
  private async replyPreviews(
    parents: { id: string; _count: { replies: number } }[],
  ): Promise<Map<string, CommentRow[]>> {
    const fits = parents
      .filter(
        (p) => p._count.replies > 0 && p._count.replies <= REPLY_PREVIEW_LIMIT,
      )
      .map((p) => p.id);
    const busy = parents
      .filter((p) => p._count.replies > REPLY_PREVIEW_LIMIT)
      .map((p) => p.id);

    const busyIds = busy.length > 0 ? await this.busyPreviewIds(busy) : [];

    const scopes: Prisma.CommentWhereInput[] = [];
    if (fits.length > 0) scopes.push({ parentId: { in: fits } });
    if (busyIds.length > 0) scopes.push({ id: { in: busyIds } });
    const byParent = new Map<string, CommentRow[]>();
    if (scopes.length === 0) return byParent;

    const replies = await this.prisma.comment.findMany({
      where: {
        status: CommentStatus.VISIBLE,
        ...(scopes.length === 1 ? scopes[0] : { OR: scopes }),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        parentId: true,
        body: true,
        createdAt: true,
        user: { select: AUTHOR_SELECT },
      },
    });

    for (const reply of replies) {
      if (!reply.parentId) continue;
      const list = byParent.get(reply.parentId) ?? [];
      // A reply posted between the count and this read could push a "fits"
      // comment one over; the preview never carries more than the limit.
      if (list.length < REPLY_PREVIEW_LIMIT) list.push(reply);
      byParent.set(reply.parentId, list);
    }
    return byParent;
  }

  /**
   * The ids of the first REPLY_PREVIEW_LIMIT visible replies under each of
   * `parentIds`, oldest first — one query for the whole page, ranking each
   * comment's replies with row_number() instead of one LIMIT query per
   * comment (which let a page of busy comments open up to 200 queries at
   * once against a 10-connection pool). Ties on createdAt break on id so
   * the pick is stable. Ids only; the rows come from the shared read in
   * replyPreviews, which re-applies the VISIBLE filter.
   */
  private async busyPreviewIds(parentIds: string[]): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT ranked.id FROM (
        SELECT c.id,
               row_number() OVER (
                 PARTITION BY c."parentId"
                 ORDER BY c."createdAt" ASC, c.id ASC
               ) AS rn
        FROM comments c
        WHERE c."parentId" IN (${Prisma.join(parentIds)})
          AND c.status = 'VISIBLE'
      ) ranked
      WHERE ranked.rn <= ${REPLY_PREVIEW_LIMIT}`;
    return rows.map((row) => row.id);
  }

  /**
   * One page of a top-level comment's visible replies, oldest first — the
   * "load more replies" behind REPLY_PREVIEW_LIMIT. Public, like the thread.
   *
   * 404 for a comment that is missing, hidden, or itself a reply: a hidden
   * comment's replies are not shown in the thread either, and a reply has
   * no replies of its own.
   */
  async findReplies(
    parentId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedComments> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? REPLY_PREVIEW_LIMIT;

    const parent = await this.prisma.comment.findUnique({
      where: { id: parentId },
      select: { id: true, parentId: true, status: true },
    });
    if (!parent || parent.parentId || parent.status !== CommentStatus.VISIBLE) {
      throw new NotFoundException('Comment not found');
    }

    const where = { parentId, status: CommentStatus.VISIBLE };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: AUTHOR_SELECT },
        },
      }),
      this.prisma.comment.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toView(row, [])),
      total,
      page,
      limit,
    };
  }

  /**
   * 429 when this account has posted COMMENT_MAX_PER_MINUTE comments in the
   * last minute or COMMENT_MAX_PER_DAY in the last day — replies included,
   * since a reply flood is the cheaper attack. Counted from the account's
   * post events (see COMMENT_MAX_PER_MINUTE), inside the caller's locked
   * transaction, one query per window and in that order (one statement at a
   * time on a transaction client).
   *
   * Once the post is allowed, the account's events older than the day window
   * are pruned — they can never count again, and this keeps the table at a
   * day per active account. A refused post writes nothing: the prune is
   * after the checks, and the rollback would undo it anyway.
   */
  private async assertWithinPostingLimits(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const now = Date.now();
    const dayStart = new Date(now - COMMENT_DAY_WINDOW_MS);

    const lastMinute = await tx.commentPostEvent.count({
      where: {
        userId,
        createdAt: { gte: new Date(now - COMMENT_MINUTE_WINDOW_MS) },
      },
    });
    if (lastMinute >= COMMENT_MAX_PER_MINUTE) {
      throw new CodedHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        COMMENT_RATE_MINUTE_CODE,
        COMMENT_RATE_MINUTE_MESSAGE,
      );
    }

    const lastDay = await tx.commentPostEvent.count({
      where: { userId, createdAt: { gte: dayStart } },
    });
    if (lastDay >= COMMENT_MAX_PER_DAY) {
      throw new CodedHttpException(
        HttpStatus.TOO_MANY_REQUESTS,
        COMMENT_RATE_DAY_CODE,
        COMMENT_RATE_DAY_MESSAGE,
      );
    }

    await tx.commentPostEvent.deleteMany({
      where: { userId, createdAt: { lt: dayStart } },
    });
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
    // Selects the audit snapshot fields too — the row is gone after this.
    const comment = await this.prisma.comment.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        body: true,
        movieId: true,
        seriesId: true,
        bookId: true,
        parentId: true,
      },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    const isOwner = comment.userId === actor.id;
    if (!isOwner) {
      const canModerate = await this.resolver.can(
        actor,
        'TRACKING.COMMENTS_MODERATE',
      );
      if (!canModerate) {
        throw new ForbiddenException('You can only delete your own comments');
      }
    }

    // Replies cascade with the parent (Comment.parent is onDelete: Cascade).
    // The author's CommentPostEvent rows stay: the posting limit counts
    // them, and a delete must not hand the allowance back.
    await this.prisma.comment.delete({ where: { id } });

    // Only moderation is audited — an author deleting their own comment is
    // self-service, whatever role they happen to hold.
    if (!isOwner) {
      await this.audit.record({
        action: 'comment.delete',
        actor,
        target: {
          type: 'comment',
          id,
          label: textPreview(comment.body, 60),
        },
        before: commentSnapshot(comment),
        metadata: { authorId: comment.userId },
      });
    }
  }

  private toView(
    row: CommentRow,
    replies: CommentView[],
    replyCount: number = replies.length,
  ): CommentView {
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
      replyCount,
      hasMoreReplies: replyCount > replies.length,
    };
  }
}
