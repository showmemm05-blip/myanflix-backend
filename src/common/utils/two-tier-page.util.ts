/**
 * Slices one logical page across the relevance sort's two disjoint tiers
 * (tier 1 = title matches, tier 2 = description-only matches — see
 * MoviesService.findAll's relevance path). Pure arithmetic so the boundary
 * cases are unit-testable without a database.
 *
 * The combined result list is conceptually tier1 rows (0..count1-1) followed
 * by tier2 rows; `offset`/`limit` address that combined list, and the return
 * value says what to skip/take from each tier's own query. `take` of 0 means
 * "don't query that tier at all".
 */
export interface TwoTierSlice {
  skip1: number;
  take1: number;
  skip2: number;
  take2: number;
}

export function computeTwoTierSlice(
  offset: number,
  limit: number,
  count1: number,
): TwoTierSlice {
  const skip1 = Math.min(offset, count1);
  const take1 = Math.max(0, Math.min(limit, count1 - offset));
  const skip2 = Math.max(0, offset - count1);
  const take2 = limit - take1;
  return { skip1, take1, skip2, take2 };
}
