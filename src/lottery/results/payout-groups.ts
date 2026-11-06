import {
  LotteryTicketStatus,
  type Prisma,
} from '../../generated/prisma/client';
import {
  isPrizeGroupKey,
  PRIZE_GROUP_KEYS,
  PRIZE_GROUP_SPECS,
  type PrizeGroupKey,
} from './prize-groups';
import type { TicketWinKs } from './prize-matcher';

/** One group a paid ticket won, as stored in lottery_payouts.groups. */
export type PayoutGroup = TicketWinKs;

/** A group on a ticket's wire (`wonGroups`): the key, the group's name and the Ks it paid. */
export interface TicketWonGroup {
  key: PrizeGroupKey;
  name: string;
  ks: number;
}

/** A group on an admin winner row: the key, the Baht and the Ks it paid. */
export interface WinnerGroup {
  key: PrizeGroupKey;
  baht: number;
  ks: number;
}

/** The lottery_payouts.groups value for the `groups` Json column (always an array). */
export function payoutGroupsJson(
  groups: readonly PayoutGroup[],
): Prisma.InputJsonValue {
  return groups as unknown as Prisma.InputJsonValue;
}

/**
 * Reads lottery_payouts.groups (a Json column) back. Anything that is
 * not an array of well-formed wins reads as no groups — the column is
 * only ever written by the publish service, so this guards a hand edit,
 * never real data. The name is re-read from the spec so a renamed group
 * reads the same everywhere.
 */
export function parseStoredPayoutGroups(value: unknown): PayoutGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: PayoutGroup[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return [];
    const group = item as Record<string, unknown>;
    if (
      !isPrizeGroupKey(group.key) ||
      typeof group.baht !== 'number' ||
      typeof group.ks !== 'number'
    ) {
      return [];
    }
    groups.push({
      key: group.key,
      name: PRIZE_GROUP_SPECS[group.key].name,
      baht: group.baht,
      ks: group.ks,
    });
  }
  return groups;
}

/**
 * A ticket's `wonGroups` on the wire: null while the ticket WAITS for the
 * results, [] once settled without a prize, else the groups it won in
 * the fixed order (what the phone's My tickets / TicketView read, and the
 * admin ticket rows' tooltip).
 */
export function wonGroupsOf(
  status: LotteryTicketStatus,
  payout: { groups: unknown } | null | undefined,
): TicketWonGroup[] | null {
  if (status === LotteryTicketStatus.WAITING) return null;
  if (status !== LotteryTicketStatus.WON || !payout) return [];
  return parseStoredPayoutGroups(payout.groups).map(({ key, name, ks }) => ({
    key,
    name,
    ks,
  }));
}

/** The same groups as the admin winner rows carry them. */
export function winnerGroupsOf(groups: readonly PayoutGroup[]): WinnerGroup[] {
  return groups.map(({ key, baht, ks }) => ({ key, baht, ks }));
}

/**
 * The one group a winning ticket is listed under on the public winners
 * list: the biggest Baht prize it won (the first in the fixed order on a
 * tie). Null for an empty list (never stored, but a hand edit reads so).
 */
export function headlineGroup(
  groups: readonly PayoutGroup[],
): PayoutGroup | null {
  let best: PayoutGroup | null = null;
  for (const group of groups) {
    if (
      best === null ||
      group.baht > best.baht ||
      (group.baht === best.baht &&
        PRIZE_GROUP_KEYS.indexOf(group.key) <
          PRIZE_GROUP_KEYS.indexOf(best.key))
    ) {
      best = group;
    }
  }
  return best;
}
