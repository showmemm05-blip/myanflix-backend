import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  ClientPlatform,
  CommentStatus,
  FeedbackCategory,
  FeedbackStatus,
  Role,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ActiveSocketUser } from '../realtime/realtime.gateway';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { createRoleAwarePermissionResolver } from '../../test/seeded-permission-resolver';
import {
  ACTIVE_USER_WINDOW_MS,
  TrackingReadService,
  trackingDateRange,
} from './tracking-read.service';

/**
 * Three callers, each holding a different slice of TRACKING:
 *
 * - `analyst` holds TRACKING.VIEW only — the case the PII gate exists for;
 * - `investigator` additionally holds TRACKING.PII_VIEW;
 * - `superAdmin` is protected, so the resolver gives it everything.
 *
 * They resolve through createRoleAwarePermissionResolver, i.e. through the
 * same resolver contract the route guard uses — not a second, re-implemented
 * notion of what a role holds.
 */
const analyst: AuthenticatedUser = {
  id: 'staff-analyst',
  username: 'analyst',
  role: Role.ADMIN,
  appRoleId: 'role-view-only',
};

const investigator: AuthenticatedUser = {
  id: 'staff-investigator',
  username: 'investigator',
  role: Role.ADMIN,
  appRoleId: 'role-with-pii',
};

const superAdmin: AuthenticatedUser = {
  id: 'staff-boss',
  username: 'boss',
  role: Role.SUPER_ADMIN,
  appRoleId: 'role-super',
};

function commenter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    username: 'blake',
    displayName: 'Blake',
    phone: '+95950495369',
    ...overrides,
  };
}

/** A WatchActivity groupBy row as Prisma returns it. */
function bucket(
  hourStart: Date,
  platform: ClientPlatform,
  seconds: number,
  heartbeats = 1,
) {
  return { hourStart, platform, _sum: { seconds, heartbeats } };
}

describe('TrackingReadService', () => {
  let service: TrackingReadService;
  let prisma: {
    comment: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    feedback: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    searchQuery: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
    watchActivity: { groupBy: jest.Mock };
    userSession: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
    user: { findMany: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
  };
  let gateway: { getActiveUsers: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      comment: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue({ id: 'comment-1' }),
        update: jest
          .fn()
          .mockResolvedValue({ id: 'comment-1', status: CommentStatus.HIDDEN }),
      },
      feedback: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue({ id: 'feedback-1' }),
        update: jest.fn(),
      },
      searchQuery: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      watchActivity: { groupBy: jest.fn().mockResolvedValue([]) },
      userSession: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };

    gateway = { getActiveUsers: jest.fn().mockReturnValue([]) };

    const resolver = createRoleAwarePermissionResolver([
      { id: 'role-view-only', key: 'TRACKING_ANALYST', permissions: ['TRACKING.VIEW'] },
      {
        id: 'role-with-pii',
        key: 'TRACKING_INVESTIGATOR',
        permissions: ['TRACKING.VIEW', 'TRACKING.PII_VIEW'],
      },
      {
        id: 'role-super',
        key: Role.SUPER_ADMIN,
        isProtected: true,
        permissions: [],
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingReadService,
        { provide: PrismaService, useValue: prisma },
        { provide: PermissionResolverService, useValue: resolver },
        { provide: RealtimeGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(TrackingReadService);
  });

  // ------------------------------------------------------------- date ranges

  describe('trackingDateRange', () => {
    it('is undefined when neither bound is given', () => {
      expect(trackingDateRange(undefined, undefined)).toBeUndefined();
    });

    it('expands a date-only upper bound to the end of that day', () => {
      expect(trackingDateRange(undefined, '2026-08-20')).toEqual({
        lte: new Date('2026-08-20T23:59:59.999Z'),
      });
    });

    it('leaves an explicit date-time upper bound exactly as given', () => {
      expect(trackingDateRange(undefined, '2026-08-20T09:30:00.000Z')).toEqual({
        lte: new Date('2026-08-20T09:30:00.000Z'),
      });
    });

    it('takes the lower bound at the start of its day', () => {
      expect(trackingDateRange('2026-08-01', '2026-08-20')).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-20T23:59:59.999Z'),
      });
    });
  });

  // -------------------------------------------------------------- PII gating

  describe('PII masking', () => {
    beforeEach(() => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'comment-1',
          body: 'Great episode',
          status: CommentStatus.VISIBLE,
          platform: ClientPlatform.MOBILE,
          ipAddress: '203.0.113.7',
          parentId: null,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          user: commenter(),
          movie: { id: 'movie-1', title: 'Avengers' },
          series: null,
        },
      ]);
      prisma.comment.count.mockResolvedValue(1);
    });

    it('masks phone and IP for a caller holding TRACKING.VIEW but not PII_VIEW', async () => {
      const result = await service.comments(analyst, {});

      expect(result.items[0].user.phone).toBe('+9*****369');
      expect(result.items[0].ipAddress).toBe('203.0.113.***');
    });

    it('returns phone and IP in full for a caller holding TRACKING.PII_VIEW', async () => {
      const result = await service.comments(investigator, {});

      expect(result.items[0].user.phone).toBe('+95950495369');
      expect(result.items[0].ipAddress).toBe('203.0.113.7');
    });

    it('returns them in full for a protected role, which holds every permission', async () => {
      const result = await service.comments(superAdmin, {});

      expect(result.items[0].user.phone).toBe('+95950495369');
      expect(result.items[0].ipAddress).toBe('203.0.113.7');
    });

    it('never serialises the real value anywhere in a masked response', async () => {
      const result = await service.comments(analyst, {});

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('+95950495369');
      expect(serialised).not.toContain('203.0.113.7');
    });

    it('masks the raw search log the same way', async () => {
      prisma.searchQuery.findMany.mockResolvedValue([
        {
          id: 'search-1',
          term: 'Avengers',
          normalizedTerm: 'avengers',
          resultCount: 3,
          platform: ClientPlatform.WEB,
          ipAddress: '203.0.113.7',
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          user: commenter(),
        },
      ]);
      prisma.searchQuery.count.mockResolvedValue(1);

      const masked = await service.recentSearches(analyst, {});
      const full = await service.recentSearches(investigator, {});

      expect(masked.items[0].ipAddress).toBe('203.0.113.***');
      expect(masked.items[0].user?.phone).toBe('+9*****369');
      expect(full.items[0].ipAddress).toBe('203.0.113.7');
      expect(full.items[0].user?.phone).toBe('+95950495369');
    });

    it('masks the session list the same way', async () => {
      prisma.userSession.findMany.mockResolvedValue([
        {
          id: 'session-1',
          platform: ClientPlatform.WEB,
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          createdAt: new Date('2026-08-20T09:00:00.000Z'),
          lastSeenAt: new Date('2026-08-20T10:00:00.000Z'),
          endedAt: null,
        },
      ]);
      prisma.userSession.count.mockResolvedValue(1);

      const masked = await service.userSessions(analyst, 'user-1', {});
      const full = await service.userSessions(investigator, 'user-1', {});

      expect(masked.items[0].ipAddress).toBe('203.0.113.***');
      expect(full.items[0].ipAddress).toBe('203.0.113.7');
      // The user agent is not PII under this gate and stays readable.
      expect(masked.items[0].userAgent).toBe('Mozilla/5.0');
    });

    it('leaves an absent phone as null rather than inventing a mask', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'comment-1',
          body: 'Great episode',
          status: CommentStatus.VISIBLE,
          platform: ClientPlatform.WEB,
          ipAddress: null,
          parentId: null,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          user: commenter({ phone: null }),
          movie: { id: 'movie-1', title: 'Avengers' },
          series: null,
        },
      ]);

      const result = await service.comments(analyst, {});

      expect(result.items[0].user.phone).toBeNull();
      expect(result.items[0].ipAddress).toBeNull();
    });
  });

  // ---------------------------------------------------------------- comments

  describe('comments', () => {
    it('returns the house pagination shape with defaults', async () => {
      prisma.comment.count.mockResolvedValue(0);

      const result = await service.comments(analyst, {});

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    });

    it('searches the body and the commenter identity together', async () => {
      await service.comments(analyst, { search: '  blake ' });

      const where = prisma.comment.findMany.mock.calls[0][0].where as {
        OR: unknown[];
      };
      expect(where.OR).toEqual([
        { body: { contains: 'blake', mode: 'insensitive' } },
        { user: { username: { contains: 'blake', mode: 'insensitive' } } },
        { user: { displayName: { contains: 'blake', mode: 'insensitive' } } },
        { user: { phone: { contains: 'blake' } } },
      ]);
    });

    it('does not filter by status unless asked, so hidden comments stay reviewable', async () => {
      await service.comments(analyst, {});

      expect(prisma.comment.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('labels a movie comment and a series comment by kind', async () => {
      prisma.comment.findMany.mockResolvedValue([
        {
          id: 'c1',
          body: 'a',
          status: CommentStatus.VISIBLE,
          platform: ClientPlatform.WEB,
          ipAddress: null,
          parentId: null,
          createdAt: new Date(),
          user: commenter(),
          movie: { id: 'movie-1', title: 'Avengers' },
          series: null,
        },
        {
          id: 'c2',
          body: 'b',
          status: CommentStatus.VISIBLE,
          platform: ClientPlatform.WEB,
          ipAddress: null,
          parentId: 'c1',
          createdAt: new Date(),
          user: commenter(),
          movie: null,
          series: { id: 'series-1', title: 'Dark' },
        },
      ]);

      const result = await service.comments(analyst, {});

      expect(result.items[0].title).toEqual({
        id: 'movie-1',
        kind: 'MOVIE',
        name: 'Avengers',
      });
      expect(result.items[1].title).toEqual({
        id: 'series-1',
        kind: 'SERIES',
        name: 'Dark',
      });
      expect(result.items[1].parentId).toBe('c1');
    });

    it('paginates by skip/take from page and limit', async () => {
      await service.comments(analyst, { page: 3, limit: 25 });

      expect(prisma.comment.findMany.mock.calls[0][0]).toMatchObject({
        skip: 50,
        take: 25,
      });
    });
  });

  describe('moderateComment', () => {
    it('hides a comment without deleting it', async () => {
      const result = await service.moderateComment('comment-1', {
        status: CommentStatus.HIDDEN,
      });

      expect(prisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'comment-1' },
        data: { status: CommentStatus.HIDDEN },
        select: { id: true, status: true },
      });
      expect(result.status).toBe(CommentStatus.HIDDEN);
    });

    it('404s on a comment that does not exist, without writing', async () => {
      prisma.comment.findUnique.mockResolvedValue(null);

      await expect(
        service.moderateComment('missing', { status: CommentStatus.HIDDEN }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.comment.update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------- feedback

  describe('feedback', () => {
    it('combines every filter into one where clause', async () => {
      await service.feedback(analyst, {
        status: FeedbackStatus.NEW,
        category: FeedbackCategory.BUG,
        platform: ClientPlatform.MOBILE,
        from: '2026-08-01',
        to: '2026-08-20',
      });

      expect(prisma.feedback.findMany.mock.calls[0][0].where).toEqual({
        status: FeedbackStatus.NEW,
        category: FeedbackCategory.BUG,
        platform: ClientPlatform.MOBILE,
        createdAt: {
          gte: new Date('2026-08-01T00:00:00.000Z'),
          lte: new Date('2026-08-20T23:59:59.999Z'),
        },
      });
    });
  });

  describe('updateFeedbackStatus', () => {
    const updatedRow = {
      id: 'feedback-1',
      category: FeedbackCategory.BUG,
      message: 'The player stalls',
      status: FeedbackStatus.RESOLVED,
      platform: ClientPlatform.MOBILE,
      ipAddress: '203.0.113.7',
      adminNote: 'Fixed in 2.4',
      handledAt: new Date('2026-08-20T12:00:00.000Z'),
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      user: commenter(),
      handledBy: {
        id: 'staff-analyst',
        username: 'analyst',
        displayName: null,
      },
    };

    beforeEach(() => {
      prisma.feedback.update.mockResolvedValue(updatedRow);
    });

    it('stamps the acting staff member and a server-side handledAt', async () => {
      const before = Date.now();
      await service.updateFeedbackStatus(
        'feedback-1',
        { status: FeedbackStatus.RESOLVED },
        analyst,
      );
      const after = Date.now();

      const data = prisma.feedback.update.mock.calls[0][0].data as {
        handledByUserId: string;
        handledAt: Date;
        status: FeedbackStatus;
      };
      expect(data.handledByUserId).toBe('staff-analyst');
      expect(data.status).toBe(FeedbackStatus.RESOLVED);
      expect(data.handledAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(data.handledAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('leaves an existing note untouched when adminNote is omitted', async () => {
      await service.updateFeedbackStatus(
        'feedback-1',
        { status: FeedbackStatus.IN_REVIEW },
        analyst,
      );

      expect(prisma.feedback.update.mock.calls[0][0].data).not.toHaveProperty(
        'adminNote',
      );
    });

    it('clears the note when an empty string is sent', async () => {
      await service.updateFeedbackStatus(
        'feedback-1',
        { status: FeedbackStatus.DISMISSED, adminNote: '' },
        analyst,
      );

      expect(prisma.feedback.update.mock.calls[0][0].data).toMatchObject({
        adminNote: '',
      });
    });

    it('masks the PII in its own response for a caller without PII_VIEW', async () => {
      const result = await service.updateFeedbackStatus(
        'feedback-1',
        { status: FeedbackStatus.RESOLVED },
        analyst,
      );

      expect(result.ipAddress).toBe('203.0.113.***');
      expect(result.user.phone).toBe('+9*****369');
    });

    it('404s on a feedback row that does not exist, without writing', async () => {
      prisma.feedback.findUnique.mockResolvedValue(null);

      await expect(
        service.updateFeedbackStatus(
          'missing',
          { status: FeedbackStatus.RESOLVED },
          analyst,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.feedback.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------ active users

  describe('activeUsers', () => {
    const socket = (
      userId: string,
      platform: ClientPlatform,
      platforms: ClientPlatform[],
      since: Date,
      ip: string | null = '203.0.113.7',
    ): ActiveSocketUser => ({ userId, platform, platforms, ip, since });

    beforeEach(() => {
      prisma.user.findMany.mockImplementation(
        ({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.map((id) => ({
              id,
              username: id,
              displayName: null,
              phone: '+95950495369',
            })),
          ),
      );
    });

    it('reads presence within the 5-minute window, ignoring ended sessions', async () => {
      const before = Date.now();
      await service.activeUsers(analyst, {});

      const where = prisma.userSession.findMany.mock.calls[0][0].where as {
        lastSeenAt: { gte: Date };
        endedAt: null;
      };
      expect(where.endedAt).toBeNull();
      expect(where.lastSeenAt.gte.getTime()).toBeGreaterThanOrEqual(
        before - ACTIVE_USER_WINDOW_MS,
      );
      expect(where.lastSeenAt.gte.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('counts a user with two tabs once', async () => {
      // Two tabs are already one entry from the gateway; the point here is
      // that a second signal for the same user does not become a second row.
      gateway.getActiveUsers.mockReturnValue([
        socket(
          'user-1',
          ClientPlatform.WEB,
          [ClientPlatform.WEB],
          new Date('2026-08-20T10:00:00.000Z'),
        ),
      ]);
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'user-1',
          platform: ClientPlatform.WEB,
          ipAddress: '203.0.113.7',
          lastSeenAt: new Date('2026-08-20T10:04:00.000Z'),
        },
      ]);

      const result = await service.activeUsers(analyst, {});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.summary).toEqual({ total: 1, web: 1, mobile: 0 });
    });

    it('reports one user on web AND mobile as one row present on both', async () => {
      gateway.getActiveUsers.mockReturnValue([
        socket(
          'user-1',
          ClientPlatform.MOBILE,
          [ClientPlatform.WEB, ClientPlatform.MOBILE],
          new Date('2026-08-20T10:00:00.000Z'),
        ),
      ]);

      const result = await service.activeUsers(analyst, {});

      expect(result.items).toHaveLength(1);
      expect([...result.items[0].platforms].sort()).toEqual(
        [ClientPlatform.MOBILE, ClientPlatform.WEB].sort(),
      );
      // Counted in both platform cards, but only once in the total.
      expect(result.summary).toEqual({ total: 1, web: 1, mobile: 1 });
    });

    it('unions socket presence with recently-active sessions', async () => {
      gateway.getActiveUsers.mockReturnValue([
        socket(
          'user-socket',
          ClientPlatform.WEB,
          [ClientPlatform.WEB],
          new Date('2026-08-20T10:00:00.000Z'),
        ),
      ]);
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'user-session',
          platform: ClientPlatform.MOBILE,
          ipAddress: '198.51.100.9',
          lastSeenAt: new Date('2026-08-20T10:03:00.000Z'),
        },
      ]);

      const result = await service.activeUsers(analyst, {});

      expect(result.summary).toEqual({ total: 2, web: 1, mobile: 1 });
      const byId = new Map(result.items.map((item) => [item.user.id, item]));
      expect(byId.get('user-socket')?.online).toBe(true);
      // Recently active but no live socket: present, not online.
      expect(byId.get('user-session')?.online).toBe(false);
    });

    it('takes the single-value columns from the newest signal', async () => {
      gateway.getActiveUsers.mockReturnValue([
        socket(
          'user-1',
          ClientPlatform.WEB,
          [ClientPlatform.WEB],
          new Date('2026-08-20T09:00:00.000Z'),
          '203.0.113.7',
        ),
      ]);
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'user-1',
          platform: ClientPlatform.MOBILE,
          ipAddress: '198.51.100.9',
          lastSeenAt: new Date('2026-08-20T10:00:00.000Z'),
        },
      ]);

      const result = await service.activeUsers(investigator, {});

      expect(result.items[0].platform).toBe(ClientPlatform.MOBILE);
      expect(result.items[0].ipAddress).toBe('198.51.100.9');
      expect(result.items[0].lastActivity).toEqual(
        new Date('2026-08-20T10:00:00.000Z'),
      );
      expect(result.items[0].online).toBe(true);
    });

    it('sorts online users first, then by most recent activity', async () => {
      gateway.getActiveUsers.mockReturnValue([
        socket(
          'user-online',
          ClientPlatform.WEB,
          [ClientPlatform.WEB],
          new Date('2026-08-20T09:00:00.000Z'),
        ),
      ]);
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'user-recent',
          platform: ClientPlatform.WEB,
          ipAddress: null,
          lastSeenAt: new Date('2026-08-20T10:04:00.000Z'),
        },
        {
          userId: 'user-older',
          platform: ClientPlatform.WEB,
          ipAddress: null,
          lastSeenAt: new Date('2026-08-20T10:01:00.000Z'),
        },
      ]);

      const result = await service.activeUsers(analyst, {});

      expect(result.items.map((item) => item.user.id)).toEqual([
        'user-online',
        'user-recent',
        'user-older',
      ]);
    });

    it('filters rows by platform while leaving the summary describing everyone', async () => {
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'user-web',
          platform: ClientPlatform.WEB,
          ipAddress: null,
          lastSeenAt: new Date('2026-08-20T10:04:00.000Z'),
        },
        {
          userId: 'user-mobile',
          platform: ClientPlatform.MOBILE,
          ipAddress: null,
          lastSeenAt: new Date('2026-08-20T10:03:00.000Z'),
        },
      ]);

      const result = await service.activeUsers(analyst, {
        platform: ClientPlatform.MOBILE,
      });

      expect(result.items.map((item) => item.user.id)).toEqual(['user-mobile']);
      expect(result.total).toBe(1);
      expect(result.summary).toEqual({ total: 2, web: 1, mobile: 1 });
    });

    it('drops a presence signal whose account no longer exists', async () => {
      prisma.userSession.findMany.mockResolvedValue([
        {
          userId: 'ghost',
          platform: ClientPlatform.WEB,
          ipAddress: null,
          lastSeenAt: new Date('2026-08-20T10:04:00.000Z'),
        },
      ]);
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.activeUsers(analyst, {});

      expect(result.items).toEqual([]);
    });

    it('reports an empty platform with no rows rather than a fabricated count', async () => {
      const result = await service.activeUsers(analyst, {});

      expect(result.items).toEqual([]);
      expect(result.summary).toEqual({ total: 0, web: 0, mobile: 0 });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------- watch time

  /**
   * These assertions are written to be timezone-agnostic on purpose.
   *
   * `hourStart` is stored as a UTC-truncated instant and re-bucketed here by
   * the SERVER's local hour/weekday, so the only honest way to pin that
   * without pinning the suite to one timezone is to build the fixture from a
   * LOCAL wall-clock time (`new Date(y, m, d, 21)` is local 21:00 in any
   * zone) and assert it lands at 21 — and, crucially, at NO other hour.
   *
   * Flipping `process.env.TZ` mid-suite is not an option: Node caches the
   * zone on first use, so a second assignment inside the same jest worker is
   * silently ignored and would leak into whatever spec ran next in it.
   */
  describe('watchTime', () => {
    it('buckets a stored instant by its SERVER-LOCAL hour, and only that hour', async () => {
      // A UTC-truncated bucket, exactly as the ingest side writes it.
      const stored = new Date(Date.UTC(2026, 7, 20, 13, 0, 0));
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(stored, ClientPlatform.WEB, 600),
      ]);

      const report = await service.watchTime({});

      // Read back through the local accessors — the choice this report makes.
      expect(report.byHour[stored.getHours()].web).toBe(600);
      expect(report.byWeekday[stored.getDay()].web).toBe(600);
      expect(
        report.byHour.filter((entry) => entry.total > 0).map((e) => e.hour),
      ).toEqual([stored.getHours()]);
      expect(report.peak).toEqual({
        hour: stored.getHours(),
        weekday: stored.getDay(),
        seconds: 600,
      });
    });

    it('places a local-evening bucket at hour 21 whatever zone the server runs in', async () => {
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(new Date(2026, 7, 20, 21, 0, 0), ClientPlatform.WEB, 600),
      ]);

      const report = await service.watchTime({});

      expect(report.byHour[21].web).toBe(600);
      expect(
        report.byHour.filter((entry) => entry.total > 0).map((e) => e.hour),
      ).toEqual([21]);
    });

    it('splits two buckets an hour apart into adjacent hours', async () => {
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(new Date(2026, 7, 20, 21, 0, 0), ClientPlatform.WEB, 300),
        bucket(new Date(2026, 7, 20, 22, 0, 0), ClientPlatform.WEB, 120),
      ]);

      const report = await service.watchTime({});

      expect(report.byHour[21].total).toBe(300);
      expect(report.byHour[22].total).toBe(120);
      expect(report.totals.total).toBe(420);
    });

    it('keeps web and mobile separate and sums them into total', async () => {
      const hour = new Date(2026, 7, 20, 21, 0, 0);
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(hour, ClientPlatform.WEB, 300, 5),
        bucket(hour, ClientPlatform.MOBILE, 200, 3),
        bucket(hour, ClientPlatform.UNKNOWN, 10, 1),
      ]);

      const report = await service.watchTime({});

      expect(report.byHour[21]).toEqual({
        hour: 21,
        web: 300,
        mobile: 200,
        unknown: 10,
        total: 510,
      });
      expect(report.totals).toEqual({
        web: 300,
        mobile: 200,
        unknown: 10,
        total: 510,
        heartbeats: 9,
      });
    });

    it('accumulates hours across days into the same hour-of-day', async () => {
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(new Date(2026, 7, 20, 21, 0, 0), ClientPlatform.WEB, 300),
        bucket(new Date(2026, 7, 21, 21, 0, 0), ClientPlatform.WEB, 100),
      ]);

      const report = await service.watchTime({});

      expect(report.byHour[21].web).toBe(400);
      // ...while staying separate per weekday in the heatmap.
      const thursday = new Date(2026, 7, 20, 21, 0, 0).getDay();
      const friday = new Date(2026, 7, 21, 21, 0, 0).getDay();
      expect(report.byWeekday[thursday].web).toBe(300);
      expect(report.byWeekday[friday].web).toBe(100);
    });

    it('always returns the full 24 x 7 grid, zero-filled', async () => {
      const report = await service.watchTime({});

      expect(report.byHour).toHaveLength(24);
      expect(report.byWeekday).toHaveLength(7);
      expect(report.heatmap).toHaveLength(168);
      expect(report.heatmap.every((cell) => cell.seconds === 0)).toBe(true);
    });

    it('reports a null peak rather than inventing one when there is no data', async () => {
      const report = await service.watchTime({});

      expect(report.peak).toBeNull();
      expect(report.totals.total).toBe(0);
    });

    it('picks the busiest weekday/hour cell as the peak', async () => {
      prisma.watchActivity.groupBy.mockResolvedValue([
        bucket(new Date(2026, 7, 20, 21, 0, 0), ClientPlatform.WEB, 300),
        bucket(new Date(2026, 7, 22, 9, 0, 0), ClientPlatform.MOBILE, 900),
      ]);

      const report = await service.watchTime({});

      expect(report.peak).toEqual({
        hour: 9,
        weekday: new Date(2026, 7, 22, 9, 0, 0).getDay(),
        seconds: 900,
      });
    });

    it('passes the platform and date filters down to one grouped query', async () => {
      await service.watchTime({
        platform: ClientPlatform.MOBILE,
        from: '2026-08-01',
        to: '2026-08-20',
      });

      expect(prisma.watchActivity.groupBy).toHaveBeenCalledTimes(1);
      expect(prisma.watchActivity.groupBy.mock.calls[0][0].where).toEqual({
        platform: ClientPlatform.MOBILE,
        hourStart: {
          gte: new Date('2026-08-01T00:00:00.000Z'),
          lte: new Date('2026-08-20T23:59:59.999Z'),
        },
      });
    });
  });

  // ---------------------------------------------------------------- searches

  describe('topSearches', () => {
    beforeEach(() => {
      prisma.searchQuery.groupBy.mockImplementation(
        ({ by }: { by: string[] }) => {
          if (by.length === 1) {
            return Promise.resolve([
              {
                normalizedTerm: 'avengers',
                _count: { _all: 5 },
                _avg: { resultCount: 2.5 },
                _max: { createdAt: new Date('2026-08-20T10:00:00.000Z') },
              },
            ]);
          }
          return Promise.resolve([
            {
              normalizedTerm: 'avengers',
              term: 'Avengers',
              platform: ClientPlatform.WEB,
              _count: { _all: 3 },
            },
            {
              normalizedTerm: 'avengers',
              term: 'avengers',
              platform: ClientPlatform.MOBILE,
              _count: { _all: 1 },
            },
            {
              normalizedTerm: 'avengers',
              term: 'Avengers',
              platform: ClientPlatform.MOBILE,
              _count: { _all: 1 },
            },
          ]);
        },
      );
    });

    it('groups by normalizedTerm and labels the row with the most common raw spelling', async () => {
      const result = await service.topSearches({});

      // "Avengers" was typed 3 + 1 = 4 times, "avengers" once.
      expect(result.items[0].term).toBe('Avengers');
      expect(result.items[0].normalizedTerm).toBe('avengers');
      expect(result.items[0].count).toBe(5);
    });

    it('reports the platforms a term was searched from', async () => {
      const result = await service.topSearches({});

      expect([...result.items[0].platforms].sort()).toEqual(
        [ClientPlatform.MOBILE, ClientPlatform.WEB].sort(),
      );
    });

    it('reports the average result count and the last time it was searched', async () => {
      const result = await service.topSearches({});

      expect(result.items[0].avgResults).toBe(2.5);
      expect(result.items[0].lastSearchedAt).toEqual(
        new Date('2026-08-20T10:00:00.000Z'),
      );
    });

    it('rounds a repeating average to two decimals instead of to an integer', async () => {
      prisma.searchQuery.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                {
                  normalizedTerm: 'ghost title',
                  _count: { _all: 3 },
                  _avg: { resultCount: 1 / 3 },
                  _max: { createdAt: null },
                },
              ])
            : Promise.resolve([]),
      );

      const result = await service.topSearches({});

      expect(result.items[0].avgResults).toBe(0.33);
    });

    it('orders by count desc and totals the DISTINCT terms, not the rows', async () => {
      const result = await service.topSearches({});

      expect(prisma.searchQuery.groupBy.mock.calls[0][0].orderBy).toEqual([
        { _count: { normalizedTerm: 'desc' } },
        { _max: { createdAt: 'desc' } },
      ]);
      expect(result.total).toBe(1);
    });

    it('normalises the search filter the same way the stored column is', async () => {
      await service.topSearches({ search: '  The   AVENGERS ' });

      expect(prisma.searchQuery.groupBy.mock.calls[0][0].where).toEqual({
        normalizedTerm: { contains: 'the avengers' },
      });
    });

    it('never runs a per-term query — three grouped calls, whatever the page size', async () => {
      await service.topSearches({ limit: 100 });

      expect(prisma.searchQuery.groupBy).toHaveBeenCalledTimes(3);
    });

    it('skips the spelling pass entirely when the page is empty', async () => {
      prisma.searchQuery.groupBy.mockResolvedValue([]);

      const result = await service.topSearches({});

      expect(result.items).toEqual([]);
      expect(prisma.searchQuery.groupBy).toHaveBeenCalledTimes(2);
    });

    it('falls back to the normalised term when no raw spelling survives', async () => {
      prisma.searchQuery.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                {
                  normalizedTerm: 'avengers',
                  _count: { _all: 1 },
                  _avg: { resultCount: null },
                  _max: { createdAt: null },
                },
              ])
            : Promise.resolve([]),
      );

      const result = await service.topSearches({});

      expect(result.items[0].term).toBe('avengers');
      expect(result.items[0].avgResults).toBe(0);
    });
  });

  describe('recentSearches', () => {
    it('returns the raw log newest first', async () => {
      await service.recentSearches(analyst, {});

      expect(prisma.searchQuery.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'desc',
      });
    });

    it('keeps an anonymous search, with a null user rather than a dropped row', async () => {
      prisma.searchQuery.findMany.mockResolvedValue([
        {
          id: 'search-1',
          term: 'Avengers',
          normalizedTerm: 'avengers',
          resultCount: 0,
          platform: ClientPlatform.WEB,
          ipAddress: null,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          user: null,
        },
      ]);
      prisma.searchQuery.count.mockResolvedValue(1);

      const result = await service.recentSearches(analyst, {});

      expect(result.items[0].user).toBeNull();
      expect(result.items[0].resultCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------- sessions

  describe('sessions', () => {
    const groupRow = (userId: string, count: number, lastSeenAt: string) => ({
      userId,
      _count: { _all: count },
      _max: { lastSeenAt: new Date(lastSeenAt) },
    });

    const newestRow = (
      userId: string,
      ipAddress: string | null,
      phone: string | null = '+95950495369',
      platform: ClientPlatform = ClientPlatform.WEB,
    ) => ({
      userId,
      platform,
      ipAddress,
      user: {
        id: userId,
        username: userId,
        displayName: null,
        phone,
      },
    });

    it('returns one row per user, with that user session count and last activity', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1 && by[0] === 'userId'
            ? Promise.resolve([
                groupRow('user-1', 4, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '203.0.113.7'),
      ]);

      const result = await service.sessions(investigator, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sessionCount).toBe(4);
      expect(result.items[0].lastActive).toEqual(
        new Date('2026-08-20T10:00:00.000Z'),
      );
      expect(result.items[0].ipAddress).toBe('203.0.113.7');
      expect(result.items[0].platform).toBe(ClientPlatform.WEB);
    });

    it('flags an IP that more than one account signs in from', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) => {
          if (by.length === 1) {
            return Promise.resolve([
              groupRow('user-1', 2, '2026-08-20T10:00:00.000Z'),
              groupRow('user-2', 1, '2026-08-20T09:00:00.000Z'),
            ]);
          }
          // (ipAddress, userId) pairs: one address, two accounts.
          return Promise.resolve([
            { ipAddress: '203.0.113.7', userId: 'user-1' },
            { ipAddress: '203.0.113.7', userId: 'user-2' },
            { ipAddress: '198.51.100.9', userId: 'user-1' },
          ]);
        },
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '203.0.113.7'),
        newestRow('user-2', '203.0.113.7'),
      ]);

      const result = await service.sessions(investigator, {});

      expect(result.items.map((item) => item.sharedIp)).toEqual([true, true]);
    });

    it('does not flag an IP that only one account uses, however many sessions', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 9, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([
                { ipAddress: '198.51.100.9', userId: 'user-1' },
                { ipAddress: '198.51.100.9', userId: 'user-1' },
              ]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '198.51.100.9'),
      ]);

      const result = await service.sessions(investigator, {});

      expect(result.items[0].sharedIp).toBe(false);
    });

    it('derives sharedIp from ONE grouped query, not one per row', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 1, '2026-08-20T10:00:00.000Z'),
                groupRow('user-2', 1, '2026-08-20T09:00:00.000Z'),
                groupRow('user-3', 1, '2026-08-20T08:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '203.0.113.7'),
        newestRow('user-2', '203.0.113.8'),
        newestRow('user-3', '203.0.113.9'),
      ]);

      await service.sessions(investigator, {});

      // page groups + distinct groups + the one (ip, user) pass = 3.
      expect(prisma.userSession.groupBy).toHaveBeenCalledTimes(3);
      expect(prisma.userSession.findMany).toHaveBeenCalledTimes(1);
      const ipCall = prisma.userSession.groupBy.mock.calls.find(
        (call) => (call[0] as { by: string[] }).by.length === 2,
      );
      expect(ipCall?.[0]).toEqual({
        by: ['ipAddress', 'userId'],
        where: {
          ipAddress: { in: ['203.0.113.7', '203.0.113.8', '203.0.113.9'] },
        },
      });
    });

    it('judges sharedIp globally, ignoring the report date/platform filters', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 1, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '203.0.113.7'),
      ]);

      await service.sessions(investigator, {
        from: '2026-08-20',
        platform: ClientPlatform.WEB,
      });

      const ipCall = prisma.userSession.groupBy.mock.calls.find(
        (call) => (call[0] as { by: string[] }).by.length === 2,
      );
      expect(ipCall?.[0]).toEqual({
        by: ['ipAddress', 'userId'],
        where: { ipAddress: { in: ['203.0.113.7'] } },
      });
    });

    it('flags a phone on more than one account, though it should never happen', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 1, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', null),
      ]);
      prisma.user.groupBy.mockResolvedValue([
        { phone: '+95950495369', _count: { _all: 2 } },
      ]);

      const result = await service.sessions(investigator, {});

      expect(result.items[0].sharedPhone).toBe(true);
    });

    it('reports sharedPhone false for the expected unique-phone case', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 1, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', null),
      ]);
      prisma.user.groupBy.mockResolvedValue([
        { phone: '+95950495369', _count: { _all: 1 } },
      ]);

      const result = await service.sessions(investigator, {});

      expect(result.items[0].sharedPhone).toBe(false);
    });

    it('masks the IP and phone of the row for a caller without PII_VIEW', async () => {
      prisma.userSession.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          by.length === 1
            ? Promise.resolve([
                groupRow('user-1', 1, '2026-08-20T10:00:00.000Z'),
              ])
            : Promise.resolve([]),
      );
      prisma.userSession.findMany.mockResolvedValue([
        newestRow('user-1', '203.0.113.7'),
      ]);

      const result = await service.sessions(analyst, {});

      expect(result.items[0].ipAddress).toBe('203.0.113.***');
      expect(result.items[0].user.phone).toBe('+9*****369');
    });

    it('combines the phone, ip, search and platform filters into one where', async () => {
      await service.sessions(analyst, {
        phone: ' 0950 ',
        ip: ' 203.0.113. ',
        search: ' blake ',
        platform: ClientPlatform.WEB,
        from: '2026-08-01',
      });

      expect(prisma.userSession.groupBy.mock.calls[0][0].where).toEqual({
        platform: ClientPlatform.WEB,
        lastSeenAt: { gte: new Date('2026-08-01T00:00:00.000Z') },
        ipAddress: { contains: '203.0.113.' },
        user: {
          phone: { contains: '0950' },
          OR: [
            { username: { contains: 'blake', mode: 'insensitive' } },
            { displayName: { contains: 'blake', mode: 'insensitive' } },
            { phone: { contains: 'blake' } },
          ],
        },
      });
    });

    it('skips the follow-up queries entirely when nothing matched', async () => {
      const result = await service.sessions(analyst, {});

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
      expect(prisma.userSession.findMany).not.toHaveBeenCalled();
      expect(prisma.user.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('userSessions', () => {
    it('lists one user own sessions newest first, paginated', async () => {
      await service.userSessions(analyst, 'user-1', { page: 2, limit: 10 });

      expect(prisma.userSession.findMany.mock.calls[0][0]).toMatchObject({
        where: { userId: 'user-1' },
        orderBy: { lastSeenAt: 'desc' },
        skip: 10,
        take: 10,
      });
    });
  });
});
