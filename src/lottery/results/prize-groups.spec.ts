import { makeSheet, sheetInputs } from '../../../test/lottery-fixtures';
import {
  checkPrizeGroups,
  isCompletePrizeSheet,
  isPrizeGroupKey,
  nearFirstOf,
  normalizePrizeGroups,
  parseStoredPrizeGroups,
  PRIZE_BAHT_MAX,
  PRIZE_GROUP_KEYS,
  PRIZE_GROUP_SPECS,
  PRIZE_SHEET_NUMBER_COUNT,
} from './prize-groups';

describe('prize groups', () => {
  it('declares the nine Thai groups in the fixed order, 173 numbers in all', () => {
    expect(PRIZE_GROUP_KEYS).toEqual([
      'first',
      'nearFirst',
      'second',
      'third',
      'fourth',
      'fifth',
      'front3',
      'back3',
      'back2',
    ]);
    expect(PRIZE_SHEET_NUMBER_COUNT).toBe(173);
    expect(
      PRIZE_GROUP_KEYS.map((key) => {
        const { count, digits, match } = PRIZE_GROUP_SPECS[key];
        return `${key}:${count}x${digits}:${match}`;
      }),
    ).toEqual([
      'first:1x6:full',
      'nearFirst:2x6:full',
      'second:5x6:full',
      'third:10x6:full',
      'fourth:50x6:full',
      'fifth:100x6:full',
      'front3:2x3:front',
      'back3:2x3:back',
      'back2:1x2:back',
    ]);
    expect(isPrizeGroupKey('front3')).toBe(true);
    expect(isPrizeGroupKey('sixth')).toBe(false);
    expect(isPrizeGroupKey(3)).toBe(false);
  });

  describe('nearFirstOf', () => {
    it('is the first prize ± 1, zero-padded', () => {
      expect(nearFirstOf('123456')).toEqual(['123455', '123457']);
      expect(nearFirstOf('000010')).toEqual(['000009', '000011']);
    });

    it('wraps at both ends', () => {
      expect(nearFirstOf('000000')).toEqual(['999999', '000001']);
      expect(nearFirstOf('999999')).toEqual(['999998', '000000']);
    });
  });

  describe('checkPrizeGroups', () => {
    it('passes a full sheet with no errors and no warnings', () => {
      expect(checkPrizeGroups(sheetInputs())).toEqual({
        errors: [],
        warnings: [],
      });
      expect(isCompletePrizeSheet(makeSheet())).toBe(true);
    });

    it('reports a wrong count, a wrong digit length and a bad prize, naming the group', () => {
      const { errors } = checkPrizeGroups(
        sheetInputs({
          second: { numbers: ['200100', '208019'] },
          front3: { numbers: ['12', '9876'] },
          back2: { baht: -1 },
        }),
      );
      expect(errors).toEqual([
        'Second prize: expected 5 numbers, got 2',
        'Front 3 digits: every number must be exactly 3 digits (12, 9876)',
        'Back 2 digits: the Baht prize must be a number of 0 or more',
      ]);
    });

    it('reports a missing group, an unknown group and a group listed twice', () => {
      const inputs = sheetInputs().filter((group) => group.key !== 'third');
      const { errors } = checkPrizeGroups([
        ...inputs,
        { key: 'sixth', baht: 1, numbers: ['000001'] },
        { key: 'first', baht: 1, numbers: ['000002'] },
      ]);
      expect(errors).toEqual([
        'Unknown prize group "sixth"',
        'Prize group "first" is listed twice',
        'Missing prize group "third"',
      ]);
    });

    it('counts a number with a space around it as its trimmed self, but not a letter', () => {
      expect(
        checkPrizeGroups(sheetInputs({ back2: { numbers: [' 56 '] } })).errors,
      ).toEqual([]);
      expect(
        checkPrizeGroups(sheetInputs({ back2: { numbers: ['5a'] } })).errors,
      ).toEqual(['Back 2 digits: every number must be exactly 2 digits (5a)']);
    });

    it('warns — never fails — when the near-first numbers are not the first prize ± 1', () => {
      const check = checkPrizeGroups(
        sheetInputs({ nearFirst: { numbers: ['111111', '222222'] } }),
      );
      expect(check.errors).toEqual([]);
      expect(check.warnings).toEqual([
        'Near first prize numbers 111111 / 222222 are not the first prize ± 1 (123455 / 123457)',
      ]);
    });

    it('accepts the near-first pair in either order, wrapped ones included', () => {
      expect(
        checkPrizeGroups(
          sheetInputs({ nearFirst: { numbers: ['123457', '123455'] } }),
        ).warnings,
      ).toEqual([]);
      expect(
        checkPrizeGroups(
          sheetInputs({
            first: { numbers: ['000000'] },
            nearFirst: { numbers: ['000001', '999999'] },
          }),
        ).warnings,
      ).toEqual([]);
    });

    it('skips the near-first check while the sheet has errors', () => {
      const check = checkPrizeGroups(
        sheetInputs({
          first: { numbers: [] },
          nearFirst: { numbers: ['111111', '222222'] },
        }),
      );
      expect(check.errors).toEqual(['First prize: expected 1 number, got 0']);
      expect(check.warnings).toEqual([]);
    });

    it('refuses a NaN or infinite prize', () => {
      expect(
        checkPrizeGroups(sheetInputs({ first: { baht: Number.NaN } })).errors,
      ).toEqual(['First prize: the Baht prize must be a number of 0 or more']);
      expect(
        checkPrizeGroups(sheetInputs({ first: { baht: Infinity } })).errors,
      ).toHaveLength(1);
    });

    it('refuses a prize past the Baht ceiling (the payouts column), and takes the ceiling itself', () => {
      expect(PRIZE_BAHT_MAX).toBe(9_999_999_999.99);
      expect(
        checkPrizeGroups(sheetInputs({ first: { baht: 1e13 } })).errors,
      ).toEqual(['First prize: the Baht prize must be at most 9999999999.99']);
      expect(
        checkPrizeGroups(sheetInputs({ first: { baht: PRIZE_BAHT_MAX } }))
          .errors,
      ).toEqual([]);
    });
  });

  describe('normalizePrizeGroups', () => {
    it('orders the groups, fills name / count / digits from the spec and trims the numbers', () => {
      const reversed = [...sheetInputs()].reverse();
      reversed[reversed.length - 1] = {
        key: 'first',
        baht: 6_000_000,
        numbers: [' 123456 '],
      };
      const groups = normalizePrizeGroups(reversed);
      expect(groups.map((group) => group.key)).toEqual([...PRIZE_GROUP_KEYS]);
      expect(groups[0]).toEqual({
        key: 'first',
        name: 'First prize',
        baht: 6_000_000,
        count: 1,
        digits: 6,
        numbers: ['123456'],
      });
      expect(groups[8]).toEqual({
        key: 'back2',
        name: 'Back 2 digits',
        baht: 2_000,
        count: 1,
        digits: 2,
        numbers: ['56'],
      });
    });

    it('fills a missing group as empty (0 Baht, no numbers) and ignores a repeat', () => {
      const groups = normalizePrizeGroups([
        { key: 'first', baht: 1, numbers: ['000001'] },
        { key: 'first', baht: 2, numbers: ['000002'] },
      ]);
      expect(groups).toHaveLength(9);
      expect(groups[0]).toEqual(
        expect.objectContaining({ baht: 1, numbers: ['000001'] }),
      );
      expect(groups[1]).toEqual(
        expect.objectContaining({ key: 'nearFirst', baht: 0, numbers: [] }),
      );
      expect(isCompletePrizeSheet(groups)).toBe(false);
    });
  });

  describe('parseStoredPrizeGroups', () => {
    it('reads a stored sheet back, re-deriving name / count / digits from the key', () => {
      const stored = makeSheet().map(({ key, baht, numbers }) => ({
        key,
        baht,
        numbers,
        name: 'stale',
      }));
      expect(parseStoredPrizeGroups(stored)).toEqual(makeSheet());
    });

    it('reads anything that is not a well-formed sheet as an empty one', () => {
      expect(parseStoredPrizeGroups(null)).toEqual([]);
      expect(parseStoredPrizeGroups('[]')).toEqual([]);
      expect(parseStoredPrizeGroups([])).toEqual([]);
      expect(
        parseStoredPrizeGroups([{ key: 'first', baht: '1', numbers: [] }]),
      ).toEqual([]);
      expect(
        parseStoredPrizeGroups([{ key: 'first', baht: 1, numbers: [1] }]),
      ).toEqual([]);
      expect(
        parseStoredPrizeGroups([{ key: 'nope', baht: 1, numbers: [] }]),
      ).toEqual([]);
      expect(parseStoredPrizeGroups(['first'])).toEqual([]);
    });
  });
});
