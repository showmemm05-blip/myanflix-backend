import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ClientPlatform,
  CommentStatus,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { normalizeSearchTerm } from './tracking.service';
import { presentIp, presentPhone } from './pii.util';
import type { TrackingCommentQueryDto } from './dto/tracking-comment-query.dto';
import type { ModerateCommentDto } from './dto/moderate-comment.dto';
import type { TrackingFeedbackQueryDto } from './dto/tracking-feedback-query.dto';
import type { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import type { ActiveUsersQueryDto } from './dto/active-users-query.dto';
import type { WatchTimeQueryDto } from './dto/watch-time-query.dto';
import type { TrackingSearchQueryDto } from './dto/tracking-search-query.dto';
import type { TrackingSessionQueryDto } from './dto/tracking-session-query.dto';

/**
 * How long after their last signal a user still counts as "active now".
 *
 * Five minutes is a whole multiple of the 60s presence throttle, so a user
 * who is genuinely browsing can never age out between two writes, while a
 * user who closed the tab disappears within one refresh of the admin page.
 */
export const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;

/** ISO calendar date with no time part — what a native `<input type=date>` sends. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `from`/`to` as a Prisma DateTime filter, or `undefined` when neither is set.
 *
 * A date-only `to` is expanded to the END of that day. Without this, "to
 * 2026-08-20" would resolve to that day's midnight and silently exclude
 * everything that happened on the day the operator explicitly asked for —
 * the kind of off-by-one that makes a report quietly wrong rather than
 * visibly broken.
 */
export function trackingDateRange(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;

  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = new Date(from);
  if (to) {
    range.lte = DATE_ONLY.test(to)
      ? new Date(`${to}T23:59:59.999Z`)
      : new Date(to);
  }
  return range;
}

/** The commenter/submitter/session owner, as every Tracking table renders them. */
const TRACKED_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
} as const;

interface TrackedUserRow {
  id: string;
  username: string;
  displayName: string | null;
  phone: string | null;
}

export interface TrackedUserView {
  id: string;
  username: string;
  displayName: string | null;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  phone: string | null;
}

export type TrackedTitleKind = 'MOVIE' | 'SERIES';

export interface TrackedTitleView {
  id: string;
  kind: TrackedTitleKind;
  name: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface TrackedCommentView {
  id: string;
  body: string;
  status: CommentStatus;
  platform: ClientPlatform;
  createdAt: Date;
  /** Set when this comment is a reply; the thread root's id. */
  parentId: string | null;
  user: TrackedUserView;
  title: TrackedTitleView | null;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
}

export interface TrackedFeedbackView {
  id: string;
  category: string;
  message: string;
  status: string;
  platform: ClientPlatform;
  createdAt: Date;
  updatedAt: Date;
  user: TrackedUserView;
  handledBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
  handledAt: Date | null;
  adminNote: string | null;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
}

export interface ActiveUserView {
  user: TrackedUserView;
  /** Where their most recent signal came from. */
  platform: ClientPlatform;
  /** Every platform they are currently present on — web AND mobile is one user. */
  platforms: ClientPlatform[];
  /** True while at least one live socket is open for them. */
  online: boolean;
  lastActivity: Date;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
}

export interface ActiveUsersSummary {
  /** Distinct users, counted once each however many devices they are on. */
  total: number;
  web: number;
  mobile: number;
}

export interface PlatformSplit {
  web: number;
  mobile: number;
  unknown: number;
  total: number;
}

export interface WatchTimeReport {
  byHour: (PlatformSplit & { hour: number })[];
  byWeekday: (PlatformSplit & { weekday: number })[];
  heatmap: { weekday: number; hour: number; seconds: number }[];
  /** The single busiest weekday/hour cell, or null when there is no data yet. */
  peak: { hour: number; weekday: number; seconds: number } | null;
  totals: PlatformSplit & { heartbeats: number };
}

export interface TopSearchTermView {
  /** The most common RAW spelling users actually typed. */
  term: string;
  normalizedTerm: string;
  count: number;
  avgResults: number;
  lastSearchedAt: Date | null;
  platforms: ClientPlatform[];
}

export interface RecentSearchView {
  id: string;
  term: string;
  normalizedTerm: string;
  resultCount: number;
  platform: ClientPlatform;
  createdAt: Date;
  user: TrackedUserView | null;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
}

export interface UserSessionSummaryView {
  user: TrackedUserView;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
  platform: ClientPlatform;
  lastActive: Date | null;
  sessionCount: number;
  /** That IP is used by more than one account. */
  sharedIp: boolean;
  /** That phone is on more than one account — never expected; flagged anyway. */
  sharedPhone: boolean;
}

export interface UserSessionView {
  id: string;
  platform: ClientPlatform;
  /** Masked unless the caller holds `TRACKING.PII_VIEW`. */
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
}

/** Running per-user state while the two presence sources are merged. */
interface ActiveUserAccumulator {
  userId: string;
  platforms: Set<ClientPlatform>;
  platform: ClientPlatform;
  ipAddress: string | null;
  lastActivity: Date;
  online: boolean;
}

function emptySplit(): PlatformSplit {
  return { web: 0, mobile: 0, unknown: 0, total: 0 };
}

function addToSplit(
  split: PlatformSplit,
  platform: ClientPlatform,
  seconds: number,
): void {
  if (platform === ClientPlatform.WEB) split.web += seconds;
  else if (platform === ClientPlatform.MOBILE) split.mobile += seconds;
  else split.unknown += seconds;
  split.total += seconds;
}

/**
 * Everything that READS tracking data back out, for the admin's Tracking
 * section.
 *
 * Two things are true of every method here and nowhere else in the module:
 *
 * - **PII is masked in this service**, from the CALLER's resolved
 *   permissions, via the same PermissionResolverService the route guard uses
 *   (never a second, re-implemented notion of what a role holds). A caller
 *   with `TRACKING.VIEW` but not `TRACKING.PII_VIEW` gets `09*****369` and
 *   `203.0.113.***` — the full value is never serialised, so it cannot be
 *   recovered from the response.
 * - **Nothing is invented.** A window with no rows returns zeroes and a null
 *   peak, never an extrapolation or a placeholder, so an empty state in the
 *   admin says "no data yet" because the data really is empty.
 */
@Injectable()
export class TrackingReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * Whether this caller may see phone numbers and IP addresses in full.
   *
   * Resolved once per request and threaded down, rather than consulted per
   * row: the resolver is cached, but a per-row await would still be one
   * promise per field for no added truth.
   */
  private canViewPii(actor: AuthenticatedUser): Promise<boolean> {
    return this.resolver.can(actor, 'TRACKING.PII_VIEW');
  }

  private toUserView(
    row: TrackedUserRow,
    canViewPii: boolean,
  ): TrackedUserView {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      phone: presentPhone(row.phone, canViewPii),
    };
  }

  // ---------------------------------------------------------------- comments

  /**
   * Every comment posted anywhere on the platform, newest first — including
   * HIDDEN ones, so a moderator can review and undo their own decisions.
   */
  async comments(
    actor: AuthenticatedUser,
    query: TrackingCommentQueryDto,
  ): Promise<PaginatedResult<TrackedCommentView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.CommentWhereInput = {};
    if (query.platform) where.platform = query.platform;
    if (query.status) where.status = query.status;
    const createdAt = trackingDateRange(query.from, query.to);
    if (createdAt) where.createdAt = createdAt;

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { body: { contains: search, mode: 'insensitive' } },
        { user: { username: { contains: search, mode: 'insensitive' } } },
        { user: { displayName: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search } } },
      ];
    }

    const canViewPii = await this.canViewPii(actor);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          body: true,
          status: true,
          platform: true,
          ipAddress: true,
          parentId: true,
          createdAt: true,
          user: { select: TRACKED_USER_SELECT },
          movie: { select: { id: true, title: true } },
          series: { select: { id: true, title: true } },
        },
      }),
      this.prisma.comment.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      body: row.body,
      status: row.status,
      platform: row.platform,
      createdAt: row.createdAt,
      parentId: row.parentId,
      user: this.toUserView(row.user, canViewPii),
      title: row.movie
        ? ({ id: row.movie.id, kind: 'MOVIE', name: row.movie.title } as const)
        : row.series
          ? ({
              id: row.series.id,
              kind: 'SERIES',
              name: row.series.title,
            } as const)
          : null,
      ipAddress: presentIp(row.ipAddress, canViewPii),
    }));

    return { items, total, page, limit };
  }

  /**
   * Hides or restores one comment. Hiding rather than deleting is the
   * reversible half of moderation — the row, its author and its IP stay on
   * record, which is what makes a wrongly-hidden comment recoverable and a
   * repeat offender visible.
   */
  async moderateComment(
    id: string,
    dto: ModerateCommentDto,
  ): Promise<{ id: string; status: CommentStatus }> {
    const existing = await this.prisma.comment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Comment not found');

    const updated = await this.prisma.comment.update({
      where: { id },
      data: { status: dto.status },
      select: { id: true, status: true },
    });
    return updated;
  }

  // ---------------------------------------------------------------- feedback

  async feedback(
    actor: AuthenticatedUser,
    query: TrackingFeedbackQueryDto,
  ): Promise<PaginatedResult<TrackedFeedbackView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.FeedbackWhereInput = {};
    if (query.platform) where.platform = query.platform;
    if (query.status) where.status = query.status;
    if (query.category) where.category = query.category;
    const createdAt = trackingDateRange(query.from, query.to);
    if (createdAt) where.createdAt = createdAt;

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { message: { contains: search, mode: 'insensitive' } },
        { user: { username: { contains: search, mode: 'insensitive' } } },
        { user: { displayName: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search } } },
      ];
    }

    const canViewPii = await this.canViewPii(actor);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          category: true,
          message: true,
          status: true,
          platform: true,
          ipAddress: true,
          adminNote: true,
          handledAt: true,
          createdAt: true,
          updatedAt: true,
          user: { select: TRACKED_USER_SELECT },
          handledBy: {
            select: { id: true, username: true, displayName: true },
          },
        },
      }),
      this.prisma.feedback.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      category: row.category,
      message: row.message,
      status: row.status,
      platform: row.platform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user: this.toUserView(row.user, canViewPii),
      handledBy: row.handledBy,
      handledAt: row.handledAt,
      adminNote: row.adminNote,
      ipAddress: presentIp(row.ipAddress, canViewPii),
    }));

    return { items, total, page, limit };
  }

  /**
   * Moves one feedback row through triage, stamping WHO did it and WHEN from
   * the server — `handledBy` is the authenticated caller, never a field the
   * request could claim.
   */
  async updateFeedbackStatus(
    id: string,
    dto: UpdateFeedbackStatusDto,
    actor: AuthenticatedUser,
  ): Promise<TrackedFeedbackView> {
    const existing = await this.prisma.feedback.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Feedback not found');

    const canViewPii = await this.canViewPii(actor);

    const row = await this.prisma.feedback.update({
      where: { id },
      data: {
        status: dto.status,
        // Absent leaves the existing note alone; an empty string clears it.
        ...(dto.adminNote === undefined ? {} : { adminNote: dto.adminNote }),
        handledByUserId: actor.id,
        handledAt: new Date(),
      },
      select: {
        id: true,
        category: true,
        message: true,
        status: true,
        platform: true,
        ipAddress: true,
        adminNote: true,
        handledAt: true,
        createdAt: true,
        updatedAt: true,
        user: { select: TRACKED_USER_SELECT },
        handledBy: { select: { id: true, username: true, displayName: true } },
      },
    });

    return {
      id: row.id,
      category: row.category,
      message: row.message,
      status: row.status,
      platform: row.platform,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user: this.toUserView(row.user, canViewPii),
      handledBy: row.handledBy,
      handledAt: row.handledAt,
      adminNote: row.adminNote,
      ipAddress: presentIp(row.ipAddress, canViewPii),
    };
  }

  // ----------------------------------------------------------- active users

  /**
   * Who is using the platform right now, from the two signals that exist:
   *
   * - **live sockets** (`RealtimeGateway.getActiveUsers()`) — definitive
   *   "connected this instant", but only for clients that hold a socket;
   * - **recent sessions** (`UserSession.lastSeenAt` inside the 5-minute
   *   window) — catches a user who is reading a page or scrolling the app
   *   without a socket, and survives a gateway restart.
   *
   * They are UNIONED and deduped per user, so two tabs are one person and a
   * user on web AND mobile is one person present on both platforms — never
   * two rows and never counted twice in `summary.total`.
   *
   * `summary` always describes the FULL active set; `query.platform` filters
   * the returned rows only, so filtering the table does not move the cards
   * above it.
   */
  async activeUsers(
    actor: AuthenticatedUser,
    query: ActiveUsersQueryDto,
  ): Promise<
    PaginatedResult<ActiveUserView> & { summary: ActiveUsersSummary }
  > {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const cutoff = new Date(Date.now() - ACTIVE_USER_WINDOW_MS);

    const canViewPii = await this.canViewPii(actor);
    const sessions = await this.prisma.userSession.findMany({
      where: { lastSeenAt: { gte: cutoff }, endedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        userId: true,
        platform: true,
        ipAddress: true,
        lastSeenAt: true,
      },
    });

    const byUser = new Map<string, ActiveUserAccumulator>();

    /** Folds one presence signal into the user's accumulated entry. */
    const merge = (
      userId: string,
      platform: ClientPlatform,
      ipAddress: string | null,
      at: Date,
      online: boolean,
    ): void => {
      const existing = byUser.get(userId);
      if (!existing) {
        byUser.set(userId, {
          userId,
          platforms: new Set([platform]),
          platform,
          ipAddress,
          lastActivity: at,
          online,
        });
        return;
      }
      existing.platforms.add(platform);
      existing.online ||= online;
      // The newest signal is what the single-value columns show.
      if (at.getTime() > existing.lastActivity.getTime()) {
        existing.lastActivity = at;
        existing.platform = platform;
        existing.ipAddress = ipAddress;
      }
    };

    for (const session of sessions) {
      merge(
        session.userId,
        session.platform,
        session.ipAddress,
        session.lastSeenAt,
        false,
      );
    }

    for (const live of this.realtimeGateway.getActiveUsers()) {
      // `since` is when their oldest open socket connected — the only
      // timestamp a socket carries. It only ever wins the "newest signal"
      // comparison when there is no fresher session row, which is exactly
      // the case it is here to cover.
      merge(live.userId, live.platform, live.ip, live.since, true);
      for (const platform of live.platforms) {
        byUser.get(live.userId)?.platforms.add(platform);
      }
    }

    const summary: ActiveUsersSummary = {
      total: byUser.size,
      web: 0,
      mobile: 0,
    };
    for (const entry of byUser.values()) {
      if (entry.platforms.has(ClientPlatform.WEB)) summary.web += 1;
      if (entry.platforms.has(ClientPlatform.MOBILE)) summary.mobile += 1;
    }

    const matching = [...byUser.values()]
      .filter((entry) => !query.platform || entry.platforms.has(query.platform))
      // Online first, then most recently active — the order an operator
      // watching a live list expects.
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastActivity.getTime() - a.lastActivity.getTime();
      });

    const total = matching.length;
    const pageEntries = matching.slice((page - 1) * limit, page * limit);

    const users = pageEntries.length
      ? await this.prisma.user.findMany({
          where: { id: { in: pageEntries.map((entry) => entry.userId) } },
          select: TRACKED_USER_SELECT,
        })
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));

    const items: ActiveUserView[] = [];
    for (const entry of pageEntries) {
      const user = usersById.get(entry.userId);
      // A presence signal whose account has since been deleted: drop it
      // rather than render a row with no identity.
      if (!user) continue;
      items.push({
        user: this.toUserView(user, canViewPii),
        platform: entry.platform,
        platforms: [...entry.platforms],
        online: entry.online,
        lastActivity: entry.lastActivity,
        ipAddress: presentIp(entry.ipAddress, canViewPii),
      });
    }

    return { items, total, page, limit, summary };
  }

  // -------------------------------------------------------------- watch time

  /**
   * WHEN people watch — hour of day, day of week, and the 24x7 heatmap
   * behind both.
   *
   * ## Timezone
   *
   * `WatchActivity.hourStart` is stored truncated to the UTC hour, because a
   * storage key must not move when the server's clock configuration does.
   * This report re-buckets those rows into the **server's local timezone**
   * (`Date#getHours` / `Date#getDay`, i.e. whatever `TZ` the backend process
   * runs under) — deliberately, and this is the choice the spec pins:
   * "peak evening" has to mean evening where the audience actually is, and
   * for a single-market service the server's timezone is that market's. A
   * UTC-bucketed report would put Myanmar's 8pm peak at 13:00 and read as
   * simply wrong to the operator looking at it.
   *
   * The consequence to know: change the container's `TZ` and every previous
   * reading of this report shifts. Stored data does not move — only how it
   * is grouped — so the change is reversible.
   */
  async watchTime(query: WatchTimeQueryDto): Promise<WatchTimeReport> {
    const where: Prisma.WatchActivityWhereInput = {};
    if (query.platform) where.platform = query.platform;
    const hourStart = trackingDateRange(query.from, query.to);
    if (hourStart) where.hourStart = hourStart;

    // One grouped query for the whole report: at most one row per (hour,
    // platform) in the window, which the three views below are all derived
    // from in memory rather than re-queried per bucket.
    const rows = await this.prisma.watchActivity.groupBy({
      by: ['hourStart', 'platform'],
      where,
      _sum: { seconds: true, heartbeats: true },
    });

    const byHour = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      ...emptySplit(),
    }));
    const byWeekday = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      ...emptySplit(),
    }));
    // weekday-major so [weekday][hour] indexes the grid the admin renders.
    const grid: number[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => 0),
    );
    const totals = { ...emptySplit(), heartbeats: 0 };

    for (const row of rows) {
      const seconds = row._sum.seconds ?? 0;
      const bucket = new Date(row.hourStart);
      const hour = bucket.getHours();
      const weekday = bucket.getDay();

      addToSplit(byHour[hour], row.platform, seconds);
      addToSplit(byWeekday[weekday], row.platform, seconds);
      addToSplit(totals, row.platform, seconds);
      totals.heartbeats += row._sum.heartbeats ?? 0;
      grid[weekday][hour] += seconds;
    }

    const heatmap: WatchTimeReport['heatmap'] = [];
    let peak: WatchTimeReport['peak'] = null;
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const seconds = grid[weekday][hour];
        heatmap.push({ weekday, hour, seconds });
        if (seconds > 0 && (peak === null || seconds > peak.seconds)) {
          peak = { hour, weekday, seconds };
        }
      }
    }

    return { byHour, byWeekday, heatmap, peak, totals };
  }

  // ---------------------------------------------------------------- searches

  /**
   * What users type into the search box, grouped by `normalizedTerm` so
   * "Avengers", " avengers " and "AVENGERS" are one row — and labelled with
   * the most common RAW spelling, so the report shows wording that was
   * actually typed rather than a lowercased reconstruction.
   *
   * Three queries, none of them per-row: the page of groups, the count of
   * distinct groups, and one grouped pass over (term, platform) restricted
   * to the page's terms that yields both the winning spelling and the
   * platform set.
   */
  async topSearches(
    query: TrackingSearchQueryDto,
  ): Promise<PaginatedResult<TopSearchTermView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.searchWhere(query);

    // Promise.all rather than $transaction: Prisma's aggregate result types
    // collapse into a union inside a transaction array, and these two are a
    // page and its group count, not a pair that has to see one snapshot.
    const [groups, distinct] = await Promise.all([
      this.prisma.searchQuery.groupBy({
        by: ['normalizedTerm'],
        where,
        _count: { _all: true },
        _avg: { resultCount: true },
        _max: { createdAt: true },
        orderBy: [
          { _count: { normalizedTerm: 'desc' } },
          { _max: { createdAt: 'desc' } },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.searchQuery.groupBy({ by: ['normalizedTerm'], where }),
    ]);

    const terms = groups.map((group) => group.normalizedTerm);
    const variants = terms.length
      ? await this.prisma.searchQuery.groupBy({
          by: ['normalizedTerm', 'term', 'platform'],
          where: { ...where, normalizedTerm: { in: terms } },
          _count: { _all: true },
        })
      : [];

    const spellings = new Map<string, Map<string, number>>();
    const platforms = new Map<string, Set<ClientPlatform>>();
    for (const variant of variants) {
      const counts =
        spellings.get(variant.normalizedTerm) ?? new Map<string, number>();
      counts.set(
        variant.term,
        (counts.get(variant.term) ?? 0) + variant._count._all,
      );
      spellings.set(variant.normalizedTerm, counts);

      const seen =
        platforms.get(variant.normalizedTerm) ?? new Set<ClientPlatform>();
      seen.add(variant.platform);
      platforms.set(variant.normalizedTerm, seen);
    }

    const items = groups.map((group) => ({
      term: this.mostCommonSpelling(
        spellings.get(group.normalizedTerm),
        group.normalizedTerm,
      ),
      normalizedTerm: group.normalizedTerm,
      count: group._count._all,
      // Two decimals: "found 0.5 results on average" is a meaningful signal
      // about dead-end searches, and rounding it to an integer would erase it.
      avgResults: Math.round((group._avg.resultCount ?? 0) * 100) / 100,
      lastSearchedAt: group._max.createdAt,
      platforms: [...(platforms.get(group.normalizedTerm) ?? [])],
    }));

    return { items, total: distinct.length, page, limit };
  }

  /**
   * The raw search log, newest first — the "recent searches" companion to
   * the grouped report, for reading demand as it happens rather than in
   * aggregate.
   */
  async recentSearches(
    actor: AuthenticatedUser,
    query: TrackingSearchQueryDto,
  ): Promise<PaginatedResult<RecentSearchView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.searchWhere(query);

    const canViewPii = await this.canViewPii(actor);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.searchQuery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          term: true,
          normalizedTerm: true,
          resultCount: true,
          platform: true,
          ipAddress: true,
          createdAt: true,
          user: { select: TRACKED_USER_SELECT },
        },
      }),
      this.prisma.searchQuery.count({ where }),
    ]);

    const items = rows.map((row) => ({
      id: row.id,
      term: row.term,
      normalizedTerm: row.normalizedTerm,
      resultCount: row.resultCount,
      platform: row.platform,
      createdAt: row.createdAt,
      user: row.user ? this.toUserView(row.user, canViewPii) : null,
      ipAddress: presentIp(row.ipAddress, canViewPii),
    }));

    return { items, total, page, limit };
  }

  /** Shared filter for both search reports. */
  private searchWhere(
    query: TrackingSearchQueryDto,
  ): Prisma.SearchQueryWhereInput {
    const where: Prisma.SearchQueryWhereInput = {};
    if (query.platform) where.platform = query.platform;
    const createdAt = trackingDateRange(query.from, query.to);
    if (createdAt) where.createdAt = createdAt;

    const search = query.search?.trim();
    if (search) {
      // Normalised the same way the stored column is, so the filter matches
      // the grouping key rather than fighting it.
      where.normalizedTerm = { contains: normalizeSearchTerm(search) };
    }
    return where;
  }

  /**
   * The raw spelling typed most often for one normalised term. Ties break
   * alphabetically so the label is stable between two reads of the same
   * data rather than flipping with row order.
   */
  private mostCommonSpelling(
    counts: Map<string, number> | undefined,
    fallback: string,
  ): string {
    if (!counts || counts.size === 0) return fallback;
    let best = fallback;
    let bestCount = -1;
    for (const [term, count] of counts) {
      if (count > bestCount || (count === bestCount && term < best)) {
        best = term;
        bestCount = count;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- sessions

  /**
   * The Phone/IP view: one row per user, not per session.
   *
   * `sharedIp` is the point of this screen — "more than one account signs in
   * from this address". It is derived from ONE grouped query over the page's
   * IPs (distinct (ip, user) pairs, counted in memory), never a lookup per
   * row, and deliberately ignores the date/platform filters: whether an
   * address is shared is a fact about the address, not about the window the
   * operator happens to be looking at.
   *
   * `sharedPhone` should always be false — `User.phone` is unique — so it is
   * computed the same way rather than hard-coded, precisely so that if it
   * ever comes back true the screen says so instead of hiding it.
   */
  async sessions(
    actor: AuthenticatedUser,
    query: TrackingSessionQueryDto,
  ): Promise<PaginatedResult<UserSessionSummaryView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.UserSessionWhereInput = {};
    if (query.platform) where.platform = query.platform;
    const lastSeenAt = trackingDateRange(query.from, query.to);
    if (lastSeenAt) where.lastSeenAt = lastSeenAt;
    if (query.ip?.trim()) where.ipAddress = { contains: query.ip.trim() };

    const user: Prisma.UserWhereInput = {};
    if (query.phone?.trim()) user.phone = { contains: query.phone.trim() };
    const search = query.search?.trim();
    if (search) {
      user.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
      ];
    }
    if (Object.keys(user).length > 0) where.user = user;

    const canViewPii = await this.canViewPii(actor);
    // See the note in topSearches on why this pair is not a $transaction.
    const [groups, distinct] = await Promise.all([
      this.prisma.userSession.groupBy({
        by: ['userId'],
        where,
        _count: { _all: true },
        _max: { lastSeenAt: true },
        orderBy: { _max: { lastSeenAt: 'desc' } },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.userSession.groupBy({ by: ['userId'], where }),
    ]);

    const userIds = groups.map((group) => group.userId);
    // The newest matching session per user — `distinct` with the same
    // ordering is what makes this one query rather than one per row.
    const newest = userIds.length
      ? await this.prisma.userSession.findMany({
          where: { ...where, userId: { in: userIds } },
          orderBy: { lastSeenAt: 'desc' },
          distinct: ['userId'],
          select: {
            userId: true,
            platform: true,
            ipAddress: true,
            user: { select: TRACKED_USER_SELECT },
          },
        })
      : [];
    const newestByUser = new Map(newest.map((row) => [row.userId, row]));

    const pageIps = [
      ...new Set(
        newest
          .map((row) => row.ipAddress)
          .filter((ip): ip is string => Boolean(ip)),
      ),
    ];
    const pagePhones = [
      ...new Set(
        newest
          .map((row) => row.user.phone)
          .filter((phone): phone is string => Boolean(phone)),
      ),
    ];

    const [ipOwners, phoneOwners] = await Promise.all([
      pageIps.length
        ? this.prisma.userSession.groupBy({
            by: ['ipAddress', 'userId'],
            where: { ipAddress: { in: pageIps } },
          })
        : Promise.resolve([]),
      pagePhones.length
        ? this.prisma.user.groupBy({
            by: ['phone'],
            where: { phone: { in: pagePhones } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);

    const usersPerIp = new Map<string, Set<string>>();
    for (const pair of ipOwners) {
      if (!pair.ipAddress) continue;
      const owners = usersPerIp.get(pair.ipAddress) ?? new Set<string>();
      owners.add(pair.userId);
      usersPerIp.set(pair.ipAddress, owners);
    }
    const accountsPerPhone = new Map<string, number>();
    for (const row of phoneOwners) {
      if (!row.phone) continue;
      accountsPerPhone.set(row.phone, row._count._all);
    }

    const items: UserSessionSummaryView[] = [];
    for (const group of groups) {
      const latest = newestByUser.get(group.userId);
      if (!latest) continue;
      const ip = latest.ipAddress;
      const phone = latest.user.phone;
      items.push({
        user: this.toUserView(latest.user, canViewPii),
        ipAddress: presentIp(ip, canViewPii),
        platform: latest.platform,
        lastActive: group._max.lastSeenAt,
        sessionCount: group._count._all,
        sharedIp: ip ? (usersPerIp.get(ip)?.size ?? 0) > 1 : false,
        sharedPhone: phone ? (accountsPerPhone.get(phone) ?? 0) > 1 : false,
      });
    }

    return { items, total: distinct.length, page, limit };
  }

  /** One user's own sessions, newest first — the row's details drawer. */
  async userSessions(
    actor: AuthenticatedUser,
    userId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResult<UserSessionView>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const canViewPii = await this.canViewPii(actor);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.userSession.findMany({
        where: { userId },
        orderBy: { lastSeenAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          platform: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          lastSeenAt: true,
          endedAt: true,
        },
      }),
      this.prisma.userSession.count({ where: { userId } }),
    ]);

    const items = rows.map((row) => ({
      ...row,
      ipAddress: presentIp(row.ipAddress, canViewPii),
    }));

    return { items, total, page, limit };
  }
}
