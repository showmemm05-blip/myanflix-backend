import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  AdvertisementAudience,
  AdvertisementFormat,
  AdvertisementPlacement,
  AdvertisementPlaybackStatus,
  AdvertisementTargetType,
  ClientPlatform,
  Prisma,
  Role,
} from '../generated/prisma/client';
import { MinioService } from '../common/storage/minio.service';
import {
  mmtDateOf,
  mmtDayStart,
} from '../lottery/analytics/lottery-analytics-period';
import { PrismaService } from '../prisma/prisma.service';
import { isHiddenFromViewers } from '../videos/videos.service';
import { AdSettingsService, type AdRules } from './ad-settings.service';
import { ADS_ERRORS, adError } from './ads-errors';
import {
  inDailyWindow,
  passesViewerCaps,
  pickAd,
  readViewerState,
  type ViewerAdHistory,
  type ViewerTitleState,
} from './ad-eligibility';
import type { AdPlaybackEvent } from './dto/ad-preroll.dto';

/**
 * How long an open (PENDING) decision is handed back unchanged. A page
 * refresh or a stream-link refetch inside this window gets the SAME
 * playback id, so a viewer who reloads is not decided twice and the caps
 * are not spent twice.
 */
export const PENDING_REUSE_MS = 10 * 60_000;

/** How long a played (or failed) break stays done for one viewer and title. */
export const BREAK_MEMORY_MS = 12 * 60 * 60_000;

/** No break this close to the end of a title (the credits). Sent to the players. */
export const BREAK_END_GUARD_SECONDS = 120;

/** The players ask for a break this many movie seconds before it. */
export const BREAK_ASK_AHEAD_SECONDS = 20;

/** The corner picture first shows after this many seconds watched. */
export const CORNER_FIRST_SHOW_AFTER_SECONDS = 60;

/** A corner row's repeat and tap counters stop here (a stuck client cannot inflate them). */
export const CORNER_COUNTER_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A video ad as a player gets it — before the movie or at a break. */
export interface VideoAdView {
  playbackId: string;
  advertisementId: string;
  title: string;
  /** A signed URL on the cache server, good for the stream's TTL. */
  videoUrl: string;
  durationSeconds: number;
  isSkippable: boolean;
  skipAfterSeconds: number | null;
}

/** The pre-roll's original name — the legacy route still answers with it. */
export type PrerollAdView = VideoAdView;

/** The mid-roll breaks for one viewing (null in a session = no breaks). */
export interface BreakPlanView {
  intervalSeconds: number;
  doneThroughSeconds: number;
  endGuardSeconds: number;
  askAheadSeconds: number;
}

/** The corner picture for one viewing. */
export interface CornerAdView {
  playbackId: string;
  advertisementId: string;
  title: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  linkUrl: string | null;
  showSeconds: number | null;
  repeatSeconds: number | null;
  closable: boolean;
  firstShowAfterSeconds: number;
}

/** POST /ads/session — everything a player needs for one open of a title. */
export interface AdSessionView {
  preroll: VideoAdView | null;
  breaks: BreakPlanView | null;
  corner: CornerAdView | null;
}

/** POST /ads/preroll (legacy, for app builds from before the session route). */
export interface PrerollDecision {
  ad: PrerollAdView | null;
  /**
   * Always 0 since the "same movie again" rule was removed (owner, 4 Nov
   * 2026): kept in the old shape so an app build from before then keeps no
   * memory of its own and asks on every open.
   */
  replayAfterMinutes: number;
}

/** POST /ads/midroll. */
export interface MidrollDecision {
  ad: VideoAdView | null;
}

const AD_PLAY_SELECT = {
  id: true,
  title: true,
  format: true,
  playsBeforeMovie: true,
  playsAtBreaks: true,
  videoKey: true,
  durationSeconds: true,
  isSkippable: true,
  skipAfterSeconds: true,
  imageKey: true,
  imageWidth: true,
  imageHeight: true,
  linkUrl: true,
  cornerShowSeconds: true,
  cornerRepeatMinutes: true,
  cornerClosable: true,
  priority: true,
  dailyStartMinutes: true,
  dailyEndMinutes: true,
  tzOffsetMinutes: true,
  frequencyLimitMinutes: true,
  maxImpressionsPerUserPerDay: true,
  isActive: true,
} satisfies Prisma.AdvertisementSelect;

type PlayableAd = Prisma.AdvertisementGetPayload<{
  select: typeof AD_PLAY_SELECT;
}>;

const RECENT_ROW_SELECT = {
  id: true,
  advertisementId: true,
  placement: true,
  status: true,
  breakAtSeconds: true,
  startedAt: true,
  failedAt: true,
  createdAt: true,
} satisfies Prisma.AdvertisementPlaybackSelect;

type RecentRow = Prisma.AdvertisementPlaybackGetPayload<{
  select: typeof RECENT_ROW_SELECT;
}>;

/** Which statuses each event may move a playback FROM (compare-and-set). */
const EVENT_FROM: Record<AdPlaybackEvent, AdvertisementPlaybackStatus[]> = {
  started: [AdvertisementPlaybackStatus.PENDING],
  completed: [AdvertisementPlaybackStatus.STARTED],
  skipped: [AdvertisementPlaybackStatus.STARTED],
  failed: [
    AdvertisementPlaybackStatus.PENDING,
    AdvertisementPlaybackStatus.STARTED,
  ],
  shown: [AdvertisementPlaybackStatus.STARTED],
  clicked: [AdvertisementPlaybackStatus.STARTED],
};

/** Which placements each event belongs to (a corner never completes; only a corner comes back or is tapped). */
const EVENT_PLACEMENTS: Partial<
  Record<AdPlaybackEvent, Prisma.EnumAdvertisementPlacementFilter>
> = {
  completed: { not: AdvertisementPlacement.CORNER },
  shown: { equals: AdvertisementPlacement.CORNER },
  clicked: { equals: AdvertisementPlacement.CORNER },
};

interface DecideInput {
  userId: string;
  role: Role;
  movieId: string;
  platform: ClientPlatform;
  now?: Date;
  random?: () => number;
}

/**
 * The viewer-facing half of advertising: which ads a player gets for one
 * open of a title (POST /ads/session — the ad before the movie, the break
 * plan and the corner picture), which ad plays at a break (POST
 * /ads/midroll), the legacy pre-roll route (POST /ads/preroll), and what the
 * player reports (POST /ads/playbacks/:id/events).
 *
 * The decisions are their own endpoints, not fields on /videos/:id/stream:
 * the players refetch the stream on link recovery, which must never
 * re-decide an ad mid-film. They check only the publish rule (a hidden
 * title is 404 for a viewer, as /stream says) — the subscription check
 * already ran on the stream call.
 *
 * Every read and write is scoped by PLACEMENT: an open break or corner row
 * must never be handed back as the ad before the movie, nor abandoned by it.
 * All placements of one viewer + title share one advisory lock, so two tabs
 * (or a session and a break) can never mint over each other.
 */
@Injectable()
export class AdDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
    private readonly settings: AdSettingsService,
  ) {}

  /** POST /ads/session. */
  async session(input: DecideInput): Promise<AdSessionView> {
    return this.decideOpen(input, { inMovie: true });
  }

  /** POST /ads/preroll — the session's pre-roll part, in the old shape. Never mints a break or corner row. */
  async preroll(input: DecideInput): Promise<PrerollDecision> {
    const session = await this.decideOpen(input, { inMovie: false });
    return { ad: session.preroll, replayAfterMinutes: 0 };
  }

  /** POST /ads/midroll — one break of a viewing the player is about to reach (or jumped over). */
  async midroll(
    input: DecideInput & { breakAtSeconds: number },
  ): Promise<MidrollDecision> {
    const now = input.now ?? new Date();
    const rules = await this.settings.rules(now.getTime());
    if (!rules.adsEnabled || rules.midrollIntervalMinutes === 0) {
      return { ad: null };
    }
    const [movie, rows, candidates, subscribed] = await Promise.all([
      this.movieOf(input.movieId),
      this.recentRows(input.userId, input.movieId, now, [
        AdvertisementPlacement.MIDROLL,
      ]),
      this.candidates(input.movieId, now, { breaks: true }),
      this.isSubscribed(input.userId, rules, now),
    ]);
    this.assertVisible(movie, input.role);
    if (subscribed) return { ad: null };

    const state = this.stateOf(rows, now);
    if (input.breakAtSeconds <= state.doneThroughSeconds) return { ad: null };
    // The player already asked about a LATER break: this request is a stale
    // one (an aborted prefetch that still arrived) and must not spend it.
    if (
      [...state.openMidrolls.keys()].some((at) => at > input.breakAtSeconds)
    ) {
      return { ad: null };
    }
    const live = new Map(candidates.map((ad) => [ad.id, ad]));
    const open = state.openMidrolls.get(input.breakAtSeconds);
    const openAd = open ? live.get(open.advertisementId) : undefined;
    if (open && openAd) return { ad: this.videoView(open.id, openAd) };

    // A jump past a break the player had already asked about: that open
    // decision (already counted toward the ad's caps) MOVES to this break,
    // so the row records the furthest break the one ad covered.
    const earlier = [...state.openMidrolls.entries()]
      .filter(
        ([at, row]) =>
          at < input.breakAtSeconds && live.has(row.advertisementId),
      )
      .sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(([, row]) => row)[0];
    const chosen = earlier
      ? null
      : await this.choose(input.userId, candidates, now, input.random);
    if (!earlier && !chosen) return { ad: null };

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.userId, input.movieId);
      const since = new Date(now.getTime() - BREAK_MEMORY_MS);
      const [again, done, later] = await Promise.all([
        tx.advertisementPlayback.findFirst({
          where: {
            userId: input.userId,
            movieId: input.movieId,
            placement: AdvertisementPlacement.MIDROLL,
            breakAtSeconds: input.breakAtSeconds,
            status: AdvertisementPlaybackStatus.PENDING,
            createdAt: { gte: new Date(now.getTime() - PENDING_REUSE_MS) },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, advertisementId: true },
        }),
        tx.advertisementPlayback.findFirst({
          where: {
            userId: input.userId,
            movieId: input.movieId,
            placement: AdvertisementPlacement.MIDROLL,
            breakAtSeconds: { gte: input.breakAtSeconds },
            OR: [{ startedAt: { gte: since } }, { failedAt: { gte: since } }],
          },
          select: { id: true },
        }),
        tx.advertisementPlayback.findFirst({
          where: {
            userId: input.userId,
            movieId: input.movieId,
            placement: AdvertisementPlacement.MIDROLL,
            breakAtSeconds: { gt: input.breakAtSeconds },
            status: AdvertisementPlaybackStatus.PENDING,
            createdAt: { gte: new Date(now.getTime() - PENDING_REUSE_MS) },
          },
          select: { id: true },
        }),
      ]);
      // Another tab played this break (or a later one) while this one
      // chose, or a later break was asked about meanwhile: nothing here.
      if (done || later) return null;
      const againAd = again ? live.get(again.advertisementId) : undefined;
      if (again && againAd) return { id: again.id, ad: againAd };
      if (earlier) {
        const { count } = await tx.advertisementPlayback.updateMany({
          where: {
            id: earlier.id,
            status: AdvertisementPlaybackStatus.PENDING,
          },
          data: { breakAtSeconds: input.breakAtSeconds },
        });
        const earlierAd = live.get(earlier.advertisementId);
        // Started (or spent) by another tab meanwhile: no ad this time.
        return count > 0 && earlierAd
          ? { id: earlier.id, ad: earlierAd }
          : null;
      }
      if (!chosen) return null;
      // One break plays at a time: an older open break (a jump past it) is spent.
      await tx.advertisementPlayback.updateMany({
        where: {
          userId: input.userId,
          movieId: input.movieId,
          placement: AdvertisementPlacement.MIDROLL,
          status: AdvertisementPlaybackStatus.PENDING,
        },
        data: { status: AdvertisementPlaybackStatus.ABANDONED },
      });
      const created = await tx.advertisementPlayback.create({
        data: {
          advertisementId: chosen.id,
          userId: input.userId,
          movieId: input.movieId,
          platform: input.platform,
          placement: AdvertisementPlacement.MIDROLL,
          breakAtSeconds: input.breakAtSeconds,
        },
        select: { id: true },
      });
      return { id: created.id, ad: chosen };
    });
    return { ad: row ? this.videoView(row.id, row.ad) : null };
  }

  /**
   * One open of a title. Round trip 1 (in parallel): the title, this
   * viewer's recent rows for it, the live candidates, and — only when the
   * in-movie ads are for viewers without Premium — the subscription. Round
   * trip 2 only when something must be picked (the caps), round trip 3 only
   * when a row must be written. `inMovie: false` is the legacy pre-roll path.
   */
  private async decideOpen(
    input: DecideInput,
    parts: { inMovie: boolean },
  ): Promise<AdSessionView> {
    const now = input.now ?? new Date();
    const rules = await this.settings.rules(now.getTime());
    const empty: AdSessionView = { preroll: null, breaks: null, corner: null };
    // The master switch answers before anything is read: no ads, no rows.
    if (!rules.adsEnabled) return empty;

    const placements: AdvertisementPlacement[] = parts.inMovie
      ? [
          AdvertisementPlacement.PREROLL,
          AdvertisementPlacement.MIDROLL,
          AdvertisementPlacement.CORNER,
        ]
      : [AdvertisementPlacement.PREROLL];
    const [movie, rows, candidates, subscribed] = await Promise.all([
      this.movieOf(input.movieId),
      this.recentRows(input.userId, input.movieId, now, placements),
      this.candidates(input.movieId, now, {
        preroll: true,
        breaks: parts.inMovie,
        corner: parts.inMovie,
      }),
      parts.inMovie
        ? this.isSubscribed(input.userId, rules, now)
        : Promise.resolve(false),
    ]);
    this.assertVisible(movie, input.role);

    const state = this.stateOf(rows, now);
    const inMovieAllowed = parts.inMovie && !subscribed;
    const prerollAds = candidates.filter(
      (ad) => ad.format === AdvertisementFormat.VIDEO && ad.playsBeforeMovie,
    );
    const breakAds = candidates.filter(
      (ad) => ad.format === AdvertisementFormat.VIDEO && ad.playsAtBreaks,
    );
    const cornerAds = inMovieAllowed
      ? candidates.filter((ad) => ad.format === AdvertisementFormat.CORNER)
      : [];

    const breaks: BreakPlanView | null =
      inMovieAllowed && rules.midrollIntervalMinutes > 0 && breakAds.length > 0
        ? {
            intervalSeconds: rules.midrollIntervalMinutes * 60,
            doneThroughSeconds: state.doneThroughSeconds,
            endGuardSeconds: BREAK_END_GUARD_SECONDS,
            askAheadSeconds: BREAK_ASK_AHEAD_SECONDS,
          }
        : null;

    // What can be handed back as it is, and what still needs a pick. The
    // ad before the movie plays on every open (an open decision that never
    // played is handed back, so a refresh is not a second play).
    let preroll = this.reusable(state.openPreroll, prerollAds);
    const prerollPool: PlayableAd[] = preroll ? [] : prerollAds;
    let corner: { id: string; ad: PlayableAd } | null = null;
    let cornerPool: PlayableAd[] = [];
    if (state.corner.kind === 'open') {
      corner = this.reusable(state.corner.row, cornerAds);
      if (!corner) cornerPool = cornerAds;
    } else if (state.corner.kind === 'none') {
      cornerPool = cornerAds;
    }

    if (prerollPool.length > 0 || cornerPool.length > 0) {
      const history = await this.history(
        input.userId,
        [...prerollPool, ...cornerPool].map((ad) => ad.id),
        now,
      );
      const pick = (pool: PlayableAd[]) =>
        pickAd(
          pool.filter((ad) => passesViewerCaps(ad, history.get(ad.id), now)),
          history,
          input.random,
        );
      const prerollChoice = prerollPool.length > 0 ? pick(prerollPool) : null;
      const cornerChoice = cornerPool.length > 0 ? pick(cornerPool) : null;
      if (prerollChoice || cornerChoice) {
        const minted = await this.mintOpen(input, now, {
          preroll: prerollChoice,
          corner: cornerChoice,
          // Per slot: a sibling row is handed back only while its ad is
          // still live for THAT slot (an ad taken out of the pre-roll slot
          // may still be live at breaks).
          live: {
            [AdvertisementPlacement.PREROLL]: new Map(
              prerollAds.map((ad) => [ad.id, ad]),
            ),
            [AdvertisementPlacement.CORNER]: new Map(
              cornerAds.map((ad) => [ad.id, ad]),
            ),
          },
        });
        preroll = minted.preroll ?? preroll;
        corner = minted.corner ?? corner;
      }
    }

    return {
      preroll: preroll ? this.videoView(preroll.id, preroll.ad) : null,
      breaks,
      corner: corner ? this.cornerView(corner.id, corner.ad) : null,
    };
  }

  /**
   * The writes of one open, under the viewer + title lock: a row another
   * tab minted while this one was choosing is handed back as it is (that tab
   * is already showing it), older open rows of the same placement are
   * abandoned, then the new ones are created.
   */
  private async mintOpen(
    input: DecideInput,
    now: Date,
    choice: {
      preroll: PlayableAd | null;
      corner: PlayableAd | null;
      live: Record<'PREROLL' | 'CORNER', ReadonlyMap<string, PlayableAd>>;
    },
  ): Promise<{
    preroll: { id: string; ad: PlayableAd } | null;
    corner: { id: string; ad: PlayableAd } | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.userId, input.movieId);
      const toMint: AdvertisementPlacement[] = [];
      if (choice.preroll) toMint.push(AdvertisementPlacement.PREROLL);
      if (choice.corner) toMint.push(AdvertisementPlacement.CORNER);
      const siblings = await tx.advertisementPlayback.findMany({
        where: {
          userId: input.userId,
          movieId: input.movieId,
          placement: { in: toMint },
          createdAt: { gte: new Date(now.getTime() - PENDING_REUSE_MS) },
          status: {
            in: [
              AdvertisementPlaybackStatus.PENDING,
              AdvertisementPlaybackStatus.STARTED,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          advertisementId: true,
          placement: true,
          status: true,
        },
      });
      const siblingOf = (placement: 'PREROLL' | 'CORNER') => {
        // A STARTED corner is still this viewing's corner; a STARTED
        // pre-roll is a play that already happened, never one to hand back.
        const row = siblings.find(
          (s) =>
            s.placement === placement &&
            (s.status === AdvertisementPlaybackStatus.PENDING ||
              placement === AdvertisementPlacement.CORNER),
        );
        const ad = row
          ? choice.live[placement].get(row.advertisementId)
          : undefined;
        return row && ad ? { id: row.id, ad } : null;
      };

      const out: {
        preroll: { id: string; ad: PlayableAd } | null;
        corner: { id: string; ad: PlayableAd } | null;
      } = { preroll: null, corner: null };
      const create: {
        placement: AdvertisementPlacement;
        ad: PlayableAd;
      }[] = [];
      if (choice.preroll) {
        const sibling = siblingOf(AdvertisementPlacement.PREROLL);
        if (sibling) out.preroll = sibling;
        else
          create.push({
            placement: AdvertisementPlacement.PREROLL,
            ad: choice.preroll,
          });
      }
      if (choice.corner) {
        const sibling = siblingOf(AdvertisementPlacement.CORNER);
        if (sibling) out.corner = sibling;
        else
          create.push({
            placement: AdvertisementPlacement.CORNER,
            ad: choice.corner,
          });
      }
      if (create.length === 0) return out;

      await tx.advertisementPlayback.updateMany({
        where: {
          userId: input.userId,
          movieId: input.movieId,
          placement: { in: create.map((c) => c.placement) },
          status: AdvertisementPlaybackStatus.PENDING,
        },
        data: { status: AdvertisementPlaybackStatus.ABANDONED },
      });
      for (const item of create) {
        const created = await tx.advertisementPlayback.create({
          data: {
            advertisementId: item.ad.id,
            userId: input.userId,
            movieId: input.movieId,
            platform: input.platform,
            placement: item.placement,
          },
          select: { id: true },
        });
        if (item.placement === AdvertisementPlacement.PREROLL) {
          out.preroll = { id: created.id, ad: item.ad };
        } else {
          out.corner = { id: created.id, ad: item.ad };
        }
      }
      return out;
    });
  }

  /**
   * One event, applied as a compare-and-set: the row moves only from the
   * statuses (and placements) the event is allowed from, so a repeated
   * `started`, a `completed` after `skipped` or a corner's `completed`
   * change nothing and answer with the row as it stands.
   *
   * Repairs: a `completed` or `skipped` for a row still PENDING means its
   * `started` was lost on the way (sent once, never retried) — yet the ad
   * did play. The row closes anyway, with a start time worked back from the
   * position, so it counts as an impression (and a break as done); left
   * PENDING, the next open would hand the same ad back. A
   * corner's `shown` / `clicked` on a PENDING row likewise starts it.
   */
  async recordEvent(
    playbackId: string,
    userId: string,
    event: AdPlaybackEvent,
    positionSeconds: number | undefined,
    now = new Date(),
  ): Promise<{ playbackId: string; status: AdvertisementPlaybackStatus }> {
    const position =
      positionSeconds === undefined
        ? undefined
        : Math.max(0, Math.min(86_400, Math.round(positionSeconds)));
    const data: Prisma.AdvertisementPlaybackUpdateManyMutationInput = (() => {
      switch (event) {
        case 'started':
          return {
            status: AdvertisementPlaybackStatus.STARTED,
            startedAt: now,
          };
        case 'completed':
          return {
            status: AdvertisementPlaybackStatus.COMPLETED,
            completedAt: now,
          };
        case 'skipped':
          return {
            status: AdvertisementPlaybackStatus.SKIPPED,
            skippedAt: now,
            positionSeconds: position,
          };
        case 'failed':
          return {
            status: AdvertisementPlaybackStatus.FAILED,
            failedAt: now,
            positionSeconds: position,
          };
        case 'shown':
          return { repeatCount: { increment: 1 } };
        case 'clicked':
          return { clickCount: { increment: 1 } };
      }
    })();
    const counterCap: Prisma.AdvertisementPlaybackWhereInput =
      event === 'shown'
        ? { repeatCount: { lt: CORNER_COUNTER_CAP } }
        : event === 'clicked'
          ? { clickCount: { lt: CORNER_COUNTER_CAP } }
          : {};
    const scope: Prisma.AdvertisementPlaybackWhereInput = {
      id: playbackId,
      userId,
      ...(EVENT_PLACEMENTS[event]
        ? { placement: EVENT_PLACEMENTS[event] }
        : {}),
      ...counterCap,
    };
    let { count } = await this.prisma.advertisementPlayback.updateMany({
      where: { ...scope, status: { in: EVENT_FROM[event] } },
      data,
    });
    let repairedTo: AdvertisementPlaybackStatus | undefined;
    if (count === 0 && event !== 'started' && event !== 'failed') {
      const startedAt =
        event === 'completed' || event === 'skipped'
          ? new Date(now.getTime() - (position ?? 0) * 1000)
          : now;
      ({ count } = await this.prisma.advertisementPlayback.updateMany({
        where: { ...scope, status: AdvertisementPlaybackStatus.PENDING },
        data:
          event === 'shown' || event === 'clicked'
            ? {
                ...data,
                status: AdvertisementPlaybackStatus.STARTED,
                startedAt,
              }
            : { ...data, startedAt },
      }));
      if (count > 0 && (event === 'shown' || event === 'clicked')) {
        repairedTo = AdvertisementPlaybackStatus.STARTED;
      }
    }
    if (count > 0) {
      const status =
        (data.status as AdvertisementPlaybackStatus | undefined) ??
        repairedTo ??
        AdvertisementPlaybackStatus.STARTED;
      return { playbackId, status };
    }

    const row = await this.prisma.advertisementPlayback.findUnique({
      where: { id: playbackId },
      select: { userId: true, status: true },
    });
    if (!row || row.userId !== userId) {
      throw adError(
        HttpStatus.NOT_FOUND,
        ADS_ERRORS.PLAYBACK_NOT_FOUND,
        'Playback not found',
      );
    }
    return { playbackId, status: row.status };
  }

  // ---------------------------------------------------------------- reads

  private movieOf(movieId: string) {
    return this.prisma.movie.findUnique({
      where: { id: movieId },
      select: {
        status: true,
        seriesId: true,
        series: { select: { status: true } },
      },
    });
  }

  private assertVisible(
    movie: Awaited<ReturnType<AdDecisionService['movieOf']>>,
    role: Role,
  ): void {
    if (!movie || (role === Role.USER && isHiddenFromViewers(movie))) {
      throw new NotFoundException('Movie not found');
    }
  }

  /**
   * This viewer's recent rows for the title, every placement asked for:
   * fresh ones (open decisions, this viewing's corner) and the started /
   * failed ones the break memory looks back on.
   */
  private recentRows(
    userId: string,
    movieId: string,
    now: Date,
    placements: AdvertisementPlacement[],
  ): Promise<RecentRow[]> {
    const memorySince = new Date(now.getTime() - BREAK_MEMORY_MS);
    return this.prisma.advertisementPlayback.findMany({
      where: {
        userId,
        movieId,
        placement: { in: placements },
        OR: [
          { createdAt: { gte: new Date(now.getTime() - PENDING_REUSE_MS) } },
          { startedAt: { gte: memorySince } },
          { failedAt: { gte: memorySince } },
        ],
      },
      select: RECENT_ROW_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  private stateOf(rows: RecentRow[], now: Date): ViewerTitleState<RecentRow> {
    return readViewerState(rows, now, {
      pendingReuseMs: PENDING_REUSE_MS,
      breakMemoryMs: BREAK_MEMORY_MS,
    });
  }

  /**
   * The live ads for this title in the slots asked for: on, with their
   * video / picture, inside their schedule, aimed at the title. Dozens of
   * rows at most, so the daily window is a filter in memory (it depends on
   * each ad's own offset).
   */
  private async candidates(
    movieId: string,
    now: Date,
    slots: { preroll?: boolean; breaks?: boolean; corner?: boolean },
  ): Promise<PlayableAd[]> {
    const kinds: Prisma.AdvertisementWhereInput[] = [];
    const videoSlots: Prisma.AdvertisementWhereInput[] = [];
    if (slots.preroll) videoSlots.push({ playsBeforeMovie: true });
    if (slots.breaks) videoSlots.push({ playsAtBreaks: true });
    if (videoSlots.length > 0) {
      kinds.push({
        format: AdvertisementFormat.VIDEO,
        videoKey: { not: null },
        durationSeconds: { not: null },
        OR: videoSlots,
      });
    }
    if (slots.corner) {
      kinds.push({
        format: AdvertisementFormat.CORNER,
        imageKey: { not: null },
      });
    }
    if (kinds.length === 0) return [];
    const ads = await this.prisma.advertisement.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          {
            OR: [
              { targetType: AdvertisementTargetType.ALL },
              { movies: { some: { movieId } } },
            ],
          },
          { OR: kinds },
        ],
      },
      select: AD_PLAY_SELECT,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return ads.filter((ad) => inDailyWindow(ad, now));
  }

  /** Only asked when the in-movie ads are for viewers without Premium. */
  private async isSubscribed(
    userId: string,
    rules: AdRules,
    now: Date,
  ): Promise<boolean> {
    if (rules.duringMovieAudience !== AdvertisementAudience.NON_PREMIUM) {
      return false;
    }
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, expiresAt: { gt: now } },
      select: { id: true },
    });
    return active !== null;
  }

  /** An open row is handed back only while its ad is still a live candidate for its slot. */
  private reusable(
    row: { id: string; advertisementId: string } | null,
    live: readonly PlayableAd[],
  ): { id: string; ad: PlayableAd } | null {
    if (!row) return null;
    const ad = live.find((candidate) => candidate.id === row.advertisementId);
    return ad ? { id: row.id, ad } : null;
  }

  /** The caps and the pick for one slot's pool (one history read). */
  private async choose(
    userId: string,
    pool: PlayableAd[],
    now: Date,
    random?: () => number,
  ): Promise<PlayableAd | null> {
    if (pool.length === 0) return null;
    const history = await this.history(
      userId,
      pool.map((ad) => ad.id),
      now,
    );
    return pickAd(
      pool.filter((ad) => passesViewerCaps(ad, history.get(ad.id), now)),
      history,
      random,
    );
  }

  /** Every placement of one viewer + title takes the same lock (the pre-roll's original key). */
  private async lock(
    tx: Prisma.TransactionClient,
    userId: string,
    movieId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ad_preroll.${userId}.${movieId}`}))`;
  }

  private videoView(playbackId: string, ad: PlayableAd): VideoAdView {
    return {
      playbackId,
      advertisementId: ad.id,
      title: ad.title,
      videoUrl: this.minio.signedPlaybackUrl(ad.videoKey!),
      durationSeconds: ad.durationSeconds!,
      isSkippable: ad.isSkippable,
      skipAfterSeconds: ad.isSkippable ? ad.skipAfterSeconds : null,
    };
  }

  private cornerView(playbackId: string, ad: PlayableAd): CornerAdView {
    const untilClosed = ad.cornerShowSeconds === null;
    return {
      playbackId,
      advertisementId: ad.id,
      title: ad.title,
      imageUrl: this.minio.playbackUrl(ad.imageKey!),
      imageWidth: ad.imageWidth!,
      imageHeight: ad.imageHeight!,
      linkUrl: ad.linkUrl,
      showSeconds: ad.cornerShowSeconds,
      repeatSeconds:
        ad.cornerRepeatMinutes === null ? null : ad.cornerRepeatMinutes * 60,
      closable: untilClosed || ad.cornerClosable,
      firstShowAfterSeconds: CORNER_FIRST_SHOW_AFTER_SECONDS,
    };
  }

  /**
   * The viewer's past with the given ads: the last impression and today's
   * count (the Myanmar day). An OPEN decision counts too, for as long as it
   * can be handed back: the players ask before the Play gesture, so a
   * second title opened in another tab must not get a second play of a
   * capped ad. Every placement counts — the caps are the ad's.
   */
  private async history(
    userId: string,
    adIds: string[],
    now: Date,
  ): Promise<Map<string, ViewerAdHistory>> {
    const dayStart = mmtDayStart(mmtDateOf(now));
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const openSince = new Date(now.getTime() - PENDING_REUSE_MS);
    // An impression counts at its first frame; an open decision at the
    // moment it was handed out, until it expires or is spent.
    const rows = await this.prisma.$queryRaw<
      { advertisementId: string; lastStartedAt: Date | null; today: number }[]
    >(Prisma.sql`/* ads-decision:history */
      SELECT "advertisementId",
             MAX(COALESCE("startedAt", "createdAt")) AS "lastStartedAt",
             (COUNT(*) FILTER (WHERE COALESCE("startedAt", "createdAt") >= ${dayStart} AND COALESCE("startedAt", "createdAt") < ${dayEnd}))::int AS "today"
      FROM "advertisement_playbacks"
      WHERE "userId" = ${userId}
        AND "advertisementId" IN (${Prisma.join(adIds)})
        AND ("startedAt" IS NOT NULL
             OR ("status" = 'PENDING'::"AdvertisementPlaybackStatus" AND "createdAt" >= ${openSince}))
      GROUP BY "advertisementId"`);
    return new Map(
      rows.map((row) => [
        row.advertisementId,
        { lastStartedAt: row.lastStartedAt, today: Number(row.today) },
      ]),
    );
  }
}
