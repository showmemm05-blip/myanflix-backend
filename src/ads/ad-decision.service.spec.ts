import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import {
  AdvertisementPlaybackStatus,
  ClientPlatform,
  Role,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS } from './ads-errors';
import { AdDecisionService } from './ad-decision.service';
import { AdSettingsService, type AdRules } from './ad-settings.service';

const NOW = new Date('2026-11-04T10:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const published = { status: 'PUBLISHED', seriesId: null, series: null };

const video = (over: Record<string, unknown> = {}) => ({
  id: 'ad-1',
  title: 'Big match',
  format: 'VIDEO',
  playsBeforeMovie: true,
  playsAtBreaks: false,
  videoKey: 'ads/ad-1/v-aaaa/video.mp4',
  durationSeconds: 15,
  isSkippable: true,
  skipAfterSeconds: 5,
  imageKey: null,
  imageWidth: null,
  imageHeight: null,
  linkUrl: null,
  cornerShowSeconds: null,
  cornerRepeatMinutes: null,
  cornerClosable: true,
  priority: 0,
  dailyStartMinutes: null,
  dailyEndMinutes: null,
  tzOffsetMinutes: 390,
  frequencyLimitMinutes: null,
  maxImpressionsPerUserPerDay: null,
  isActive: true,
  ...over,
});

const corner = (over: Record<string, unknown> = {}) =>
  video({
    id: 'corner-1',
    title: 'Shop',
    format: 'CORNER',
    playsBeforeMovie: false,
    playsAtBreaks: false,
    videoKey: null,
    durationSeconds: null,
    isSkippable: false,
    skipAfterSeconds: null,
    imageKey: 'images/ad/corner-1/ab12.gif',
    imageWidth: 300,
    imageHeight: 100,
    linkUrl: 'https://shop.example.com',
    cornerShowSeconds: 10,
    cornerRepeatMinutes: 15,
    ...over,
  });

const recent = (over: Record<string, unknown>) => ({
  id: 'pb-old',
  advertisementId: 'ad-1',
  placement: 'PREROLL',
  status: 'PENDING',
  breakAtSeconds: null,
  startedAt: null,
  failedAt: null,
  createdAt: minutesAgo(2),
  ...over,
});

describe('AdDecisionService', () => {
  let service: AdDecisionService;
  let rules: AdRules;
  let recentRows: Record<string, unknown>[];
  let siblingRows: Record<string, unknown>[];
  let prisma: {
    movie: { findUnique: jest.Mock };
    advertisement: { findMany: jest.Mock };
    userSubscription: { findFirst: jest.Mock };
    advertisementPlayback: Record<
      'findMany' | 'findFirst' | 'findUnique' | 'updateMany' | 'create',
      jest.Mock
    >;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    rules = {
      adsEnabled: true,
      midrollIntervalMinutes: 0,
      duringMovieAudience: 'ALL',
    };
    recentRows = [];
    siblingRows = [];
    let minted = 0;
    prisma = {
      movie: { findUnique: jest.fn().mockResolvedValue(published) },
      advertisement: { findMany: jest.fn().mockResolvedValue([]) },
      userSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisementPlayback: {
        // The recent-rows read has an OR over the time columns; the sibling
        // read inside the lock filters on status.
        findMany: jest.fn(async ({ where }: { where: { status?: unknown } }) =>
          where.status ? siblingRows : recentRows,
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(async () => ({ id: `pb-new-${++minted}` })),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdDecisionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdSettingsService, useValue: { rules: async () => rules } },
        {
          provide: MinioService,
          useValue: {
            signedPlaybackUrl: (key: string) =>
              `https://cache/s/t/movies/${key}`,
            playbackUrl: (key: string) => `https://cache/movies/${key}`,
          },
        },
      ],
    }).compile();
    service = module.get(AdDecisionService);
  });

  const viewer = (over: Record<string, unknown> = {}) => ({
    userId: 'u1',
    role: Role.USER,
    movieId: 'm1',
    platform: ClientPlatform.WEB,
    now: NOW,
    random: () => 0.5,
    ...over,
  });
  const session = (over: Record<string, unknown> = {}) =>
    service.session(viewer(over));
  const midroll = (
    breakAtSeconds: number,
    over: Record<string, unknown> = {},
  ) => service.midroll({ ...viewer(over), breakAtSeconds });
  const createdPlacements = () =>
    prisma.advertisementPlayback.create.mock.calls.map(
      ([args]: [{ data: { placement: string } }]) => args.data.placement,
    );

  describe('session', () => {
    it('answers nothing, with no query at all, when ads are switched off', async () => {
      rules.adsEnabled = false;
      await expect(session()).resolves.toEqual({
        preroll: null,
        breaks: null,
        corner: null,
      });
      expect(prisma.movie.findUnique).not.toHaveBeenCalled();
      expect(prisma.advertisement.findMany).not.toHaveBeenCalled();
      expect(prisma.advertisementPlayback.findMany).not.toHaveBeenCalled();
    });

    it('is 404 for a missing or hidden title (a viewer), but staff keep previews', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);
      await expect(session()).rejects.toThrow(NotFoundException);
      prisma.movie.findUnique.mockResolvedValue({
        ...published,
        status: 'DRAFT',
      });
      await expect(session()).rejects.toThrow(NotFoundException);
      await expect(session({ role: Role.ADMIN })).resolves.toMatchObject({
        preroll: null,
      });
    });

    it('answers nothing and writes nothing when no ad qualifies', async () => {
      await expect(session()).resolves.toEqual({
        preroll: null,
        breaks: null,
        corner: null,
      });
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
      expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
    });

    it('mints the ad before the movie and the corner picture in one locked transaction', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video(), corner()]);
      const result = await session();
      expect(result.preroll).toEqual({
        playbackId: 'pb-new-1',
        advertisementId: 'ad-1',
        title: 'Big match',
        videoUrl: 'https://cache/s/t/movies/ads/ad-1/v-aaaa/video.mp4',
        durationSeconds: 15,
        isSkippable: true,
        skipAfterSeconds: 5,
      });
      expect(result.corner).toEqual({
        playbackId: 'pb-new-2',
        advertisementId: 'corner-1',
        title: 'Shop',
        imageUrl: 'https://cache/movies/images/ad/corner-1/ab12.gif',
        imageWidth: 300,
        imageHeight: 100,
        linkUrl: 'https://shop.example.com',
        showSeconds: 10,
        repeatSeconds: 900,
        closable: true,
        firstShowAfterSeconds: 60,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(createdPlacements()).toEqual(['PREROLL', 'CORNER']);
      // Only this open's placements are abandoned — never a break row.
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          movieId: 'm1',
          placement: { in: ['PREROLL', 'CORNER'] },
          status: AdvertisementPlaybackStatus.PENDING,
        },
        data: { status: AdvertisementPlaybackStatus.ABANDONED },
      });
    });

    it('reads only the placements it decides, and never a video ad as a corner or the reverse', async () => {
      await session();
      const recentWhere = prisma.advertisementPlayback.findMany.mock.calls[0][0]
        .where as { placement: unknown };
      expect(recentWhere.placement).toEqual({
        in: ['PREROLL', 'MIDROLL', 'CORNER'],
      });
      const adWhere = prisma.advertisement.findMany.mock.calls[0][0].where as {
        AND: { OR?: unknown }[];
      };
      expect(adWhere.AND[3]).toEqual({
        OR: [
          {
            format: 'VIDEO',
            videoKey: { not: null },
            durationSeconds: { not: null },
            OR: [{ playsBeforeMovie: true }, { playsAtBreaks: true }],
          },
          { format: 'CORNER', imageKey: { not: null } },
        ],
      });
    });

    it('a break-only video ad is never the ad before the movie', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ playsBeforeMovie: false, playsAtBreaks: true }),
      ]);
      rules.midrollIntervalMinutes = 30;
      const result = await session();
      expect(result.preroll).toBeNull();
      expect(result.breaks).toEqual({
        intervalSeconds: 1800,
        doneThroughSeconds: 0,
        endGuardSeconds: 120,
        askAheadSeconds: 20,
      });
    });

    it('offers breaks only with an interval and a live break ad, and says which are done', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video()]);
      rules.midrollIntervalMinutes = 30;
      expect((await session()).breaks).toBeNull(); // no ad plays at breaks
      prisma.advertisement.findMany.mockResolvedValue([
        video({ playsAtBreaks: true }),
      ]);
      recentRows = [
        recent({
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          status: 'COMPLETED',
          startedAt: minutesAgo(120),
          createdAt: minutesAgo(121),
        }),
        recent({
          placement: 'MIDROLL',
          breakAtSeconds: 3600,
          status: 'FAILED',
          failedAt: minutesAgo(13 * 60),
          createdAt: minutesAgo(13 * 60),
        }),
      ];
      expect((await session()).breaks?.doneThroughSeconds).toBe(1800);
      rules.midrollIntervalMinutes = 0;
      expect((await session()).breaks).toBeNull();
    });

    it('keeps breaks and the corner from Premium members when the admin says so — the ad before the movie stays', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ playsAtBreaks: true }),
        corner(),
      ]);
      rules.midrollIntervalMinutes = 30;
      rules.duringMovieAudience = 'NON_PREMIUM';
      prisma.userSubscription.findFirst.mockResolvedValue({ id: 'sub' });
      const premium = await session();
      expect(premium.preroll?.advertisementId).toBe('ad-1');
      expect(premium.breaks).toBeNull();
      expect(premium.corner).toBeNull();
      expect(prisma.userSubscription.findFirst).toHaveBeenCalledWith({
        where: { userId: 'u1', expiresAt: { gt: NOW } },
        select: { id: true },
      });

      prisma.userSubscription.findFirst.mockResolvedValue(null);
      const free = await session({ userId: 'u2' });
      expect(free.breaks).not.toBeNull();
      expect(free.corner?.advertisementId).toBe('corner-1');
    });

    it('the ad before the movie plays on every open — an ad seen minutes ago does not stop it', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video(), corner()]);
      recentRows = [
        recent({
          status: 'COMPLETED',
          startedAt: minutesAgo(3),
          createdAt: minutesAgo(4),
        }),
        recent({
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          status: 'STARTED',
          startedAt: minutesAgo(1),
          createdAt: minutesAgo(1),
        }),
      ];
      const result = await session();
      expect(result.preroll?.advertisementId).toBe('ad-1');
      expect(result.corner?.advertisementId).toBe('corner-1');
      expect(createdPlacements()).toEqual(['PREROLL', 'CORNER']);
    });

    it('hands back an open decision while its ad is still live, and re-picks when it is not', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video()]);
      recentRows = [recent({ id: 'pb-open' })];
      expect((await session()).preroll?.playbackId).toBe('pb-open');
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();

      recentRows = [recent({ id: 'pb-open', advertisementId: 'ad-gone' })];
      expect((await session()).preroll?.playbackId).toBe('pb-new-1');
    });

    it('a closed corner stays closed for the viewing; an open one is handed back', async () => {
      prisma.advertisement.findMany.mockResolvedValue([corner()]);
      recentRows = [
        recent({
          id: 'pb-c',
          advertisementId: 'corner-1',
          placement: 'CORNER',
          status: 'SKIPPED',
          startedAt: minutesAgo(1),
        }),
      ];
      expect((await session()).corner).toBeNull();
      recentRows = [
        recent({
          id: 'pb-c',
          advertisementId: 'corner-1',
          placement: 'CORNER',
          status: 'STARTED',
          startedAt: minutesAgo(1),
        }),
      ];
      expect((await session()).corner?.playbackId).toBe('pb-c');
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
    });

    it('inside the lock, never hands back a sibling whose ad left the slot (pre-roll → breaks only)', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ id: 'x', playsBeforeMovie: false, playsAtBreaks: true }),
        video({ id: 'y' }),
      ]);
      rules.midrollIntervalMinutes = 30;
      siblingRows = [
        {
          id: 'pb-x',
          advertisementId: 'x',
          placement: 'PREROLL',
          status: 'PENDING',
        },
      ];
      const result = await session();
      expect(result.preroll?.advertisementId).toBe('y');
      expect(result.preroll?.playbackId).toBe('pb-new-1');
    });

    it('inside the lock, hands back the rows another tab minted meanwhile', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video(), corner()]);
      siblingRows = [
        {
          id: 'pb-theirs',
          advertisementId: 'ad-1',
          placement: 'PREROLL',
          status: 'PENDING',
        },
        {
          id: 'pb-c',
          advertisementId: 'corner-1',
          placement: 'CORNER',
          status: 'STARTED',
        },
      ];
      const result = await session();
      expect(result.preroll?.playbackId).toBe('pb-theirs');
      expect(result.corner?.playbackId).toBe('pb-c');
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
      expect(prisma.advertisementPlayback.updateMany).not.toHaveBeenCalled();
    });

    it('"until closed" is always closable, and a picture that never returns has no repeat', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        corner({
          cornerShowSeconds: null,
          cornerRepeatMinutes: null,
          cornerClosable: false,
          linkUrl: null,
        }),
      ]);
      expect((await session()).corner).toMatchObject({
        showSeconds: null,
        repeatSeconds: null,
        closable: true,
        linkUrl: null,
      });
    });

    it('hides skipAfterSeconds for a non-skippable ad', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ isSkippable: false, skipAfterSeconds: null }),
      ]);
      expect((await session()).preroll).toMatchObject({
        isSkippable: false,
        skipAfterSeconds: null,
      });
    });

    it('drops an ad outside its daily window (the ad’s own offset)', async () => {
      // 10:00 UTC = 16:30 in Myanmar: a 08:00–12:00 window is closed.
      prisma.advertisement.findMany.mockResolvedValue([
        video({ dailyStartMinutes: 480, dailyEndMinutes: 720 }),
      ]);
      expect((await session()).preroll).toBeNull();
    });

    it('applies the daily cap and the gap from the viewer’s history, every placement counted', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ maxImpressionsPerUserPerDay: 1 }),
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { advertisementId: 'ad-1', lastStartedAt: minutesAgo(90), today: 1 },
      ]);
      expect((await session()).preroll).toBeNull();
      prisma.advertisement.findMany.mockResolvedValue([
        video({ frequencyLimitMinutes: 120 }),
      ]);
      expect((await session()).preroll).toBeNull();
    });

    it('prefers priority, then the ad seen least recently', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        video({ id: 'low', priority: 0 }),
        video({ id: 'high', priority: 5 }),
      ]);
      expect((await session()).preroll?.advertisementId).toBe('high');
      prisma.advertisement.findMany.mockResolvedValue([
        video({ id: 'seen' }),
        video({ id: 'fresh' }),
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { advertisementId: 'seen', lastStartedAt: minutesAgo(5), today: 1 },
      ]);
      expect((await session()).preroll?.advertisementId).toBe('fresh');
    });
  });

  describe('preroll (legacy route)', () => {
    it('answers the old shape and never asks for or mints a corner or a break', async () => {
      prisma.advertisement.findMany.mockResolvedValue([video(), corner()]);
      rules.midrollIntervalMinutes = 30;
      rules.duringMovieAudience = 'NON_PREMIUM';
      const result = await service.preroll(viewer());
      expect(Object.keys(result).sort()).toEqual(['ad', 'replayAfterMinutes']);
      // Always 0: an old app build keeps no memory and asks on every open.
      expect(result.replayAfterMinutes).toBe(0);
      expect(result.ad?.advertisementId).toBe('ad-1');
      expect(createdPlacements()).toEqual(['PREROLL']);
      expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
      const adWhere = prisma.advertisement.findMany.mock.calls[0][0].where as {
        AND: { OR?: unknown }[];
      };
      expect(adWhere.AND[3]).toEqual({
        OR: [
          {
            format: 'VIDEO',
            videoKey: { not: null },
            durationSeconds: { not: null },
            OR: [{ playsBeforeMovie: true }],
          },
        ],
      });
    });

    it('answers nothing when ads are switched off', async () => {
      rules.adsEnabled = false;
      await expect(service.preroll(viewer())).resolves.toEqual({
        ad: null,
        replayAfterMinutes: 0,
      });
      expect(prisma.movie.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('midroll', () => {
    beforeEach(() => {
      rules.midrollIntervalMinutes = 30;
      prisma.advertisement.findMany.mockResolvedValue([
        video({ playsBeforeMovie: false, playsAtBreaks: true }),
      ]);
    });

    it('answers nothing, with no query, when ads or breaks are off', async () => {
      rules.adsEnabled = false;
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
      rules.adsEnabled = true;
      rules.midrollIntervalMinutes = 0;
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
      expect(prisma.movie.findUnique).not.toHaveBeenCalled();
    });

    it('mints one break row at its movie position, abandoning other open breaks', async () => {
      const result = await midroll(1800);
      expect(result.ad?.advertisementId).toBe('ad-1');
      expect(prisma.advertisementPlayback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
        }),
        select: { id: true },
      });
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          movieId: 'm1',
          placement: 'MIDROLL',
          status: AdvertisementPlaybackStatus.PENDING,
        },
        data: { status: AdvertisementPlaybackStatus.ABANDONED },
      });
      const adWhere = prisma.advertisement.findMany.mock.calls[0][0].where as {
        AND: { OR?: unknown }[];
      };
      expect(adWhere.AND[3]).toEqual({
        OR: [
          {
            format: 'VIDEO',
            videoKey: { not: null },
            durationSeconds: { not: null },
            OR: [{ playsAtBreaks: true }],
          },
        ],
      });
    });

    it('never plays a break that is done (or before a done one) in the last 12 hours', async () => {
      recentRows = [
        recent({
          placement: 'MIDROLL',
          breakAtSeconds: 3600,
          status: 'SKIPPED',
          startedAt: minutesAgo(60),
        }),
      ];
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
      await expect(midroll(3600)).resolves.toEqual({ ad: null });
      expect((await midroll(5400)).ad).not.toBeNull();
    });

    it('a jump past an asked-about break moves that open decision to the new break', async () => {
      recentRows = [
        recent({
          id: 'pb-early',
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          createdAt: minutesAgo(1),
        }),
      ];
      prisma.advertisementPlayback.updateMany.mockResolvedValue({ count: 1 });
      const result = await midroll(5400);
      expect(result.ad?.playbackId).toBe('pb-early');
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenCalledWith({
        where: { id: 'pb-early', status: AdvertisementPlaybackStatus.PENDING },
        data: { breakAtSeconds: 5400 },
      });
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
      // No caps read: the moved decision already counts toward them.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('no ad when the decision to move was started by another tab meanwhile', async () => {
      recentRows = [
        recent({
          id: 'pb-early',
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          createdAt: minutesAgo(1),
        }),
      ];
      prisma.advertisementPlayback.updateMany.mockResolvedValue({ count: 0 });
      await expect(midroll(5400)).resolves.toEqual({ ad: null });
    });

    it('a stale request for an earlier break never spends the later one already asked about', async () => {
      recentRows = [
        recent({
          id: 'pb-later',
          placement: 'MIDROLL',
          breakAtSeconds: 5400,
          createdAt: minutesAgo(1),
        }),
      ];
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
      expect(prisma.advertisementPlayback.updateMany).not.toHaveBeenCalled();
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
    });

    it('hands back the open decision for the same break', async () => {
      recentRows = [
        recent({
          id: 'pb-break',
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
        }),
      ];
      expect((await midroll(1800)).ad?.playbackId).toBe('pb-break');
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
      expect(prisma.advertisementPlayback.updateMany).not.toHaveBeenCalled();
    });

    it('mints a new break when no earlier decision is open', async () => {
      recentRows = [
        recent({
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          status: 'ABANDONED',
        }),
      ];
      expect((await midroll(3600)).ad?.playbackId).toBe('pb-new-1');
    });

    it('answers nothing when another tab played this break while this one chose', async () => {
      prisma.advertisementPlayback.findFirst.mockImplementation(
        async ({ where }: { where: { status?: unknown } }) =>
          where.status ? null : { id: 'pb-done' },
      );
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
      expect(prisma.advertisementPlayback.create).not.toHaveBeenCalled();
    });

    it('keeps breaks from Premium members when the admin says so', async () => {
      rules.duringMovieAudience = 'NON_PREMIUM';
      prisma.userSubscription.findFirst.mockResolvedValue({ id: 'sub' });
      await expect(midroll(1800)).resolves.toEqual({ ad: null });
    });

    it('is 404 for a hidden title', async () => {
      prisma.movie.findUnique.mockResolvedValue(null);
      await expect(midroll(1800)).rejects.toThrow(NotFoundException);
    });
  });

  describe('recordEvent', () => {
    it('moves the row forward with a compare-and-set', async () => {
      prisma.advertisementPlayback.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.recordEvent('pb-1', 'u1', 'started', undefined, NOW),
      ).resolves.toEqual({
        playbackId: 'pb-1',
        status: AdvertisementPlaybackStatus.STARTED,
      });
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'pb-1',
          userId: 'u1',
          status: { in: [AdvertisementPlaybackStatus.PENDING] },
        },
        data: { status: AdvertisementPlaybackStatus.STARTED, startedAt: NOW },
      });
      await service.recordEvent('pb-1', 'u1', 'skipped', 7.6, NOW);
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'pb-1',
          userId: 'u1',
          status: { in: [AdvertisementPlaybackStatus.STARTED] },
        },
        data: {
          status: AdvertisementPlaybackStatus.SKIPPED,
          skippedAt: NOW,
          positionSeconds: 8,
        },
      });
    });

    it('a corner never completes; only a corner comes back or is tapped (capped)', async () => {
      prisma.advertisementPlayback.updateMany.mockResolvedValue({ count: 1 });
      await service.recordEvent('pb-1', 'u1', 'completed', undefined, NOW);
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ placement: { not: 'CORNER' } }),
        data: expect.anything(),
      });
      await expect(
        service.recordEvent('pb-1', 'u1', 'shown', undefined, NOW),
      ).resolves.toEqual({ playbackId: 'pb-1', status: 'STARTED' });
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'pb-1',
          userId: 'u1',
          placement: { equals: 'CORNER' },
          repeatCount: { lt: 1000 },
          status: { in: [AdvertisementPlaybackStatus.STARTED] },
        },
        data: { repeatCount: { increment: 1 } },
      });
      await service.recordEvent('pb-1', 'u1', 'clicked', undefined, NOW);
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          placement: { equals: 'CORNER' },
          clickCount: { lt: 1000 },
        }),
        data: { clickCount: { increment: 1 } },
      });
    });

    it('closes a PENDING row on completed/skipped whose started was lost, with a start time', async () => {
      prisma.advertisementPlayback.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      await expect(
        service.recordEvent('pb-1', 'u1', 'completed', 15, NOW),
      ).resolves.toEqual({
        playbackId: 'pb-1',
        status: AdvertisementPlaybackStatus.COMPLETED,
      });
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'pb-1',
          userId: 'u1',
          placement: { not: 'CORNER' },
          status: AdvertisementPlaybackStatus.PENDING,
        },
        data: {
          status: AdvertisementPlaybackStatus.COMPLETED,
          completedAt: NOW,
          startedAt: new Date(NOW.getTime() - 15_000),
        },
      });
    });

    it('a tap on a corner whose started was lost starts it', async () => {
      prisma.advertisementPlayback.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      await expect(
        service.recordEvent('pb-1', 'u1', 'clicked', undefined, NOW),
      ).resolves.toEqual({ playbackId: 'pb-1', status: 'STARTED' });
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          status: AdvertisementPlaybackStatus.PENDING,
        }),
        data: {
          clickCount: { increment: 1 },
          status: AdvertisementPlaybackStatus.STARTED,
          startedAt: NOW,
        },
      });
    });

    it('never repairs a started or failed event that found nothing to move', async () => {
      prisma.advertisementPlayback.updateMany.mockResolvedValue({ count: 0 });
      prisma.advertisementPlayback.findUnique.mockResolvedValue({
        userId: 'u1',
        status: AdvertisementPlaybackStatus.COMPLETED,
      });
      await service.recordEvent('pb-1', 'u1', 'started', undefined, NOW);
      await service.recordEvent('pb-1', 'u1', 'failed', undefined, NOW);
      expect(prisma.advertisementPlayback.updateMany).toHaveBeenCalledTimes(2);
    });

    it('answers the current status when the event is a repeat or out of order', async () => {
      prisma.advertisementPlayback.findUnique.mockResolvedValue({
        userId: 'u1',
        status: AdvertisementPlaybackStatus.SKIPPED,
      });
      await expect(
        service.recordEvent('pb-1', 'u1', 'completed', undefined, NOW),
      ).resolves.toEqual({
        playbackId: 'pb-1',
        status: AdvertisementPlaybackStatus.SKIPPED,
      });
    });

    it('is 404 for another viewer’s row or an unknown one', async () => {
      prisma.advertisementPlayback.findUnique.mockResolvedValue({
        userId: 'someone-else',
        status: 'PENDING',
      });
      const error = await service
        .recordEvent('pb-1', 'u1', 'started', undefined, NOW)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).code).toBe(
        ADS_ERRORS.PLAYBACK_NOT_FOUND,
      );
    });
  });
});
