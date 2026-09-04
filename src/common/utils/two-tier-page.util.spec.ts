import { computeTwoTierSlice } from './two-tier-page.util';

/**
 * The relevance sort serves one logical page spliced from two disjoint
 * per-tier queries; these are the four positions a page can occupy relative
 * to the tier boundary. In every case take1 + take2 === requested limit
 * (over-asking past the end is fine — findMany just returns fewer rows).
 */
describe('computeTwoTierSlice', () => {
  it('page fully inside tier 1', () => {
    // 30 title matches, first page of 10.
    expect(computeTwoTierSlice(0, 10, 30)).toEqual({
      skip1: 0,
      take1: 10,
      skip2: 0,
      take2: 0,
    });
  });

  it('page straddling the tier boundary', () => {
    // 15 title matches; page 2 of 10 takes rows 10..19 → 5 from each tier.
    expect(computeTwoTierSlice(10, 10, 15)).toEqual({
      skip1: 10,
      take1: 5,
      skip2: 0,
      take2: 5,
    });
  });

  it('page fully inside tier 2', () => {
    // 5 title matches; page 2 of 10 starts at combined offset 10 → tier2 offset 5.
    expect(computeTwoTierSlice(10, 10, 5)).toEqual({
      skip1: 5,
      take1: 0,
      skip2: 5,
      take2: 10,
    });
  });

  it('page past the end of both tiers still yields non-negative slices', () => {
    // 3 title matches, tier2 whatever — offset 100 is beyond everything.
    expect(computeTwoTierSlice(100, 10, 3)).toEqual({
      skip1: 3,
      take1: 0,
      skip2: 97,
      take2: 10,
    });
  });

  it('boundary exactly at the page start (tier1 consumed by earlier pages)', () => {
    // count1 === offset: nothing left in tier 1, tier 2 starts fresh.
    expect(computeTwoTierSlice(10, 10, 10)).toEqual({
      skip1: 10,
      take1: 0,
      skip2: 0,
      take2: 10,
    });
  });

  it('never asks a tier for a negative count', () => {
    for (const [offset, limit, count1] of [
      [0, 10, 0],
      [50, 30, 7],
      [7, 1, 7],
      [0, 100, 100],
    ] as const) {
      const s = computeTwoTierSlice(offset, limit, count1);
      expect(s.skip1).toBeGreaterThanOrEqual(0);
      expect(s.take1).toBeGreaterThanOrEqual(0);
      expect(s.skip2).toBeGreaterThanOrEqual(0);
      expect(s.take2).toBeGreaterThanOrEqual(0);
      expect(s.take1 + s.take2).toBe(limit);
    }
  });
});
