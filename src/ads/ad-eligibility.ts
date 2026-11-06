/**
 * The pure half of the ad decisions (AdDecisionService): which of the
 * candidate ads the viewer's clock and history still allow, which one wins,
 * and what this viewer's recent rows for a title say. No Prisma, no
 * Date.now() — the service passes `now` in, so the specs can pin the clock.
 */

const MINUTES_PER_DAY = 24 * 60;

/** Row statuses / placements as plain strings, so this file needs no Prisma import. */
type Placement = 'PREROLL' | 'MIDROLL' | 'CORNER';
type PlaybackStatus =
  'PENDING' | 'STARTED' | 'COMPLETED' | 'SKIPPED' | 'FAILED' | 'ABANDONED';

/** One of this viewer's recent rows for one title (the service's single read). */
export interface RecentPlaybackRow {
  id: string;
  advertisementId: string;
  placement: Placement;
  status: PlaybackStatus;
  breakAtSeconds: number | null;
  startedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

export interface ViewerTitleState<Row extends RecentPlaybackRow> {
  /** The newest open (PENDING, fresh) decision before the movie, to hand back. */
  openPreroll: Row | null;
  /** The corner picture this viewing: an open row to hand back, closed (none again), or none yet. */
  corner: { kind: 'none' } | { kind: 'open'; row: Row } | { kind: 'closed' };
  /** Every break at or before this movie second is done (played or failed) — 0 = none. */
  doneThroughSeconds: number;
  /** The newest open break decision per break position. */
  openMidrolls: ReadonlyMap<number, Row>;
}

/**
 * Reads one viewer's recent rows for one title (newest first or not — order
 * is re-derived here). `pendingReuseMs` is how long an open decision is
 * handed back, `breakMemoryMs` how long a played break stays done.
 */
export function readViewerState<Row extends RecentPlaybackRow>(
  rows: readonly Row[],
  now: Date,
  opts: {
    pendingReuseMs: number;
    breakMemoryMs: number;
  },
): ViewerTitleState<Row> {
  const t = now.getTime();
  const openSince = t - opts.pendingReuseMs;
  const memorySince = t - opts.breakMemoryMs;
  const at = (d: Date | null) =>
    d === null ? Number.NEGATIVE_INFINITY : d.getTime();
  const newestFirst = [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  let openPreroll: Row | null = null;
  let corner: ViewerTitleState<Row>['corner'] = { kind: 'none' };
  let cornerSeen = false;
  let doneThroughSeconds = 0;
  const openMidrolls = new Map<number, Row>();

  for (const row of newestFirst) {
    const fresh = row.createdAt.getTime() >= openSince;
    if (row.placement === 'PREROLL') {
      if (!openPreroll && fresh && row.status === 'PENDING') openPreroll = row;
    } else if (row.placement === 'MIDROLL') {
      if (row.breakAtSeconds !== null) {
        if (
          at(row.startedAt) >= memorySince ||
          at(row.failedAt) >= memorySince
        ) {
          doneThroughSeconds = Math.max(doneThroughSeconds, row.breakAtSeconds);
        }
        if (
          fresh &&
          row.status === 'PENDING' &&
          !openMidrolls.has(row.breakAtSeconds)
        ) {
          openMidrolls.set(row.breakAtSeconds, row);
        }
      }
    } else if (!cornerSeen && fresh) {
      // Only the newest fresh corner row speaks for this viewing.
      cornerSeen = true;
      if (row.status === 'PENDING' || row.status === 'STARTED') {
        corner = { kind: 'open', row };
      } else if (row.status !== 'ABANDONED') {
        corner = { kind: 'closed' };
      }
    }
  }
  return { openPreroll, corner, doneThroughSeconds, openMidrolls };
}

/** What the decision needs to know about one candidate ad. */
export interface EligibleAd {
  id: string;
  priority: number;
  dailyStartMinutes: number | null;
  dailyEndMinutes: number | null;
  tzOffsetMinutes: number;
  frequencyLimitMinutes: number | null;
  maxImpressionsPerUserPerDay: number | null;
}

/** One viewer's past with one ad: the last impression and today's count (Myanmar day). */
export interface ViewerAdHistory {
  lastStartedAt: Date | null;
  today: number;
}

/** Minutes after midnight at `now`, read in a fixed UTC offset (0..1439). */
export function minuteOfDay(now: Date, tzOffsetMinutes: number): number {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (
    (((utcMinutes + tzOffsetMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY
  );
}

/**
 * Both bounds null = all day. Otherwise [start, end) in the ad's own
 * offset; a start AFTER the end wraps past midnight (22:00–02:00 is
 * 22:00 to midnight and midnight to 02:00).
 */
export function inDailyWindow(
  ad: Pick<
    EligibleAd,
    'dailyStartMinutes' | 'dailyEndMinutes' | 'tzOffsetMinutes'
  >,
  now: Date,
): boolean {
  if (ad.dailyStartMinutes === null || ad.dailyEndMinutes === null) return true;
  const minute = minuteOfDay(now, ad.tzOffsetMinutes);
  if (ad.dailyStartMinutes < ad.dailyEndMinutes) {
    return minute >= ad.dailyStartMinutes && minute < ad.dailyEndMinutes;
  }
  return minute >= ad.dailyStartMinutes || minute < ad.dailyEndMinutes;
}

/** The daily cap and the minimum gap, both on impressions (started plays) only. */
export function passesViewerCaps(
  ad: Pick<EligibleAd, 'frequencyLimitMinutes' | 'maxImpressionsPerUserPerDay'>,
  history: ViewerAdHistory | undefined,
  now: Date,
): boolean {
  if (!history) return true;
  if (
    ad.maxImpressionsPerUserPerDay !== null &&
    history.today >= ad.maxImpressionsPerUserPerDay
  ) {
    return false;
  }
  if (ad.frequencyLimitMinutes !== null && history.lastStartedAt !== null) {
    const gapMs = now.getTime() - history.lastStartedAt.getTime();
    if (gapMs < ad.frequencyLimitMinutes * 60_000) return false;
  }
  return true;
}

/**
 * The winner among the ads that passed every filter: the highest priority,
 * then the one this viewer saw least recently (never seen first), then a
 * coin — `random` is injected so a spec can make it deterministic.
 */
export function pickAd<T extends EligibleAd>(
  ads: readonly T[],
  history: ReadonlyMap<string, ViewerAdHistory>,
  random: () => number = Math.random,
): T | null {
  if (ads.length === 0) return null;
  const lastSeen = (ad: T) =>
    history.get(ad.id)?.lastStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const ranked = ads
    .map((ad) => ({ ad, tiebreak: random() }))
    .sort(
      (a, b) =>
        b.ad.priority - a.ad.priority ||
        lastSeen(a.ad) - lastSeen(b.ad) ||
        a.tiebreak - b.tiebreak,
    );
  return ranked[0].ad;
}
