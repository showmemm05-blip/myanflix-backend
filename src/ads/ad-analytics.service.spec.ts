import { Test, TestingModule } from '@nestjs/testing';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS } from './ads-errors';
import { AdAnalyticsService } from './ad-analytics.service';

const NOW = new Date('2026-11-04T10:00:00Z'); // 16:30 MMT on 4 Nov

describe('AdAnalyticsService', () => {
  let service: AdAnalyticsService;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdAnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AdAnalyticsService);
  });

  describe('resolvePeriod', () => {
    it('defaults to the last 7 full MMT days', () => {
      const period = service.resolvePeriod({}, NOW);
      expect(period).toMatchObject({
        from: '2026-10-28',
        to: '2026-11-03',
        days: 7,
      });
      expect(period.previous).toMatchObject({
        from: '2026-10-21',
        to: '2026-10-27',
      });
    });

    it('refuses a half range, a non-date, a reversed range and a span over 366 days', () => {
      const code = (fn: () => unknown) => {
        try {
          fn();
        } catch (error) {
          return (error as CodedHttpException).code;
        }
        return null;
      };
      expect(
        code(() => service.resolvePeriod({ from: '2026-11-01' }, NOW)),
      ).toBe(ADS_ERRORS.ANALYTICS_RANGE_INVALID);
      expect(
        code(() =>
          service.resolvePeriod({ from: 'nope', to: '2026-11-01' }, NOW),
        ),
      ).toBe(ADS_ERRORS.ANALYTICS_RANGE_INVALID);
      expect(
        code(() =>
          service.resolvePeriod({ from: '2026-11-02', to: '2026-11-01' }, NOW),
        ),
      ).toBe(ADS_ERRORS.ANALYTICS_RANGE_INVALID);
      expect(
        code(() =>
          service.resolvePeriod({ from: '2025-01-01', to: '2026-11-01' }, NOW),
        ),
      ).toBe(ADS_ERRORS.ANALYTICS_RANGE_TOO_LONG);
    });
  });

  it('overview: video rates on video impressions, corner rates on corner impressions, zero when nothing played', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          impressions: 14,
          videoImpressions: 10,
          cornerImpressions: 4,
          completions: 6,
          skips: 3,
          closes: 1,
          repeats: 5,
          clicks: 2,
          failures: 1,
          viewers: 4,
          web: 7,
          mobile: 7,
          preroll: 8,
          midroll: 2,
        },
      ])
      // The load-failure count runs beside it (failed before a first frame).
      .mockResolvedValueOnce([{ loadFailures: 2 }])
      .mockResolvedValueOnce([]);
    const overview = await service.overview(
      { from: '2026-11-01', to: '2026-11-03' },
      NOW,
    );
    expect(overview.range).toEqual({
      from: '2026-11-01',
      to: '2026-11-03',
      previousFrom: '2026-10-29',
      previousTo: '2026-10-31',
    });
    expect(overview.current).toEqual({
      impressions: 14,
      videoImpressions: 10,
      completions: 6,
      skips: 3,
      failures: 1,
      loadFailures: 2,
      viewers: 4,
      completionRate: 0.6,
      skipRate: 0.3,
      closes: 1,
      shows: 9,
      clicks: 2,
      tapRate: 0.5,
      closeRate: 0.25,
      byPlatform: { web: 7, mobile: 7 },
      byPlacement: { preroll: 8, midroll: 2, corner: 4 },
    });
    expect(overview.previous.impressions).toBe(0);
    expect(overview.previous.completionRate).toBe(0);
  });

  it('byDate: one bucket per MMT day, zero-filled', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        key: '2026-11-02',
        impressions: 4,
        completions: 2,
        skips: 1,
        clicks: 3,
        closes: 1,
      },
    ]);
    const { buckets } = await service.byDate(
      { from: '2026-11-01', to: '2026-11-03' },
      NOW,
    );
    const zero = {
      impressions: 0,
      completions: 0,
      skips: 0,
      clicks: 0,
      closes: 0,
    };
    expect(buckets).toEqual([
      { key: '2026-11-01', ...zero },
      {
        key: '2026-11-02',
        impressions: 4,
        completions: 2,
        skips: 1,
        clicks: 3,
        closes: 1,
      },
      { key: '2026-11-03', ...zero },
    ]);
  });

  it('narrows every query to one placement when asked', async () => {
    await service.byDate(
      { from: '2026-11-01', to: '2026-11-03', placement: 'MIDROLL' },
      NOW,
    );
    const sql = prisma.$queryRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(sql.strings.join('?')).toContain(
      '"placement" = ?::"AdvertisementPlacement"',
    );
    expect(sql.values).toContain('MIDROLL');
  });

  it('ads: every ad with its live state and completion rate', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'a',
        title: 'A',
        format: 'VIDEO',
        isActive: true,
        startsAt: null,
        endsAt: null,
        videoKey: 'k',
        imageKey: null,
        impressions: 4,
        videoImpressions: 4,
        completions: 1,
        skips: 2,
        shows: 0,
        clicks: 0,
        closes: 0,
      },
      {
        id: 'b',
        title: 'B',
        format: 'CORNER',
        isActive: true,
        startsAt: null,
        endsAt: null,
        videoKey: null,
        imageKey: null,
        impressions: 0,
        videoImpressions: 0,
        completions: 0,
        skips: 0,
        shows: 0,
        clicks: 0,
        closes: 0,
      },
    ]);
    const { items } = await service.ads(
      { from: '2026-11-01', to: '2026-11-03' },
      NOW,
    );
    expect(items).toEqual([
      {
        id: 'a',
        title: 'A',
        format: 'VIDEO',
        liveState: 'LIVE',
        impressions: 4,
        completions: 1,
        skips: 2,
        completionRate: 0.25,
        shows: 0,
        clicks: 0,
        closes: 0,
      },
      {
        id: 'b',
        title: 'B',
        format: 'CORNER',
        liveState: 'NO_VIDEO',
        impressions: 0,
        completions: 0,
        skips: 0,
        completionRate: 0,
        shows: 0,
        clicks: 0,
        closes: 0,
      },
    ]);
  });
});
