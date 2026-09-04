import {
  MAX_DURATION_MINUTES,
  normaliseDurationSeconds,
  secondsToMinutes,
} from './duration.util';

describe('secondsToMinutes', () => {
  // The same table lives in admin/lib/upload/probe-duration.ts — the browser
  // probe and the server must agree on every one of these.
  it.each([
    [40, 1], // floor at 1 — 0 is the unknown sentinel
    [60, 1],
    [5399, 90], // 89:59 rounds down
    [5430, 91], // 90.5 rounds up
    [MAX_DURATION_MINUTES * 60, MAX_DURATION_MINUTES],
  ])('%p seconds -> %p minutes', (seconds, minutes) => {
    expect(secondsToMinutes(seconds)).toBe(minutes);
  });

  it.each([
    [0],
    [-1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
    [MAX_DURATION_MINUTES * 60 + 1], // over the 100 h sanity bound
  ])('%p is unusable and maps to null', (seconds) => {
    expect(secondsToMinutes(seconds)).toBeNull();
  });
});

describe('normaliseDurationSeconds', () => {
  it('rounds to the integer seconds Video.duration stores', () => {
    expect(normaliseDurationSeconds(5430.4)).toBe(5430);
    expect(normaliseDurationSeconds(5430.5)).toBe(5431);
    expect(normaliseDurationSeconds(MAX_DURATION_MINUTES * 60)).toBe(
      MAX_DURATION_MINUTES * 60,
    );
  });

  it.each([
    [0],
    [-1],
    [0.2], // rounds to 0, which would read as "measured, empty"
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
    [MAX_DURATION_MINUTES * 60 + 1],
  ])('%p is unusable and maps to null', (seconds) => {
    expect(normaliseDurationSeconds(seconds)).toBeNull();
  });
});
