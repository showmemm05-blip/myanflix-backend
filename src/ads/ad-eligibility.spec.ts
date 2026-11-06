import {
  inDailyWindow,
  minuteOfDay,
  passesViewerCaps,
  pickAd,
  readViewerState,
  type EligibleAd,
  type RecentPlaybackRow,
  type ViewerAdHistory,
} from './ad-eligibility';

const MMT = 390;
const at = (iso: string) => new Date(iso);
const ad = (over: Partial<EligibleAd> = {}): EligibleAd => ({
  id: 'ad-1',
  priority: 0,
  dailyStartMinutes: null,
  dailyEndMinutes: null,
  tzOffsetMinutes: MMT,
  frequencyLimitMinutes: null,
  maxImpressionsPerUserPerDay: null,
  ...over,
});

describe('minuteOfDay', () => {
  it('reads the clock in the ad’s own offset, wrapping past midnight', () => {
    // 18:00 UTC = 00:30 MMT the next day.
    expect(minuteOfDay(at('2026-11-04T18:00:00Z'), MMT)).toBe(30);
    expect(minuteOfDay(at('2026-11-04T18:00:00Z'), 0)).toBe(18 * 60);
    // A negative offset wraps the other way: 02:00 UTC at UTC-5 is 21:00.
    expect(minuteOfDay(at('2026-11-04T02:00:00Z'), -300)).toBe(21 * 60);
  });
});

describe('inDailyWindow', () => {
  it('is all day when no window is set', () => {
    expect(inDailyWindow(ad(), at('2026-11-04T03:00:00Z'))).toBe(true);
  });

  it('is [start, end) in the ad’s offset', () => {
    const evening = ad({
      dailyStartMinutes: 18 * 60,
      dailyEndMinutes: 22 * 60,
    });
    // 11:30 UTC = 18:00 MMT (the start, inside); 15:30 UTC = 22:00 MMT (the end, outside).
    expect(inDailyWindow(evening, at('2026-11-04T11:30:00Z'))).toBe(true);
    expect(inDailyWindow(evening, at('2026-11-04T15:29:00Z'))).toBe(true);
    expect(inDailyWindow(evening, at('2026-11-04T15:30:00Z'))).toBe(false);
    expect(inDailyWindow(evening, at('2026-11-04T05:00:00Z'))).toBe(false);
  });

  it('wraps past midnight when the start is after the end', () => {
    const night = ad({ dailyStartMinutes: 22 * 60, dailyEndMinutes: 2 * 60 });
    // 16:00 UTC = 22:30 MMT; 18:30 UTC = 01:00 MMT; 20:00 UTC = 02:30 MMT.
    expect(inDailyWindow(night, at('2026-11-04T16:00:00Z'))).toBe(true);
    expect(inDailyWindow(night, at('2026-11-04T18:30:00Z'))).toBe(true);
    expect(inDailyWindow(night, at('2026-11-04T20:00:00Z'))).toBe(false);
    expect(inDailyWindow(night, at('2026-11-04T05:00:00Z'))).toBe(false);
  });
});

describe('passesViewerCaps', () => {
  const now = at('2026-11-04T10:00:00Z');
  const seen = (minutesAgo: number, today = 1): ViewerAdHistory => ({
    lastStartedAt: new Date(now.getTime() - minutesAgo * 60_000),
    today,
  });

  it('passes a viewer with no history', () => {
    expect(
      passesViewerCaps(
        ad({ maxImpressionsPerUserPerDay: 1, frequencyLimitMinutes: 60 }),
        undefined,
        now,
      ),
    ).toBe(true);
  });

  it('stops at the daily cap', () => {
    const capped = ad({ maxImpressionsPerUserPerDay: 2 });
    expect(passesViewerCaps(capped, seen(500, 1), now)).toBe(true);
    expect(passesViewerCaps(capped, seen(500, 2), now)).toBe(false);
  });

  it('keeps the minimum gap between two impressions', () => {
    const gapped = ad({ frequencyLimitMinutes: 60 });
    expect(passesViewerCaps(gapped, seen(59), now)).toBe(false);
    expect(passesViewerCaps(gapped, seen(60), now)).toBe(true);
    expect(
      passesViewerCaps(gapped, { lastStartedAt: null, today: 0 }, now),
    ).toBe(true);
  });
});

describe('pickAd', () => {
  const never = new Map<string, ViewerAdHistory>();

  it('returns null for no candidates', () => {
    expect(pickAd([], never)).toBeNull();
  });

  it('takes the highest priority', () => {
    const low = ad({ id: 'low', priority: 1 });
    const high = ad({ id: 'high', priority: 5 });
    expect(pickAd([low, high], never, () => 0.5)?.id).toBe('high');
  });

  it('breaks a priority tie with the one seen least recently, never seen first', () => {
    const a = ad({ id: 'a' });
    const b = ad({ id: 'b' });
    const c = ad({ id: 'c' });
    const history = new Map<string, ViewerAdHistory>([
      ['a', { lastStartedAt: at('2026-11-04T09:00:00Z'), today: 1 }],
      ['b', { lastStartedAt: at('2026-11-03T09:00:00Z'), today: 0 }],
    ]);
    expect(pickAd([a, b, c], history, () => 0.5)?.id).toBe('c');
    expect(pickAd([a, b], history, () => 0.5)?.id).toBe('b');
  });

  it('settles a full tie with the injected coin', () => {
    const a = ad({ id: 'a' });
    const b = ad({ id: 'b' });
    const coins = [0.9, 0.1];
    expect(pickAd([a, b], never, () => coins.shift() ?? 0)?.id).toBe('b');
  });
});

describe('readViewerState', () => {
  const now = at('2026-11-04T10:00:00Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const opts = {
    pendingReuseMs: 10 * 60_000,
    breakMemoryMs: 12 * 60 * 60_000,
  };
  let n = 0;
  const row = (over: Partial<RecentPlaybackRow>): RecentPlaybackRow => ({
    id: `pb-${++n}`,
    advertisementId: 'ad-1',
    placement: 'PREROLL',
    status: 'PENDING',
    breakAtSeconds: null,
    startedAt: null,
    failedAt: null,
    createdAt: ago(2),
    ...over,
  });

  it('nothing at all', () => {
    expect(readViewerState([], now, opts)).toEqual({
      openPreroll: null,
      corner: { kind: 'none' },
      doneThroughSeconds: 0,
      openMidrolls: new Map(),
    });
  });

  it('the open decision before the movie is the newest fresh PENDING one', () => {
    const older = row({ createdAt: ago(5) });
    const newer = row({ createdAt: ago(1) });
    const stale = row({ createdAt: ago(11) });
    expect(readViewerState([older, stale, newer], now, opts).openPreroll).toBe(
      newer,
    );
    expect(readViewerState([stale], now, opts).openPreroll).toBeNull();
    expect(
      readViewerState([row({ status: 'ABANDONED' })], now, opts).openPreroll,
    ).toBeNull();
  });

  it('the corner speaks through its newest fresh row: open, closed or none', () => {
    const corner = (over: Partial<RecentPlaybackRow>) =>
      readViewerState([row({ placement: 'CORNER', ...over })], now, opts).corner
        .kind;
    expect(corner({ status: 'PENDING' })).toBe('open');
    expect(corner({ status: 'STARTED', startedAt: ago(1) })).toBe('open');
    expect(corner({ status: 'SKIPPED', startedAt: ago(1) })).toBe('closed');
    expect(corner({ status: 'FAILED', failedAt: ago(1) })).toBe('closed');
    expect(corner({ status: 'ABANDONED' })).toBe('none');
    expect(corner({ status: 'SKIPPED', createdAt: ago(11) })).toBe('none');
    // A newer open row wins over an older closed one.
    const state = readViewerState(
      [
        row({ placement: 'CORNER', status: 'SKIPPED', createdAt: ago(8) }),
        row({ placement: 'CORNER', status: 'PENDING', createdAt: ago(1) }),
      ],
      now,
      opts,
    );
    expect(state.corner.kind).toBe('open');
  });

  it('breaks: done through the furthest one played or failed in 12 h; open ones by position', () => {
    const state = readViewerState(
      [
        row({
          placement: 'MIDROLL',
          breakAtSeconds: 1800,
          status: 'COMPLETED',
          startedAt: ago(60),
        }),
        row({
          placement: 'MIDROLL',
          breakAtSeconds: 5400,
          status: 'FAILED',
          failedAt: ago(13 * 60),
          createdAt: ago(13 * 60),
        }),
        row({
          placement: 'MIDROLL',
          breakAtSeconds: 3600,
          status: 'ABANDONED',
        }),
        row({
          id: 'open-3600',
          placement: 'MIDROLL',
          breakAtSeconds: 3600,
          status: 'PENDING',
          createdAt: ago(1),
        }),
      ],
      now,
      opts,
    );
    expect(state.doneThroughSeconds).toBe(1800);
    expect(state.openMidrolls.get(3600)?.id).toBe('open-3600');
    expect(state.openMidrolls.has(1800)).toBe(false);
  });
});
