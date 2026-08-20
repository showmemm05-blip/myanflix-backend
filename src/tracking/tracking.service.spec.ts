import { Test, TestingModule } from '@nestjs/testing';
import { ClientPlatform, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestHostContext } from '../common/storage/request-host.context';
import {
  hourStartOf,
  LAST_SEEN_THROTTLE_MS,
  MAX_WATCH_DELTA_SECONDS,
  normalizeSearchTerm,
  TrackingService,
  watchDeltaSeconds,
} from './tracking.service';

/** Runs `fn` as if it were inside an HTTP request with this client context. */
function inRequest<T>(
  ctx: { ip?: string | null; userAgent?: string | null; platform?: ClientPlatform },
  fn: () => Promise<T>,
): Promise<T> {
  return requestHostContext.run({ hostname: 'localhost', ...ctx }, fn);
}

describe('TrackingService — pure helpers', () => {
  describe('normalizeSearchTerm', () => {
    it('trims, lowercases and collapses runs of whitespace', () => {
      expect(normalizeSearchTerm('  Avengers   ENDGAME  ')).toBe(
        'avengers endgame',
      );
    });

    it('maps every spelling of one search to the same grouping key', () => {
      const spellings = ['Avengers', 'avengers', ' AVENGERS ', 'aVeNgErS'];
      expect(new Set(spellings.map(normalizeSearchTerm)).size).toBe(1);
    });

    it('normalises tabs and newlines, not just spaces', () => {
      expect(normalizeSearchTerm('the\tdark\nknight')).toBe('the dark knight');
    });
  });

  describe('watchDeltaSeconds', () => {
    it('credits the exact gap between two forward heartbeats', () => {
      expect(watchDeltaSeconds(120, 128)).toBe(8);
    });

    it('credits 0 for a backwards seek instead of a negative number', () => {
      expect(watchDeltaSeconds(600, 30)).toBe(0);
    });

    it('credits 0 for a duplicate heartbeat at the same position', () => {
      expect(watchDeltaSeconds(420, 420)).toBe(0);
    });

    it('caps an absurd forward jump at MAX_WATCH_DELTA_SECONDS', () => {
      expect(watchDeltaSeconds(0, 7200)).toBe(MAX_WATCH_DELTA_SECONDS);
    });

    it('credits a gap exactly at the cap in full', () => {
      expect(watchDeltaSeconds(10, 10 + MAX_WATCH_DELTA_SECONDS)).toBe(
        MAX_WATCH_DELTA_SECONDS,
      );
    });

    it('credits 0 rather than NaN when a position is not a number', () => {
      expect(watchDeltaSeconds(0, Number.NaN)).toBe(0);
      expect(watchDeltaSeconds(Number.NaN, 50)).toBe(0);
    });
  });

  describe('hourStartOf', () => {
    it('truncates to the top of the UTC hour', () => {
      expect(hourStartOf(new Date('2026-08-20T13:47:31.500Z')).toISOString()).toBe(
        '2026-08-20T13:00:00.000Z',
      );
    });

    it('leaves an exact hour untouched', () => {
      expect(hourStartOf(new Date('2026-08-20T13:00:00.000Z')).toISOString()).toBe(
        '2026-08-20T13:00:00.000Z',
      );
    });

    it('does not mutate the date it was given', () => {
      const at = new Date('2026-08-20T13:47:31.500Z');
      hourStartOf(at);
      expect(at.toISOString()).toBe('2026-08-20T13:47:31.500Z');
    });
  });
});

describe('TrackingService', () => {
  let service: TrackingService;
  let prisma: {
    searchQuery: { create: jest.Mock };
    watchActivity: { upsert: jest.Mock };
    userSession: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
    user: { update: jest.Mock };
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      searchQuery: { create: jest.fn().mockResolvedValue({}) },
      watchActivity: { upsert: jest.fn().mockResolvedValue({}) },
      userSession: {
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: { update: jest.fn().mockResolvedValue({}) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TrackingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(TrackingService);
  });

  describe('recordSearch — staff exclusion', () => {
    it.each([Role.ADMIN, Role.SUPER_ADMIN, Role.CONTENT_UPLOADER])(
      'writes nothing for a %s search — staff browsing is not user demand',
      async (viewerRole) => {
        await service.recordSearch({
          term: 'avengers',
          resultCount: 3,
          userId: 'staff-1',
          viewerRole,
        });

        expect(prisma.searchQuery.create).not.toHaveBeenCalled();
      },
    );

    it('logs a USER search', async () => {
      await service.recordSearch({
        term: 'avengers',
        resultCount: 3,
        userId: 'user-1',
        viewerRole: Role.USER,
      });

      expect(prisma.searchQuery.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordSearch — what gets stored', () => {
    it('keeps the raw spelling in `term` and the grouping key in `normalizedTerm`', async () => {
      await service.recordSearch({
        term: '  The   Dark KNIGHT ',
        resultCount: 2,
        userId: 'user-1',
        viewerRole: Role.USER,
      });

      expect(prisma.searchQuery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          term: 'The   Dark KNIGHT',
          normalizedTerm: 'the dark knight',
        }),
      });
    });

    it('stores the real total the query returned as resultCount, including 0', async () => {
      await service.recordSearch({
        term: 'nothing matches this',
        resultCount: 0,
        userId: 'user-1',
        viewerRole: Role.USER,
      });

      const data = prisma.searchQuery.create.mock.calls[0][0].data;
      expect(data.resultCount).toBe(0);
    });

    it('writes nothing for a whitespace-only term', async () => {
      await service.recordSearch({
        term: '   ',
        resultCount: 12,
        userId: 'user-1',
        viewerRole: Role.USER,
      });

      expect(prisma.searchQuery.create).not.toHaveBeenCalled();
    });

    it('captures platform and IP from the request context', async () => {
      await inRequest(
        { ip: '203.0.113.7', platform: ClientPlatform.MOBILE },
        () =>
          service.recordSearch({
            term: 'avengers',
            resultCount: 1,
            userId: 'user-1',
            viewerRole: Role.USER,
          }),
      );

      expect(prisma.searchQuery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: ClientPlatform.MOBILE,
          ipAddress: '203.0.113.7',
        }),
      });
    });

    it('falls back to UNKNOWN / null outside a request rather than throwing', async () => {
      await service.recordSearch({
        term: 'avengers',
        resultCount: 1,
        userId: null,
        viewerRole: Role.USER,
      });

      expect(prisma.searchQuery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: null,
          platform: ClientPlatform.UNKNOWN,
          ipAddress: null,
        }),
      });
    });
  });

  describe('recordWatchActivity', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    function upsertCall(index = 0) {
      return prisma.watchActivity.upsert.mock.calls[index][0];
    }

    it('increments the bucket by the clamped delta, and heartbeats by one', async () => {
      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 100,
        nextPosition: 115,
      });

      expect(upsertCall().update).toEqual({
        seconds: { increment: 15 },
        heartbeats: { increment: 1 },
      });
      expect(upsertCall().create).toEqual(
        expect.objectContaining({ seconds: 15, heartbeats: 1 }),
      );
    });

    it('adds 0 seconds for a backwards seek but still counts the heartbeat', async () => {
      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 900,
        nextPosition: 12,
      });

      expect(upsertCall().update).toEqual({
        seconds: { increment: 0 },
        heartbeats: { increment: 1 },
      });
    });

    it('caps an absurd forward jump at MAX_WATCH_DELTA_SECONDS', async () => {
      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 0,
        nextPosition: 5400,
      });

      expect(upsertCall().update.seconds.increment).toBe(
        MAX_WATCH_DELTA_SECONDS,
      );
    });

    it('buckets into the current server hour, truncated to the top of the hour', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-20T13:47:31.500Z'));

      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 0,
        nextPosition: 10,
      });

      expect(upsertCall().where).toEqual({
        userId_movieId_platform_hourStart: {
          userId: 'user-1',
          movieId: 'movie-1',
          platform: ClientPlatform.UNKNOWN,
          hourStart: new Date('2026-08-20T13:00:00.000Z'),
        },
      });
    });

    it('splits two heartbeats either side of an hour boundary into two buckets', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-20T13:59:55.000Z'));
      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 0,
        nextPosition: 5,
      });

      jest.setSystemTime(new Date('2026-08-20T14:00:05.000Z'));
      await service.recordWatchActivity({
        userId: 'user-1',
        movieId: 'movie-1',
        previousPosition: 5,
        nextPosition: 15,
      });

      const first =
        upsertCall(0).where.userId_movieId_platform_hourStart.hourStart;
      const second =
        upsertCall(1).where.userId_movieId_platform_hourStart.hourStart;
      expect(first.toISOString()).toBe('2026-08-20T13:00:00.000Z');
      expect(second.toISOString()).toBe('2026-08-20T14:00:00.000Z');
    });

    it('keys the bucket by the request platform, so web and mobile never merge', async () => {
      await inRequest({ platform: ClientPlatform.WEB }, () =>
        service.recordWatchActivity({
          userId: 'user-1',
          movieId: 'movie-1',
          previousPosition: 0,
          nextPosition: 10,
        }),
      );
      await inRequest({ platform: ClientPlatform.MOBILE }, () =>
        service.recordWatchActivity({
          userId: 'user-1',
          movieId: 'movie-1',
          previousPosition: 10,
          nextPosition: 20,
        }),
      );

      expect(
        upsertCall(0).where.userId_movieId_platform_hourStart.platform,
      ).toBe(ClientPlatform.WEB);
      expect(
        upsertCall(1).where.userId_movieId_platform_hourStart.platform,
      ).toBe(ClientPlatform.MOBILE);
    });
  });

  describe('startSession', () => {
    it('opens a session row carrying platform, IP and user agent', async () => {
      await inRequest(
        {
          ip: '203.0.113.7',
          userAgent: 'okhttp/4.12.0',
          platform: ClientPlatform.MOBILE,
        },
        () => service.startSession('user-1'),
      );

      expect(prisma.userSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          platform: ClientPlatform.MOBILE,
          ipAddress: '203.0.113.7',
          userAgent: 'okhttp/4.12.0',
        }),
      });
    });

    it("stamps the user's denormalised presence columns", async () => {
      await inRequest(
        { ip: '198.51.100.9', platform: ClientPlatform.WEB },
        () => service.startSession('user-1'),
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          lastIpAddress: '198.51.100.9',
          lastPlatform: ClientPlatform.WEB,
          lastSeenAt: expect.any(Date),
        }),
      });
    });

    it('seeds the throttle, so the first request on the new token writes nothing more', async () => {
      await service.startSession('user-1');
      prisma.userSession.create.mockClear();
      prisma.user.update.mockClear();

      await service.touchLastSeen('user-1');

      expect(prisma.userSession.create).not.toHaveBeenCalled();
      expect(prisma.userSession.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('touchLastSeen — throttling', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('writes on the first touch for a user', async () => {
      await service.touchLastSeen('user-1');

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('writes once for a burst of touches inside the window', async () => {
      await Promise.all([
        service.touchLastSeen('user-1'),
        service.touchLastSeen('user-1'),
        service.touchLastSeen('user-1'),
      ]);

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('writes again once the window has elapsed', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-20T13:00:00.000Z'));
      await service.touchLastSeen('user-1');

      jest.setSystemTime(
        new Date(Date.now() + LAST_SEEN_THROTTLE_MS + 1),
      );
      await service.touchLastSeen('user-1');

      expect(prisma.user.update).toHaveBeenCalledTimes(2);
    });

    it('throttles per user, not globally', async () => {
      await service.touchLastSeen('user-1');
      await service.touchLastSeen('user-2');

      expect(prisma.user.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('touchLastSeen — which session it touches', () => {
    it('updates the newest open session on the same platform', async () => {
      prisma.userSession.findFirst.mockResolvedValue({ id: 'session-9' });

      await inRequest(
        { ip: '203.0.113.7', platform: ClientPlatform.WEB },
        () => service.touchLastSeen('user-1'),
      );

      expect(prisma.userSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            platform: ClientPlatform.WEB,
            endedAt: null,
          },
          orderBy: { lastSeenAt: 'desc' },
        }),
      );
      expect(prisma.userSession.update).toHaveBeenCalledWith({
        where: { id: 'session-9' },
        data: { lastSeenAt: expect.any(Date), ipAddress: '203.0.113.7' },
      });
      expect(prisma.userSession.create).not.toHaveBeenCalled();
    });

    it('opens one when the user has no session on this platform — tokens issued before session tracking still show as present', async () => {
      prisma.userSession.findFirst.mockResolvedValue(null);

      await inRequest({ platform: ClientPlatform.MOBILE }, () =>
        service.touchLastSeen('user-1'),
      );

      expect(prisma.userSession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          platform: ClientPlatform.MOBILE,
        }),
      });
      expect(prisma.userSession.update).not.toHaveBeenCalled();
    });
  });

  describe('fireAndForget', () => {
    it('swallows a rejection instead of surfacing an unhandled promise', async () => {
      expect(() =>
        service.fireAndForget('search', Promise.reject(new Error('db down'))),
      ).not.toThrow();

      await new Promise(process.nextTick);
    });

    it('returns synchronously — the caller never waits on tracking', () => {
      let settled = false;
      const slow = new Promise<void>((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 0),
      );

      service.fireAndForget('search', slow);

      expect(settled).toBe(false);
    });
  });
});
