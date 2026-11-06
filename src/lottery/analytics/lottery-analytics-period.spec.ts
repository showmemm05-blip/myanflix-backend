import { CodedHttpException } from '../../common/errors/coded-http.exception';
import { Prisma } from '../../generated/prisma/client';
import { LOTTERY_ERRORS } from '../lottery-errors';
import {
  addDays,
  ANALYTICS_MAX_RANGE_DAYS,
  BEFORE_CLOSE_BINS,
  beforeCloseEdges,
  bucketKeys,
  changePct,
  DAY_MS,
  daysBetween,
  hasEarlierData,
  HOUR_KEYS,
  ksText,
  lastFullDays,
  mmtDateOf,
  mmtDayStart,
  mondayOf,
  periodOf,
  resolvePeriod,
  share,
  WEEKDAY_KEYS,
  windowOf,
} from './lottery-analytics-period';

/** The error a call throws, so a case can look at its code and status. */
function errorOf(run: () => unknown): CodedHttpException {
  try {
    run();
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected a CodedHttpException');
}

describe('MMT calendar helpers', () => {
  it('mmtDateOf: the Myanmar day turns over at 17:30 UTC', () => {
    expect(mmtDateOf(new Date('2026-10-22T17:29:59.999Z'))).toBe('2026-10-22');
    expect(mmtDateOf(new Date('2026-10-22T17:30:00.000Z'))).toBe('2026-10-23');
    expect(mmtDateOf(new Date('2026-10-23T05:00:00.000Z'))).toBe('2026-10-23');
  });

  it('mmtDayStart: 00:00 MMT of a day is 17:30 UTC the evening before', () => {
    expect(mmtDayStart('2026-10-16').toISOString()).toBe(
      '2026-10-15T17:30:00.000Z',
    );
  });

  it('addDays crosses month and year ends (and leap days)', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-10-16', -7)).toBe('2026-10-09');
  });

  it('daysBetween counts both ends', () => {
    expect(daysBetween('2026-10-16', '2026-10-16')).toBe(1);
    expect(daysBetween('2026-10-16', '2026-10-22')).toBe(7);
    expect(daysBetween('2024-01-01', '2024-12-31')).toBe(366);
  });

  it('mondayOf: a Thursday and a Sunday map to the Monday before them, a Monday to itself', () => {
    expect(mondayOf('2026-10-22')).toBe('2026-10-19');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
  });

  it('windowOf: start inclusive at from 00:00 MMT, end exclusive at the next day after to', () => {
    const window = windowOf('2026-10-16', '2026-10-22');
    expect(window).toMatchObject({
      from: '2026-10-16',
      to: '2026-10-22',
      days: 7,
    });
    expect(window.start.toISOString()).toBe('2026-10-15T17:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-22T17:30:00.000Z');
    expect(window.end.getTime() - window.start.getTime()).toBe(7 * DAY_MS);
  });

  it('periodOf: the comparison window is the same length, ending the day before from', () => {
    expect(periodOf('2026-10-16', '2026-10-22').previous).toMatchObject({
      from: '2026-10-09',
      to: '2026-10-15',
      days: 7,
    });
    expect(periodOf('2026-03-01', '2026-03-01').previous).toMatchObject({
      from: '2026-02-28',
      to: '2026-02-28',
      days: 1,
    });
  });
});

describe('resolvePeriod', () => {
  /** 11:30 MMT on Friday 23 October 2026. */
  const NOW = new Date('2026-10-23T05:00:00.000Z');

  it('defaults the dashboard to the last 7 full MMT days before today, compared with the 7 before', () => {
    const period = resolvePeriod({}, 'last7', NOW);
    expect(period).toMatchObject({
      from: '2026-10-16',
      to: '2026-10-22',
      days: 7,
      previous: { from: '2026-10-09', to: '2026-10-15', days: 7 },
    });
    expect(period.start.toISOString()).toBe('2026-10-15T17:30:00.000Z');
    expect(period.end.toISOString()).toBe('2026-10-22T17:30:00.000Z');
  });

  it('reads "today" in Myanmar time: at 17:45 UTC on the 22nd it is already the 23rd', () => {
    expect(
      resolvePeriod({}, 'last7', new Date('2026-10-22T17:45:00.000Z')),
    ).toMatchObject({ from: '2026-10-16', to: '2026-10-22' });
    expect(
      resolvePeriod({}, 'last7', new Date('2026-10-22T17:15:00.000Z')),
    ).toMatchObject({ from: '2026-10-15', to: '2026-10-21' });
    expect(lastFullDays(new Date('2026-11-01T00:00:00.000Z'), 30)).toEqual({
      from: '2026-10-02',
      to: '2026-10-31',
    });
  });

  it('defaults the reports to all time (null)', () => {
    expect(resolvePeriod({}, 'all', NOW)).toBeNull();
  });

  it('uses an explicit range as given, whatever the fallback — one day is a one-day window', () => {
    const period = resolvePeriod(
      { from: '2026-10-01', to: '2026-10-01' },
      'all',
      NOW,
    );
    expect(period).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-01',
      days: 1,
      previous: { from: '2026-09-30', to: '2026-09-30' },
    });
    expect(period!.end.getTime() - period!.start.getTime()).toBe(DAY_MS);
  });

  it('refuses from after to with 400 LOTTERY_ANALYTICS_RANGE_INVALID', () => {
    const error = errorOf(() =>
      resolvePeriod({ from: '2026-10-02', to: '2026-10-01' }, 'all', NOW),
    );
    expect(error).toMatchObject({
      code: LOTTERY_ERRORS.ANALYTICS_RANGE_INVALID,
      status: 400,
    });
  });

  it('refuses one date without the other', () => {
    expect(
      errorOf(() => resolvePeriod({ from: '2026-10-01' }, 'last7', NOW)),
    ).toMatchObject({ code: LOTTERY_ERRORS.ANALYTICS_RANGE_INVALID });
    expect(
      errorOf(() => resolvePeriod({ to: '2026-10-01' }, 'all', NOW)),
    ).toMatchObject({ code: LOTTERY_ERRORS.ANALYTICS_RANGE_INVALID });
  });

  it('refuses a date that is not a calendar day', () => {
    expect(
      errorOf(() =>
        resolvePeriod({ from: '2026-02-30', to: '2026-03-01' }, 'all', NOW),
      ),
    ).toMatchObject({ code: LOTTERY_ERRORS.ANALYTICS_RANGE_INVALID });
  });

  it('allows exactly 366 days and refuses 367 with 400 LOTTERY_ANALYTICS_RANGE_TOO_LONG', () => {
    expect(
      resolvePeriod({ from: '2024-01-01', to: '2024-12-31' }, 'all', NOW),
    ).toMatchObject({ days: ANALYTICS_MAX_RANGE_DAYS });
    const error = errorOf(() =>
      resolvePeriod({ from: '2024-01-01', to: '2025-01-01' }, 'all', NOW),
    );
    expect(error).toMatchObject({
      code: LOTTERY_ERRORS.ANALYTICS_RANGE_TOO_LONG,
      status: 400,
      extra: { days: 367, maxDays: 366 },
    });
  });
});

describe('bucketKeys — zero-fill keys per view', () => {
  const week = windowOf('2026-10-16', '2026-10-22');

  it('hourly: always the 24 hours "00".."23"', () => {
    const keys = bucketKeys('hourly', week);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('00');
    expect(keys[9]).toBe('09');
    expect(keys[23]).toBe('23');
    expect(keys).toEqual([...HOUR_KEYS]);
  });

  it('weekday: mon..sun', () => {
    expect(bucketKeys('weekday', week)).toEqual([
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
    ]);
    expect(WEEKDAY_KEYS).toHaveLength(7);
  });

  it('daily: every day of the window in order', () => {
    expect(bucketKeys('daily', week)).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
    expect(bucketKeys('daily', windowOf('2026-10-31', '2026-11-01'))).toEqual([
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('weekly: the Monday of every ISO week the window touches, the first one possibly before from', () => {
    expect(bucketKeys('weekly', week)).toEqual(['2026-10-12', '2026-10-19']);
    expect(bucketKeys('weekly', windowOf('2026-10-19', '2026-10-25'))).toEqual([
      '2026-10-19',
    ]);
    expect(bucketKeys('weekly', windowOf('2026-10-01', '2026-10-31'))).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
  });
});

describe('beforeCloseEdges', () => {
  const salesCloseAt = new Date('2026-11-01T06:30:00.000Z');

  it('cuts the 72 hours before close at 72, 48, 24, 12, 6 and 1 hours, ending at the close instant', () => {
    expect(beforeCloseEdges(salesCloseAt).map((d) => d.toISOString())).toEqual([
      '2026-10-29T06:30:00.000Z',
      '2026-10-30T06:30:00.000Z',
      '2026-10-31T06:30:00.000Z',
      '2026-10-31T18:30:00.000Z',
      '2026-11-01T00:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
  });

  it('every bin spans exactly the hours it advertises, and the six add up to 72', () => {
    const edges = beforeCloseEdges(salesCloseAt);
    BEFORE_CLOSE_BINS.forEach((bin, index) => {
      const spanHours =
        (edges[index + 1].getTime() - edges[index].getTime()) / 3_600_000;
      expect(spanHours).toBe(bin.hours);
    });
    expect(BEFORE_CLOSE_BINS.map((bin) => bin.key)).toEqual([
      '72-48h',
      '48-24h',
      '24-12h',
      '12-6h',
      '6-1h',
      'last-1h',
    ]);
    expect(BEFORE_CLOSE_BINS.reduce((sum, bin) => sum + bin.hours, 0)).toBe(72);
  });
});

describe('hasEarlierData', () => {
  it('is true only when the first purchase ever fell on or before previousFrom (as an MMT day)', () => {
    expect(hasEarlierData(null, '2026-10-09')).toBe(false);
    expect(
      hasEarlierData(new Date('2026-10-09T10:00:00.000Z'), '2026-10-09'),
    ).toBe(true);
    expect(
      hasEarlierData(new Date('2026-10-01T10:00:00.000Z'), '2026-10-09'),
    ).toBe(true);
    // 17:45 UTC on the 9th is already the 10th in Yangon.
    expect(
      hasEarlierData(new Date('2026-10-09T17:45:00.000Z'), '2026-10-09'),
    ).toBe(false);
    expect(
      hasEarlierData(new Date('2026-10-12T10:00:00.000Z'), '2026-10-09'),
    ).toBe(false);
  });
});

describe('number formatting', () => {
  it('ksText: always two decimals, "0.00" for nothing', () => {
    expect(ksText(null)).toBe('0.00');
    expect(ksText(undefined)).toBe('0.00');
    expect(ksText('468000')).toBe('468000.00');
    expect(ksText('468000.5')).toBe('468000.50');
    expect(ksText(new Prisma.Decimal('12.345'))).toBe('12.35');
    expect(ksText(1000)).toBe('1000.00');
  });

  it('share: a four-place ratio, 0 for an empty whole', () => {
    expect(share(120, 1970)).toBe(0.0609);
    expect(share(0, 0)).toBe(0);
    expect(share(5, 0)).toBe(0);
    expect(share(1, 3)).toBe(0.3333);
  });

  it('changePct: (cur − prev) / prev, null without a previous figure', () => {
    expect(changePct(120, 100)).toBe(0.2);
    expect(changePct(80, 100)).toBe(-0.2);
    expect(changePct(100, 100)).toBe(0);
    expect(changePct(10, 0)).toBeNull();
  });
});
