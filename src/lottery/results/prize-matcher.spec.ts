import { Prisma } from '../../generated/prisma/client';
import { makeSheet } from '../../../test/lottery-fixtures';
import {
  bahtToKs,
  groupsWithKs,
  matchTicket,
  prizeBahtOf,
  ticketPrize,
  winsWithKs,
} from './prize-matcher';

/**
 * The sheet: first 123456 (near 123455 / 123457), second 200100 …,
 * front3 123 / 987, back3 456 / 001, back2 56.
 */
const SHEET = makeSheet();

const keysOf = (number: string) =>
  matchTicket(number, SHEET).map((win) => win.key);

describe('matchTicket', () => {
  it('wins the first prize, the front 3, the back 3 and the back 2 at once on the first-prize number', () => {
    expect(matchTicket('123456', SHEET)).toEqual([
      { key: 'first', name: 'First prize', baht: 6_000_000 },
      { key: 'front3', name: 'Front 3 digits', baht: 4_000 },
      { key: 'back3', name: 'Back 3 digits', baht: 4_000 },
      { key: 'back2', name: 'Back 2 digits', baht: 2_000 },
    ]);
  });

  it('matches the near-first numbers as a full six-digit match, each with its own front / back wins', () => {
    expect(keysOf('123455')).toEqual(['nearFirst', 'front3']);
    expect(keysOf('123457')).toEqual(['nearFirst', 'front3']);
  });

  it('matches front3 on the FIRST three digits only', () => {
    expect(keysOf('123000')).toEqual(['front3']);
    expect(keysOf('987654')).toEqual(['front3']);
    expect(keysOf('000123')).toEqual([]);
    expect(keysOf('001230')).toEqual([]);
  });

  it('matches back3 on the LAST three digits only', () => {
    expect(keysOf('000456')).toEqual(['back3', 'back2']);
    expect(keysOf('999001')).toEqual(['back3']);
    expect(keysOf('456000')).toEqual([]);
    expect(keysOf('004560')).toEqual([]);
  });

  it('matches back2 on the LAST two digits only', () => {
    expect(keysOf('000056')).toEqual(['back2']);
    expect(keysOf('560000')).toEqual([]);
    expect(keysOf('005600')).toEqual([]);
  });

  it('keeps leading zeros significant', () => {
    const sheet = makeSheet({
      first: { numbers: ['000001'] },
      nearFirst: { numbers: ['000000', '000002'] },
      front3: { numbers: ['000', '010'] },
      back3: { numbers: ['001', '100'] },
      back2: { numbers: ['01'] },
    });
    expect(matchTicket('000001', sheet).map((w) => w.key)).toEqual([
      'first',
      'front3',
      'back3',
      'back2',
    ]);
    expect(matchTicket('000000', sheet).map((w) => w.key)).toEqual([
      'nearFirst',
      'front3',
    ]);
    expect(matchTicket('010100', sheet).map((w) => w.key)).toEqual([
      'front3',
      'back3',
    ]);
    expect(matchTicket('100001', sheet).map((w) => w.key)).toEqual([
      'back3',
      'back2',
    ]);
  });

  it('matches every six-digit group in full, never on a prefix or suffix', () => {
    expect(keysOf('200100')).toEqual(['second']);
    expect(keysOf('300100')).toEqual(['third']);
    expect(keysOf('400100')).toEqual(['fourth']);
    expect(keysOf('500100')).toEqual(['fifth']);
    expect(keysOf('200101')).toEqual([]);
  });

  it('pays a number drawn twice in the same group twice', () => {
    const sheet = makeSheet({ front3: { numbers: ['123', '123'] } });
    expect(matchTicket('123999', sheet)).toEqual([
      { key: 'front3', name: 'Front 3 digits', baht: 4_000 },
      { key: 'front3', name: 'Front 3 digits', baht: 4_000 },
    ]);
  });

  it('does not care which order the sheet lists its groups in', () => {
    const shuffled = [...SHEET].reverse();
    expect(matchTicket('123456', shuffled).map((w) => w.key)).toEqual([
      'first',
      'front3',
      'back3',
      'back2',
    ]);
  });

  it('wins nothing on an empty sheet, a partial sheet without the group, or a malformed number', () => {
    expect(matchTicket('123456', [])).toEqual([]);
    expect(
      matchTicket(
        '123456',
        SHEET.filter((group) => group.key !== 'first'),
      ).map((w) => w.key),
    ).toEqual(['front3', 'back3', 'back2']);
    expect(matchTicket('12345', SHEET)).toEqual([]);
    expect(matchTicket('1234567', SHEET)).toEqual([]);
    expect(matchTicket('12345a', SHEET)).toEqual([]);
    expect(matchTicket('', SHEET)).toEqual([]);
  });

  it('wins nothing on a plain losing number', () => {
    expect(keysOf('777777')).toEqual([]);
  });
});

describe('prize arithmetic', () => {
  it('adds the Baht of every win', () => {
    expect(prizeBahtOf(matchTicket('123456', SHEET))).toBe(6_010_000);
    expect(prizeBahtOf([])).toBe(0);
  });

  it('converts Baht to Ks at the rate as a 2 dp Decimal, half up', () => {
    expect(bahtToKs(6_000_000, 75).toString()).toBe('450000000');
    expect(bahtToKs(2_000, new Prisma.Decimal('75.1234')).toString()).toBe(
      '150246.8',
    );
    expect(bahtToKs(1, new Prisma.Decimal('0.005')).toString()).toBe('0.01');
    expect(bahtToKs(1, new Prisma.Decimal('0.004')).toString()).toBe('0');
    expect(bahtToKs(0, 75).toString()).toBe('0');
    expect(
      bahtToKs(new Prisma.Decimal('4000'), '0.5' as never).toString(),
    ).toBe('2000');
  });

  it('ticketPrize gives the wins, the Baht total and the Ks total', () => {
    expect(ticketPrize('123456', SHEET, 75)).toEqual({
      wins: matchTicket('123456', SHEET),
      baht: 6_010_000,
      ks: new Prisma.Decimal('450750000'),
    });
    expect(ticketPrize('777777', SHEET, 75)).toEqual({
      wins: [],
      baht: 0,
      ks: new Prisma.Decimal(0),
    });
  });

  it('ticketPrize adds the per-group Ks as stored, so a ticket’s prize equals the sum of its wonGroups to the satang', () => {
    // 0.01 Baht in two groups at 75.5: each 0.755 → 0.76; the sum of the
    // rounded figures is 1.52, while rounding the summed 0.02 × 75.5 = 1.51
    // would miss the groups the ticket shows by a satang.
    const sheet = makeSheet({
      first: { numbers: ['000000'] },
      back3: { numbers: ['999', '998'] },
      front3: { baht: 0.01 },
      back2: { baht: 0.01 },
    });
    const rate = new Prisma.Decimal('75.5');
    const prize = ticketPrize('123456', sheet, rate);
    expect(prize.wins.map((win) => win.key)).toEqual(['front3', 'back2']);
    expect(prize.baht).toBeCloseTo(0.02, 10);
    expect(prize.ks.toString()).toBe('1.52');
    expect(
      winsWithKs(prize.wins, rate).reduce((sum, win) => sum + win.ks, 0),
    ).toBe(prize.ks.toNumber());
    // The real Thai prizes are whole thousands of Baht: unchanged.
    expect(ticketPrize('123456', makeSheet(), 75.5).ks.toString()).toBe(
      '453755000',
    );
  });

  it('winsWithKs prices every win and groupsWithKs every group, with null when no rate is known', () => {
    expect(winsWithKs(matchTicket('000456', SHEET), 75)).toEqual([
      { key: 'back3', name: 'Back 3 digits', baht: 4_000, ks: 300_000 },
      { key: 'back2', name: 'Back 2 digits', baht: 2_000, ks: 150_000 },
    ]);
    const priced = groupsWithKs(SHEET, new Prisma.Decimal('75.5'));
    expect(priced[0]).toEqual({ ...SHEET[0], ks: 453_000_000 });
    expect(priced[8]).toEqual({ ...SHEET[8], ks: 151_000 });
    expect(groupsWithKs(SHEET, null).map((group) => group.ks)).toEqual(
      Array.from({ length: 9 }, () => null),
    );
  });
});
