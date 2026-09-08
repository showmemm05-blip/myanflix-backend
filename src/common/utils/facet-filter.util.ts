/**
 * 1-vs-many rule for a string facet: a single value keeps today's legacy
 * `?genre=` behavior (exact match, case-proof); two or more use `in` with
 * exact casing, which is safe because multi-values only ever come from the
 * facets endpoint (they are real DB spellings, not user input).
 */
export function facetStringFilter(
  values: string[],
): { equals: string; mode: 'insensitive' } | { in: string[] } | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return { equals: values[0], mode: 'insensitive' };
  return { in: values };
}

/**
 * gte/lte range with swapped bounds normalized (from > to is treated as the
 * user dragging the handles past each other, not an empty set).
 */
export function numberRange(
  from: number | undefined,
  to: number | undefined,
): { gte?: number; lte?: number } | undefined {
  if (from === undefined && to === undefined) return undefined;
  if (from !== undefined && to !== undefined && from > to)
    [from, to] = [to, from];
  return {
    ...(from !== undefined ? { gte: from } : {}),
    ...(to !== undefined ? { lte: to } : {}),
  };
}
