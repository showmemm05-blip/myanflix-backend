import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AdvertisementFormat,
  AdvertisementPlacement,
  Prisma,
} from '../generated/prisma/client';
import { YANGON_UTC_OFFSET_MINUTES } from '../bank-events/risk-rules';
import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  ANALYTICS_MAX_RANGE_DAYS,
  bucketKeys,
  daysBetween,
  lastFullDays,
  periodOf,
  share,
  type AnalyticsPeriod,
  type AnalyticsWindow,
} from '../lottery/analytics/lottery-analytics-period';
import { isCalendarDate } from '../lottery/lottery-time';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS, adError } from './ads-errors';
import { adLiveStateOf } from './ads-admin.service';
import type { AdLiveState } from './dto/advertisement.dto';
import type { AdAnalyticsQueryDto } from './dto/ad-analytics.dto';

// ---------------------------------------------------------------------------
// Response shapes (what the admin's ad-analytics types mirror)
// ---------------------------------------------------------------------------

export interface AdAnalyticsRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export interface AdPeriodFigures {
  /** Started plays, every placement (a corner picture's first showing included). */
  impressions: number;
  /** Started video plays (before the movie + at breaks) — the rates' base. */
  videoImpressions: number;
  completions: number;
  /** Video ads skipped (a corner picture's ✕ is a close). */
  skips: number;
  /** Plays that stopped with an error AFTER their first frame. */
  failures: number;
  /**
   * Ads that never showed because the video or picture would not load (a
   * failure before the first frame — not an impression), counted on the
   * moment it failed.
   */
  loadFailures: number;
  /** Distinct viewers with an impression. */
  viewers: number;
  /** 0..1 of video impressions. */
  completionRate: number;
  skipRate: number;
  /** Corner pictures: closed with ✕, showings (first + comebacks), taps. */
  closes: number;
  shows: number;
  clicks: number;
  /** 0..1 of corner impressions. */
  tapRate: number;
  closeRate: number;
  byPlatform: { web: number; mobile: number };
  /** Impressions per placement. */
  byPlacement: { preroll: number; midroll: number; corner: number };
}

export interface AdAnalyticsOverview {
  range: AdAnalyticsRange;
  current: AdPeriodFigures;
  previous: AdPeriodFigures;
}

export interface AdAnalyticsAdRow {
  id: string;
  title: string;
  format: AdvertisementFormat;
  liveState: AdLiveState;
  impressions: number;
  completions: number;
  skips: number;
  completionRate: number;
  shows: number;
  clicks: number;
  closes: number;
}

export interface AdAnalyticsBucket {
  /** MMT calendar day, YYYY-MM-DD. */
  key: string;
  impressions: number;
  completions: number;
  skips: number;
  clicks: number;
  closes: number;
}

// ---------------------------------------------------------------------------
// SQL pieces
// ---------------------------------------------------------------------------

/** A timestamp column shifted into Myanmar time, so a day is an MMT day. */
const mmt = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`(${column} + make_interval(mins => ${YANGON_UTC_OFFSET_MINUTES}::int))`;

const COMPLETED = Prisma.sql`'COMPLETED'::"AdvertisementPlaybackStatus"`;
const SKIPPED = Prisma.sql`'SKIPPED'::"AdvertisementPlaybackStatus"`;
const FAILED = Prisma.sql`'FAILED'::"AdvertisementPlaybackStatus"`;
const WEB = Prisma.sql`'WEB'::"ClientPlatform"`;
const MOBILE = Prisma.sql`'MOBILE'::"ClientPlatform"`;
const PREROLL = Prisma.sql`'PREROLL'::"AdvertisementPlacement"`;
const MIDROLL = Prisma.sql`'MIDROLL'::"AdvertisementPlacement"`;
const CORNER = Prisma.sql`'CORNER'::"AdvertisementPlacement"`;

/** Every figure keys on the impression instant, so a play never splits across days. */
const inWindow = (window: AnalyticsWindow): Prisma.Sql =>
  Prisma.sql`p."startedAt" >= ${window.start} AND p."startedAt" < ${window.end}`;

const adFilter = (adId: string | undefined): Prisma.Sql =>
  adId === undefined
    ? Prisma.empty
    : Prisma.sql`AND p."advertisementId" = ${adId}`;

const placementFilter = (
  placement: AdvertisementPlacement | undefined,
): Prisma.Sql =>
  placement === undefined
    ? Prisma.empty
    : Prisma.sql`AND p."placement" = ${placement}::"AdvertisementPlacement"`;

interface CountsRow {
  impressions: number;
  videoImpressions: number;
  cornerImpressions: number;
  completions: number;
  skips: number;
  closes: number;
  repeats: number;
  clicks: number;
  failures: number;
  viewers: number;
  web: number;
  mobile: number;
  preroll: number;
  midroll: number;
}

/**
 * The admin "Advertisements > Analytics" page: how often each ad played,
 * finished and was skipped — and the corner pictures' showings, taps and
 * closes — in Myanmar time, optionally for one placement. Counts come from
 * advertisement_playbacks and nothing else; an ad deleted since takes its
 * rows with it (the FK cascades), which is the owner's call.
 */
@Injectable()
export class AdAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    query: AdAnalyticsQueryDto,
    now = new Date(),
  ): Promise<AdAnalyticsOverview> {
    const period = this.resolvePeriod(query, now);
    const [current, previous] = await Promise.all([
      this.figures(period, query.adId, query.placement),
      this.figures(period.previous, query.adId, query.placement),
    ]);
    return {
      range: {
        from: period.from,
        to: period.to,
        previousFrom: period.previous.from,
        previousTo: period.previous.to,
      },
      current,
      previous,
    };
  }

  /** Every ad, zero rows included, impressions first. */
  async ads(
    query: AdAnalyticsQueryDto,
    now = new Date(),
  ): Promise<{ items: AdAnalyticsAdRow[] }> {
    const period = this.resolvePeriod(query, now);
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        format: AdvertisementFormat;
        isActive: boolean;
        startsAt: Date | null;
        endsAt: Date | null;
        videoKey: string | null;
        imageKey: string | null;
        impressions: number;
        videoImpressions: number;
        completions: number;
        skips: number;
        shows: number;
        clicks: number;
        closes: number;
      }[]
    >(Prisma.sql`/* ad-analytics:per-ad */
      SELECT a."id", a."title", a."format", a."isActive", a."startsAt", a."endsAt",
             a."videoKey", a."imageKey",
             COALESCE(s."impressions", 0)::int AS "impressions",
             COALESCE(s."videoImpressions", 0)::int AS "videoImpressions",
             COALESCE(s."completions", 0)::int AS "completions",
             COALESCE(s."skips", 0)::int AS "skips",
             COALESCE(s."shows", 0)::int AS "shows",
             COALESCE(s."clicks", 0)::int AS "clicks",
             COALESCE(s."closes", 0)::int AS "closes"
      FROM "advertisements" a
      LEFT JOIN (
        SELECT p."advertisementId",
               COUNT(*)::int AS "impressions",
               (COUNT(*) FILTER (WHERE p."placement" <> ${CORNER}))::int AS "videoImpressions",
               (COUNT(*) FILTER (WHERE p."status" = ${COMPLETED}))::int AS "completions",
               (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" <> ${CORNER}))::int AS "skips",
               ((COUNT(*) FILTER (WHERE p."placement" = ${CORNER})) + COALESCE(SUM(p."repeatCount"), 0))::int AS "shows",
               COALESCE(SUM(p."clickCount"), 0)::int AS "clicks",
               (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" = ${CORNER}))::int AS "closes"
        FROM "advertisement_playbacks" p
        WHERE ${inWindow(period)} ${placementFilter(query.placement)}
        GROUP BY p."advertisementId"
      ) s ON s."advertisementId" = a."id"
      ORDER BY "impressions" DESC, a."createdAt" ASC`);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        format: row.format,
        liveState: adLiveStateOf(row, now),
        impressions: Number(row.impressions),
        completions: Number(row.completions),
        skips: Number(row.skips),
        completionRate: share(
          Number(row.completions),
          Number(row.videoImpressions),
        ),
        shows: Number(row.shows),
        clicks: Number(row.clicks),
        closes: Number(row.closes),
      })),
    };
  }

  /** One bucket per MMT calendar day of the period, zero-filled. */
  async byDate(
    query: AdAnalyticsQueryDto,
    now = new Date(),
  ): Promise<{ buckets: AdAnalyticsBucket[] }> {
    const period = this.resolvePeriod(query, now);
    const rows = await this.prisma.$queryRaw<
      {
        key: string;
        impressions: number;
        completions: number;
        skips: number;
        clicks: number;
        closes: number;
      }[]
    >(Prisma.sql`/* ad-analytics:by-date */
      SELECT to_char(${mmt(Prisma.sql`p."startedAt"`)}, 'YYYY-MM-DD') AS "key",
             COUNT(*)::int AS "impressions",
             (COUNT(*) FILTER (WHERE p."status" = ${COMPLETED}))::int AS "completions",
             (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" <> ${CORNER}))::int AS "skips",
             COALESCE(SUM(p."clickCount"), 0)::int AS "clicks",
             (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" = ${CORNER}))::int AS "closes"
      FROM "advertisement_playbacks" p
      WHERE ${inWindow(period)} ${adFilter(query.adId)} ${placementFilter(query.placement)}
      GROUP BY 1`);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      buckets: bucketKeys('daily', period).map((key) => {
        const row = byKey.get(key);
        return {
          key,
          impressions: Number(row?.impressions ?? 0),
          completions: Number(row?.completions ?? 0),
          skips: Number(row?.skips ?? 0),
          clicks: Number(row?.clicks ?? 0),
          closes: Number(row?.closes ?? 0),
        };
      }),
    };
  }

  private async figures(
    window: AnalyticsWindow,
    adId: string | undefined,
    placement: AdvertisementPlacement | undefined,
  ): Promise<AdPeriodFigures> {
    const [[row], [lost]] = await Promise.all([
      this.prisma.$queryRaw<CountsRow[]>(Prisma.sql`/* ad-analytics:counts */
      SELECT COUNT(*)::int AS "impressions",
             (COUNT(*) FILTER (WHERE p."placement" <> ${CORNER}))::int AS "videoImpressions",
             (COUNT(*) FILTER (WHERE p."placement" = ${CORNER}))::int AS "cornerImpressions",
             (COUNT(*) FILTER (WHERE p."status" = ${COMPLETED}))::int AS "completions",
             (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" <> ${CORNER}))::int AS "skips",
             (COUNT(*) FILTER (WHERE p."status" = ${SKIPPED} AND p."placement" = ${CORNER}))::int AS "closes",
             COALESCE(SUM(p."repeatCount"), 0)::int AS "repeats",
             COALESCE(SUM(p."clickCount"), 0)::int AS "clicks",
             (COUNT(*) FILTER (WHERE p."status" = ${FAILED}))::int AS "failures",
             COUNT(DISTINCT p."userId")::int AS "viewers",
             (COUNT(*) FILTER (WHERE p."platform" = ${WEB}))::int AS "web",
             (COUNT(*) FILTER (WHERE p."platform" = ${MOBILE}))::int AS "mobile",
             (COUNT(*) FILTER (WHERE p."placement" = ${PREROLL}))::int AS "preroll",
             (COUNT(*) FILTER (WHERE p."placement" = ${MIDROLL}))::int AS "midroll"
      FROM "advertisement_playbacks" p
      WHERE ${inWindow(window)} ${adFilter(adId)} ${placementFilter(placement)}`),
      this.prisma.$queryRaw<
        { loadFailures: number }[]
      >(Prisma.sql`/* ad-analytics:load-failures */
      SELECT COUNT(*)::int AS "loadFailures"
      FROM "advertisement_playbacks" p
      WHERE p."startedAt" IS NULL AND p."status" = ${FAILED}
        AND p."failedAt" >= ${window.start} AND p."failedAt" < ${window.end}
        ${adFilter(adId)} ${placementFilter(placement)}`),
    ]);
    const n = (value: number | undefined) => Number(value ?? 0);
    const videoImpressions = n(row?.videoImpressions);
    const cornerImpressions = n(row?.cornerImpressions);
    const completions = n(row?.completions);
    const skips = n(row?.skips);
    const closes = n(row?.closes);
    const clicks = n(row?.clicks);
    return {
      impressions: n(row?.impressions),
      videoImpressions,
      completions,
      skips,
      failures: n(row?.failures),
      loadFailures: n(lost?.loadFailures),
      viewers: n(row?.viewers),
      completionRate: share(completions, videoImpressions),
      skipRate: share(skips, videoImpressions),
      closes,
      shows: cornerImpressions + n(row?.repeats),
      clicks,
      tapRate: share(clicks, cornerImpressions),
      closeRate: share(closes, cornerImpressions),
      byPlatform: { web: n(row?.web), mobile: n(row?.mobile) },
      byPlacement: {
        preroll: n(row?.preroll),
        midroll: n(row?.midroll),
        corner: cornerImpressions,
      },
    };
  }

  /**
   * The period a request asks for: both dates absent → the last 7 full MMT
   * days; one without the other, a non-date, or `from` after `to` → 400
   * AD_ANALYTICS_RANGE_INVALID; over 366 days → 400 AD_ANALYTICS_RANGE_TOO_LONG.
   * The lottery's resolvePeriod does the same with its own codes; a copy
   * of 20 lines beats a cross-module refactor for one error prefix.
   */
  resolvePeriod(
    query: { from?: string; to?: string },
    now = new Date(),
  ): AnalyticsPeriod {
    const invalid = (message: string) =>
      adError(
        HttpStatus.BAD_REQUEST,
        ADS_ERRORS.ANALYTICS_RANGE_INVALID,
        message,
      );
    let { from, to } = query;
    if (from === undefined && to === undefined) {
      ({ from, to } = lastFullDays(now, ANALYTICS_DEFAULT_RANGE_DAYS));
    }
    if (from === undefined || to === undefined) {
      throw invalid('Give both from and to, or neither.');
    }
    if (!isCalendarDate(from) || !isCalendarDate(to)) {
      throw invalid('from and to must be calendar dates written YYYY-MM-DD.');
    }
    if (from > to) throw invalid('from must not be after to.');
    const days = daysBetween(from, to);
    if (days > ANALYTICS_MAX_RANGE_DAYS) {
      throw adError(
        HttpStatus.BAD_REQUEST,
        ADS_ERRORS.ANALYTICS_RANGE_TOO_LONG,
        `The period spans ${days} days; at most ${ANALYTICS_MAX_RANGE_DAYS}.`,
        { days, maxDays: ANALYTICS_MAX_RANGE_DAYS },
      );
    }
    return periodOf(from, to);
  }
}
