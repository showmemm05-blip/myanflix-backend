import { LOTTERY_NUMBER_DIGITS } from '../lottery-numbers';

/**
 * The nine prize groups of a Thai Government Lottery draw, in the fixed
 * order every sheet, view and audit row uses (lottery backend phase 3).
 * 173 numbers in all: 1 + 2 + 5 + 10 + 50 + 100 six-digit numbers, two
 * three-digit numbers matched against the FIRST three digits of a ticket,
 * two matched against the LAST three, and one two-digit number matched
 * against the LAST two.
 */
export const PRIZE_GROUP_KEYS = [
  'first',
  'nearFirst',
  'second',
  'third',
  'fourth',
  'fifth',
  'front3',
  'back3',
  'back2',
] as const;

export type PrizeGroupKey = (typeof PRIZE_GROUP_KEYS)[number];

/** How a group's numbers are compared with a six-digit ticket number. */
export type PrizeMatchKind = 'full' | 'front' | 'back';

export interface PrizeGroupSpec {
  key: PrizeGroupKey;
  name: string;
  /** How many numbers the group holds in a real draw. */
  count: number;
  /** How many digits each of its numbers has. */
  digits: number;
  match: PrizeMatchKind;
}

export const PRIZE_GROUP_SPECS: Readonly<
  Record<PrizeGroupKey, PrizeGroupSpec>
> = {
  first: {
    key: 'first',
    name: 'First prize',
    count: 1,
    digits: 6,
    match: 'full',
  },
  nearFirst: {
    key: 'nearFirst',
    name: 'Near first prize',
    count: 2,
    digits: 6,
    match: 'full',
  },
  second: {
    key: 'second',
    name: 'Second prize',
    count: 5,
    digits: 6,
    match: 'full',
  },
  third: {
    key: 'third',
    name: 'Third prize',
    count: 10,
    digits: 6,
    match: 'full',
  },
  fourth: {
    key: 'fourth',
    name: 'Fourth prize',
    count: 50,
    digits: 6,
    match: 'full',
  },
  fifth: {
    key: 'fifth',
    name: 'Fifth prize',
    count: 100,
    digits: 6,
    match: 'full',
  },
  front3: {
    key: 'front3',
    name: 'Front 3 digits',
    count: 2,
    digits: 3,
    match: 'front',
  },
  back3: {
    key: 'back3',
    name: 'Back 3 digits',
    count: 2,
    digits: 3,
    match: 'back',
  },
  back2: {
    key: 'back2',
    name: 'Back 2 digits',
    count: 1,
    digits: 2,
    match: 'back',
  },
};

/** The 173 numbers of a full sheet. */
export const PRIZE_SHEET_NUMBER_COUNT = PRIZE_GROUP_KEYS.reduce(
  (sum, key) => sum + PRIZE_GROUP_SPECS[key].count,
  0,
);

/**
 * The most Baht one group may pay per number: the Decimal(12,2) ceiling
 * of lottery_payouts.baht, shared by the manual-entry DTO and the API
 * parser so a source's "99999999999999" is refused instead of stored (the
 * first prize is 6,000,000).
 */
export const PRIZE_BAHT_MAX = 9_999_999_999.99;

/** One group of a sheet as stored in lottery_results.groups and sent to the admin / the apps. */
export interface PrizeGroup {
  key: PrizeGroupKey;
  name: string;
  /** The Thai prize per number, in Baht. */
  baht: number;
  count: number;
  digits: number;
  numbers: string[];
}

/** What a caller supplies for one group: the key, the Baht prize and the numbers; the rest comes from the spec. */
export interface PrizeGroupInput {
  key: string;
  baht: number;
  numbers: readonly string[];
}

export interface PrizeGroupCheck {
  /** Problems that make the sheet unusable (a wrong count, a wrong digit length, an unknown key …). */
  errors: string[];
  /** Oddities worth a look that do not block (near-first numbers that are not first ± 1). */
  warnings: string[];
}

export function isPrizeGroupKey(value: unknown): value is PrizeGroupKey {
  return (
    typeof value === 'string' &&
    (PRIZE_GROUP_KEYS as readonly string[]).includes(value)
  );
}

/** "000000" ± 1 wraps: the two near-first numbers of 000000 are 999999 and 000001. */
export function nearFirstOf(first: string): [string, string] {
  const modulus = 10 ** LOTTERY_NUMBER_DIGITS;
  const value = Number(first);
  const pad = (n: number) =>
    String(((n % modulus) + modulus) % modulus).padStart(
      LOTTERY_NUMBER_DIGITS,
      '0',
    );
  return [pad(value - 1), pad(value + 1)];
}

/**
 * Builds the stored sheet from a caller's groups: every key exactly once,
 * each group's name / count / digits from the spec, numbers trimmed, in
 * the fixed order. The result is only meaningful when `checkPrizeGroups`
 * on it reports no errors — the two are split so a caller can show every
 * problem at once instead of the first.
 */
export function normalizePrizeGroups(
  input: readonly PrizeGroupInput[],
): PrizeGroup[] {
  const byKey = new Map<string, PrizeGroupInput>();
  for (const group of input) {
    if (!byKey.has(group.key)) byKey.set(group.key, group);
  }
  return PRIZE_GROUP_KEYS.map((key) => {
    const spec = PRIZE_GROUP_SPECS[key];
    const given = byKey.get(key);
    return {
      key,
      name: spec.name,
      baht: given ? given.baht : 0,
      count: spec.count,
      digits: spec.digits,
      numbers: given ? given.numbers.map((number) => number.trim()) : [],
    };
  });
}

/**
 * The checks a sheet must pass before it can be published: exactly the
 * nine known keys, the right number of numbers in every group, every
 * number exactly the group's digits (leading zeros included), a finite
 * Baht prize from 0 to PRIZE_BAHT_MAX. Near-first numbers that are not first ± 1 are a warning
 * only — the source is right by definition, this just flags a typo.
 */
export function checkPrizeGroups(
  input: readonly PrizeGroupInput[],
): PrizeGroupCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const group of input) {
    if (!isPrizeGroupKey(group.key)) {
      errors.push(`Unknown prize group "${group.key}"`);
      continue;
    }
    if (seen.has(group.key)) {
      errors.push(`Prize group "${group.key}" is listed twice`);
      continue;
    }
    seen.add(group.key);
    const spec = PRIZE_GROUP_SPECS[group.key];
    if (!Number.isFinite(group.baht) || group.baht < 0) {
      errors.push(`${spec.name}: the Baht prize must be a number of 0 or more`);
    } else if (group.baht > PRIZE_BAHT_MAX) {
      errors.push(
        `${spec.name}: the Baht prize must be at most ${PRIZE_BAHT_MAX}`,
      );
    }
    if (group.numbers.length !== spec.count) {
      errors.push(
        `${spec.name}: expected ${spec.count} number${
          spec.count === 1 ? '' : 's'
        }, got ${group.numbers.length}`,
      );
    }
    const pattern = new RegExp(`^\\d{${spec.digits}}$`);
    const bad = group.numbers.filter((number) => !pattern.test(number.trim()));
    if (bad.length > 0) {
      errors.push(
        `${spec.name}: every number must be exactly ${spec.digits} digits (${bad
          .slice(0, 5)
          .join(', ')})`,
      );
    }
  }
  for (const key of PRIZE_GROUP_KEYS) {
    if (!seen.has(key)) errors.push(`Missing prize group "${key}"`);
  }

  if (errors.length === 0) {
    const first = input.find((group) => group.key === 'first');
    const near = input.find((group) => group.key === 'nearFirst');
    if (first && near) {
      const expected = [...nearFirstOf(first.numbers[0].trim())].sort();
      const given = near.numbers.map((number) => number.trim()).sort();
      if (given[0] !== expected[0] || given[1] !== expected[1]) {
        warnings.push(
          `Near first prize numbers ${given.join(' / ')} are not the first prize ± 1 (${expected.join(' / ')})`,
        );
      }
    }
  }
  return { errors, warnings };
}

/** True for a sheet that passes every check — what FETCHED and publish require. */
export function isCompletePrizeSheet(groups: readonly PrizeGroup[]): boolean {
  return checkPrizeGroups(groups).errors.length === 0;
}

/**
 * Reads lottery_results.groups (a Json column) back as a sheet. Anything
 * that is not an array of well-formed groups reads as an empty sheet —
 * the column is only ever written by this module, so this guards a hand
 * edit, never real data.
 */
export function parseStoredPrizeGroups(value: unknown): PrizeGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: PrizeGroup[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return [];
    const group = item as Record<string, unknown>;
    if (
      !isPrizeGroupKey(group.key) ||
      typeof group.baht !== 'number' ||
      !Array.isArray(group.numbers) ||
      !group.numbers.every((number) => typeof number === 'string')
    ) {
      return [];
    }
    const spec = PRIZE_GROUP_SPECS[group.key];
    groups.push({
      key: group.key,
      name: spec.name,
      baht: group.baht,
      count: spec.count,
      digits: spec.digits,
      numbers: [...group.numbers],
    });
  }
  return groups;
}
