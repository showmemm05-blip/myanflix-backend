import { LotteryTicketStatus } from '../../generated/prisma/client';
import {
  headlineGroup,
  parseStoredPayoutGroups,
  payoutGroupsJson,
  winnerGroupsOf,
  wonGroupsOf,
  type PayoutGroup,
} from './payout-groups';

const FIRST: PayoutGroup = {
  key: 'first',
  name: 'First prize',
  baht: 6_000_000,
  ks: 450_000_000,
};
const BACK3: PayoutGroup = {
  key: 'back3',
  name: 'Back 3 digits',
  baht: 4000,
  ks: 300_000,
};
const FRONT3: PayoutGroup = {
  key: 'front3',
  name: 'Front 3 digits',
  baht: 4000,
  ks: 300_000,
};

describe('payout groups', () => {
  describe('parseStoredPayoutGroups', () => {
    it('reads a stored list back, taking the name from the spec', () => {
      expect(
        parseStoredPayoutGroups([
          { key: 'first', name: 'whatever', baht: 6_000_000, ks: 450_000_000 },
          { key: 'back3', baht: 4000, ks: 300_000 },
        ]),
      ).toEqual([FIRST, BACK3]);
    });

    it('reads anything malformed as no groups', () => {
      expect(parseStoredPayoutGroups(null)).toEqual([]);
      expect(parseStoredPayoutGroups('first')).toEqual([]);
      expect(parseStoredPayoutGroups([null])).toEqual([]);
      expect(
        parseStoredPayoutGroups([{ key: 'sixth', baht: 1, ks: 1 }]),
      ).toEqual([]);
      expect(
        parseStoredPayoutGroups([{ key: 'first', baht: '1', ks: 1 }]),
      ).toEqual([]);
      expect(parseStoredPayoutGroups([{ key: 'first', baht: 1 }])).toEqual([]);
      expect(parseStoredPayoutGroups([FIRST, { key: 'x' }])).toEqual([]);
    });

    it('round-trips through the Json column value', () => {
      expect(parseStoredPayoutGroups(payoutGroupsJson([FIRST, BACK3]))).toEqual(
        [FIRST, BACK3],
      );
    });
  });

  describe('wonGroupsOf', () => {
    it('is null while the ticket waits, whatever the payout', () => {
      expect(wonGroupsOf(LotteryTicketStatus.WAITING, null)).toBeNull();
      expect(
        wonGroupsOf(LotteryTicketStatus.WAITING, { groups: [FIRST] }),
      ).toBeNull();
    });

    it('is empty for a ticket that did not win, and for a WON ticket with no payout row', () => {
      expect(wonGroupsOf(LotteryTicketStatus.NOT_WON, null)).toEqual([]);
      expect(
        wonGroupsOf(LotteryTicketStatus.NOT_WON, { groups: [FIRST] }),
      ).toEqual([]);
      expect(wonGroupsOf(LotteryTicketStatus.WON, null)).toEqual([]);
      expect(wonGroupsOf(LotteryTicketStatus.WON, undefined)).toEqual([]);
    });

    it('lists the groups a WON ticket was paid for: key, name and Ks only', () => {
      expect(
        wonGroupsOf(LotteryTicketStatus.WON, { groups: [FIRST, BACK3] }),
      ).toEqual([
        { key: 'first', name: 'First prize', ks: 450_000_000 },
        { key: 'back3', name: 'Back 3 digits', ks: 300_000 },
      ]);
    });
  });

  it('winnerGroupsOf keeps the key, the Baht and the Ks', () => {
    expect(winnerGroupsOf([FIRST, BACK3])).toEqual([
      { key: 'first', baht: 6_000_000, ks: 450_000_000 },
      { key: 'back3', baht: 4000, ks: 300_000 },
    ]);
  });

  describe('headlineGroup', () => {
    it('is the biggest Baht prize the ticket won', () => {
      expect(headlineGroup([BACK3, FIRST])).toEqual(FIRST);
      expect(headlineGroup([BACK3])).toEqual(BACK3);
    });

    it('breaks a tie by the fixed group order', () => {
      expect(headlineGroup([BACK3, FRONT3])).toEqual(FRONT3);
      expect(headlineGroup([FRONT3, BACK3])).toEqual(FRONT3);
    });

    it('is null for no groups', () => {
      expect(headlineGroup([])).toBeNull();
    });
  });
});
