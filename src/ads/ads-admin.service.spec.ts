import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { AdvertisementTargetType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS } from './ads-errors';
import {
  AdsAdminService,
  adLiveStateOf,
  minutesToTimeOfDay,
  timeOfDayToMinutes,
} from './ads-admin.service';

async function rejection(
  promise: Promise<unknown>,
): Promise<CodedHttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

const actor = { id: 'staff-1', username: 'staff', role: 'ADMIN' } as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ad-1',
  title: 'Big match',
  description: null,
  videoKey: 'ads/ad-1/v-aaaa/video.mp4',
  videoBytes: 1000,
  videoEtag: 'e',
  durationSeconds: 15,
  videoAttachedAt: new Date('2026-11-04T00:00:00Z'),
  isActive: true,
  startsAt: null,
  endsAt: null,
  dailyStartMinutes: null,
  dailyEndMinutes: null,
  tzOffsetMinutes: 390,
  targetType: AdvertisementTargetType.ALL,
  priority: 0,
  isSkippable: false,
  skipAfterSeconds: null,
  frequencyLimitMinutes: null,
  maxImpressionsPerUserPerDay: null,
  format: 'VIDEO',
  playsBeforeMovie: true,
  playsAtBreaks: false,
  imageKey: null,
  imageBytes: null,
  imageWidth: null,
  imageHeight: null,
  imageAttachedAt: null,
  linkUrl: null,
  cornerShowSeconds: null,
  cornerRepeatMinutes: null,
  cornerClosable: true,
  createdById: 'staff-1',
  createdAt: new Date('2026-11-04T00:00:00Z'),
  updatedAt: new Date('2026-11-04T00:00:00Z'),
  createdBy: { id: 'staff-1', username: 'staff', displayName: null },
  movies: [] as { movieId: string }[],
  ...over,
});

describe('adLiveStateOf', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('reads NO_VIDEO first, then OFF, ENDED, SCHEDULED, LIVE', () => {
    expect(adLiveStateOf(row({ videoKey: null, isActive: false }), now)).toBe(
      'NO_VIDEO',
    );
    expect(adLiveStateOf(row({ isActive: false }), now)).toBe('OFF');
    expect(
      adLiveStateOf(row({ endsAt: new Date('2026-11-04T11:00:00Z') }), now),
    ).toBe('ENDED');
    expect(
      adLiveStateOf(row({ startsAt: new Date('2026-11-05T00:00:00Z') }), now),
    ).toBe('SCHEDULED');
    expect(adLiveStateOf(row(), now)).toBe('LIVE');
  });
});

describe('time of day helpers', () => {
  it('round-trips HH:mm', () => {
    expect(timeOfDayToMinutes('22:05')).toBe(22 * 60 + 5);
    expect(minutesToTimeOfDay(22 * 60 + 5)).toBe('22:05');
    expect(minutesToTimeOfDay(0)).toBe('00:00');
  });
});

describe('AdsAdminService', () => {
  let service: AdsAdminService;
  let prisma: {
    advertisement: Record<
      'findMany' | 'findUnique' | 'count' | 'create' | 'update' | 'delete',
      jest.Mock
    >;
    advertisementPlayback: { groupBy: jest.Mock };
    movie: { findMany: jest.Mock };
    series: { findMany: jest.Mock };
    book: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let minio: {
    signedPlaybackUrl: jest.Mock;
    playbackUrl: jest.Mock;
    imageUrl: jest.Mock;
    deleteByPrefix: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      advertisement: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      advertisementPlayback: { groupBy: jest.fn().mockResolvedValue([]) },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      series: { findMany: jest.fn().mockResolvedValue([]) },
      book: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    minio = {
      signedPlaybackUrl: jest.fn(
        (key: string) => `https://cache/s/x/y/movies/${key}`,
      ),
      playbackUrl: jest.fn((key: string) => `https://cache/movies/${key}`),
      imageUrl: jest.fn((url: string | null) => url),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdsAdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
        {
          provide: StorageService,
          useValue: {
            adPrefix: (id: string) => `ads/${id}`,
            adStagingPrefix: (id: string) => `temp/ads/${id}`,
            adImagePrefix: (id: string) => `images/ad/${id}`,
          },
        },
      ],
    }).compile();
    service = module.get(AdsAdminService);
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.advertisement.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          row({
            ...data,
            id: 'ad-new',
            videoKey: null,
            durationSeconds: null,
            movies: [],
          }),
      );
    });

    it('starts OFF with no video and writes an audit row', async () => {
      const view = await service.create(
        { title: '  Big match ' } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Big match',
            isActive: false,
            tzOffsetMinutes: 390,
          }),
        }),
      );
      expect(view.liveState).toBe('NO_VIDEO');
      expect(view.videoUrl).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'advertisement.create' }),
      );
    });

    it('refuses to switch on an ad that has no video', async () => {
      const error = await rejection(
        service.create({ title: 'x', isActive: true } as never, actor),
      );
      expect(error.code).toBe(ADS_ERRORS.VIDEO_REQUIRED);
    });

    it('a new video ad plays before the movie unless told otherwise, and needs a slot', async () => {
      await service.create({ title: 'x' } as never, actor);
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            format: 'VIDEO',
            playsBeforeMovie: true,
            playsAtBreaks: false,
            linkUrl: null,
            cornerShowSeconds: null,
          }),
        }),
      );
      await service.create(
        { title: 'x', playsBeforeMovie: false, playsAtBreaks: true } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            playsBeforeMovie: false,
            playsAtBreaks: true,
          }),
        }),
      );
      const error = await rejection(
        service.create(
          {
            title: 'x',
            playsBeforeMovie: false,
            playsAtBreaks: false,
          } as never,
          actor,
        ),
      );
      expect(error.code).toBe(ADS_ERRORS.SLOTS_REQUIRED);
    });

    it('a new corner picture shows 10 s by default, has no slot, and refuses video fields', async () => {
      await service.create(
        {
          title: 'Corner',
          format: 'CORNER',
          linkUrl: 'https://shop.example.com/x?y=1',
        } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            format: 'CORNER',
            playsBeforeMovie: false,
            playsAtBreaks: false,
            isSkippable: false,
            cornerShowSeconds: 10,
            cornerRepeatMinutes: null,
            cornerClosable: true,
            linkUrl: 'https://shop.example.com/x?y=1',
          }),
        }),
      );
      const mismatch = await rejection(
        service.create(
          {
            title: 'Corner',
            format: 'CORNER',
            isSkippable: true,
            skipAfterSeconds: 5,
          } as never,
          actor,
        ),
      );
      expect(mismatch.code).toBe(ADS_ERRORS.FORMAT_MISMATCH);
      const videoWithLink = await rejection(
        service.create(
          { title: 'x', linkUrl: 'https://a.example.com' } as never,
          actor,
        ),
      );
      expect(videoWithLink.code).toBe(ADS_ERRORS.FORMAT_MISMATCH);
    });

    it('checks a corner picture’s link and timing, and needs its picture to switch on', async () => {
      const corner = (extra: Record<string, unknown>) =>
        service.create(
          { title: 'Corner', format: 'CORNER', ...extra } as never,
          actor,
        );
      for (const bad of [
        'javascript:alert(1)',
        'ftp://x.example.com',
        'www.example.com',
        'https://',
        'https://user@evil.example.com/x',
        'https://shop example.com',
      ]) {
        expect((await rejection(corner({ linkUrl: bad }))).code).toBe(
          ADS_ERRORS.LINK_INVALID,
        );
      }
      // A LAN address, a one-word host and a port are all real links.
      for (const good of [
        'http://192.168.1.20:3003/premium',
        'http://intranet:8080',
        'https://shop.example.com/x?y=1#z',
      ]) {
        await corner({ linkUrl: good });
        expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ linkUrl: good }),
          }),
        );
      }
      expect(
        (
          await rejection(
            corner({ cornerShowSeconds: null, cornerRepeatMinutes: 5 }),
          )
        ).code,
      ).toBe(ADS_ERRORS.CORNER_TIMING_INVALID);
      expect(
        (
          await rejection(
            corner({ cornerShowSeconds: 120, cornerRepeatMinutes: 2 }),
          )
        ).code,
      ).toBe(ADS_ERRORS.CORNER_TIMING_INVALID);
      expect((await rejection(corner({ isActive: true }))).code).toBe(
        ADS_ERRORS.IMAGE_REQUIRED,
      );
      // "Until closed" always keeps the ✕, whatever the form sent.
      await corner({ cornerShowSeconds: null, cornerClosable: false });
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cornerShowSeconds: null,
            cornerClosable: true,
          }),
        }),
      );
    });

    it('needs the end after the start', async () => {
      const error = await rejection(
        service.create(
          {
            title: 'x',
            startsAt: '2026-11-05T00:00:00Z',
            endsAt: '2026-11-04T00:00:00Z',
          } as never,
          actor,
        ),
      );
      expect(error.code).toBe(ADS_ERRORS.WINDOW_INVALID);
    });

    it('needs both daily hours or neither, and not the same hour', async () => {
      expect(
        (
          await rejection(
            service.create(
              { title: 'x', dailyStartTime: '22:00' } as never,
              actor,
            ),
          )
        ).code,
      ).toBe(ADS_ERRORS.DAILY_WINDOW_INVALID);
      expect(
        (
          await rejection(
            service.create(
              {
                title: 'x',
                dailyStartTime: '22:00',
                dailyEndTime: '22:00',
              } as never,
              actor,
            ),
          )
        ).code,
      ).toBe(ADS_ERRORS.DAILY_WINDOW_INVALID);
    });

    it('stores the daily window as minutes, an overnight one included', async () => {
      await service.create(
        { title: 'x', dailyStartTime: '22:00', dailyEndTime: '02:30' } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dailyStartMinutes: 1320,
            dailyEndMinutes: 150,
          }),
        }),
      );
    });

    it('needs at least one existing movie for SELECTED, and none for ALL', async () => {
      expect(
        (
          await rejection(
            service.create(
              { title: 'x', targetType: 'SELECTED' } as never,
              actor,
            ),
          )
        ).code,
      ).toBe(ADS_ERRORS.TARGET_MOVIES_REQUIRED);
      prisma.movie.findMany.mockResolvedValue([{ id: 'm1' }]);
      const error = await rejection(
        service.create(
          {
            title: 'x',
            targetType: 'SELECTED',
            movieIds: ['m1', 'm2'],
          } as never,
          actor,
        ),
      );
      expect(error.code).toBe(ADS_ERRORS.TARGET_MOVIE_NOT_FOUND);
      await service.create(
        { title: 'x', targetType: 'ALL', movieIds: ['m1'] } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ movies: { create: [] } }),
        }),
      );
    });

    it('needs a skip-after second when skippable, and drops it when not', async () => {
      expect(
        (
          await rejection(
            service.create({ title: 'x', isSkippable: true } as never, actor),
          )
        ).code,
      ).toBe(ADS_ERRORS.SKIP_AFTER_REQUIRED);
      await service.create(
        { title: 'x', isSkippable: false, skipAfterSeconds: 5 } as never,
        actor,
      );
      expect(prisma.advertisement.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isSkippable: false,
            skipAfterSeconds: null,
          }),
        }),
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.advertisement.findUnique.mockResolvedValue(
        row({
          movies: [{ movieId: 'm1' }],
          targetType: AdvertisementTargetType.SELECTED,
        }),
      );
      prisma.advertisement.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) =>
          row({ ...data, movies: [] }),
      );
      prisma.movie.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    });

    it('keeps absent fields, replaces the movie list whole, and counts the change', async () => {
      await service.update('ad-1', { movieIds: ['m2'] } as never, actor);
      expect(prisma.advertisement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Big match',
            movies: { deleteMany: {}, create: [{ movieId: 'm2' }] },
          }),
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'advertisement.update',
          metadata: { movieIdsAdded: 1, movieIdsRemoved: 1 },
        }),
      );
    });

    it('checks skip-after against the attached duration', async () => {
      const error = await rejection(
        service.update(
          'ad-1',
          { isSkippable: true, skipAfterSeconds: 15 } as never,
          actor,
        ),
      );
      expect(error.code).toBe(ADS_ERRORS.SKIP_AFTER_TOO_LONG);
    });

    it('answers 404 for an unknown ad', async () => {
      prisma.advertisement.findUnique.mockResolvedValue(null);
      expect(
        (await rejection(service.update('nope', {} as never, actor))).code,
      ).toBe(ADS_ERRORS.NOT_FOUND);
    });
  });

  describe('remove', () => {
    it('deletes the row, audits, then every storage prefix of the ad', async () => {
      prisma.advertisement.findUnique.mockResolvedValue(row());
      await service.remove('ad-1', actor);
      expect(prisma.advertisement.delete).toHaveBeenCalledWith({
        where: { id: 'ad-1' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'advertisement.delete' }),
      );
      expect(minio.deleteByPrefix).toHaveBeenCalledWith('ads/ad-1/');
      expect(minio.deleteByPrefix).toHaveBeenCalledWith('temp/ads/ad-1/');
      expect(minio.deleteByPrefix).toHaveBeenCalledWith('images/ad/ad-1/');
    });
  });

  describe('list and views', () => {
    it('signs the video per request, shows selected titles and all-time counters', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        row({ movies: [{ movieId: 'm1' }, { movieId: 'gone' }] }),
      ]);
      prisma.advertisement.count.mockResolvedValue(1);
      prisma.movie.findMany.mockImplementation(
        async ({ select }: { select: Record<string, boolean> }) =>
          select.title
            ? [
                {
                  id: 'm1',
                  title: 'Movie one',
                  description: '',
                  posterUrl: 'p.jpg',
                  coverUrl: null,
                  thumbnailUrl: null,
                  genre: null,
                  releaseYear: null,
                  duration: null,
                  rating: 0,
                  accessType: 'FREE',
                  ageRating: null,
                },
              ]
            : [{ id: 'm1' }],
      );
      prisma.advertisementPlayback.groupBy.mockResolvedValue([
        { advertisementId: 'ad-1', status: 'COMPLETED', _count: { _all: 3 } },
        { advertisementId: 'ad-1', status: 'SKIPPED', _count: { _all: 1 } },
        { advertisementId: 'ad-1', status: 'STARTED', _count: { _all: 2 } },
      ]);
      const page = await service.list({ page: 1, limit: 25 } as never);
      expect(page.total).toBe(1);
      const [view] = page.items;
      expect(view.videoUrl).toBe(
        'https://cache/s/x/y/movies/ads/ad-1/v-aaaa/video.mp4',
      );
      expect(view.targetMovies).toEqual([
        {
          id: 'm1',
          title: 'Movie one',
          imageUrl: 'p.jpg',
          isVisible: true,
          missing: false,
        },
        {
          id: 'gone',
          title: null,
          imageUrl: null,
          isVisible: false,
          missing: true,
        },
      ]);
      expect(view.counters).toEqual({
        impressions: 6,
        completions: 3,
        skips: 1,
        shows: 0,
        clicks: 0,
        closes: 0,
      });
    });

    it('counts a corner picture’s showings, taps and closes apart from video skips', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        row({
          format: 'CORNER',
          videoKey: null,
          imageKey: 'images/ad/ad-1/t.gif',
        }),
      ]);
      prisma.advertisement.count.mockResolvedValue(1);
      prisma.advertisementPlayback.groupBy.mockResolvedValue([
        {
          advertisementId: 'ad-1',
          status: 'STARTED',
          placement: 'CORNER',
          _count: { _all: 4 },
          _sum: { repeatCount: 6, clickCount: 2 },
        },
        {
          advertisementId: 'ad-1',
          status: 'SKIPPED',
          placement: 'CORNER',
          _count: { _all: 1 },
          _sum: { repeatCount: 0, clickCount: 1 },
        },
      ]);
      const [view] = (await service.list({} as never)).items;
      expect(view.counters).toEqual({
        impressions: 5,
        completions: 0,
        skips: 0,
        shows: 11,
        clicks: 3,
        closes: 1,
      });
      expect(view.liveState).toBe('LIVE');
    });

    it('filters by live state and type', async () => {
      await service.list({ status: 'NO_VIDEO' } as never);
      expect(prisma.advertisement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              {
                OR: [
                  { format: 'VIDEO', videoKey: null },
                  { format: 'CORNER', imageKey: null },
                ],
              },
            ],
          }),
        }),
      );
      await service.list({
        status: 'LIVE',
        search: 'match',
        format: 'CORNER',
      } as never);
      expect(prisma.advertisement.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            format: 'CORNER',
            title: { contains: 'match', mode: 'insensitive' },
            AND: [
              expect.objectContaining({
                AND: expect.arrayContaining([{ isActive: true }]),
              }),
            ],
          }),
        }),
      );
    });
  });
});
