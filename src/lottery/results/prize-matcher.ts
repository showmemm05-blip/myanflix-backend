import { Prisma } from '../../generated/prisma/client';
import { LOTTERY_NUMBER_DIGITS } from '../lottery-numbers';
import {
  PRIZE_GROUP_KEYS,
  PRIZE_GROUP_SPECS,
  type PrizeGroup,
  type PrizeGroupKey,
} from './prize-groups';

/** One group a ticket won, with the Thai prize of that group. */
export interface TicketWin {
  key: PrizeGroupKey;
  name: string;
  baht: number;
}

/** A ticket's wins with the Ks each one pays at the draw's rate. */
export interface TicketWinKs extends TicketWin {
  ks: number;
}

/** What a ticket's wins add up to. */
export interface TicketPrize {
  wins: TicketWin[];
  baht: number;
  ks: Prisma.Decimal;
}

/**
 * The pure matcher (lottery backend phase 3): which prize groups one
 * six-digit ticket number wins on a sheet. Shared by the publish, its
 * dry run and the apps' "check my tickets", so every surface agrees.
 *
 * Rules: a six-digit group matches the whole number; front3 matches the
 * FIRST three digits; back3 the LAST three; back2 the LAST two. A ticket
 * can win in more than one group (123456 wins first AND back3 AND back2
 * when those are drawn) and the amounts add up. Within one group every
 * listed number is one prize, so a number drawn twice in the same group
 * pays twice — that is what the Thai structure says a repeat means.
 * Comparison is on the digit strings, so leading zeros count ("001234"
 * is not "1234"), and the groups' order on the sheet never matters: wins
 * come out in the fixed group order.
 */
export function matchTicket(
  number: string,
  groups: readonly PrizeGroup[],
): TicketWin[] {
  if (!new RegExp(`^\\d{${LOTTERY_NUMBER_DIGITS}}$`).test(number)) return [];
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const wins: TicketWin[] = [];
  for (const key of PRIZE_GROUP_KEYS) {
    const group = byKey.get(key);
    if (!group) continue;
    const spec = PRIZE_GROUP_SPECS[key];
    const part =
      spec.match === 'full'
        ? number
        : spec.match === 'front'
          ? number.slice(0, spec.digits)
          : number.slice(-spec.digits);
    for (const drawn of group.numbers) {
      if (drawn === part)
        wins.push({ key, name: group.name, baht: group.baht });
    }
  }
  return wins;
}

/** Σ baht of the wins. */
export function prizeBahtOf(wins: readonly TicketWin[]): number {
  return wins.reduce((sum, win) => sum + win.baht, 0);
}

/**
 * Baht × rate (Ks per Baht), rounded half-up to 2 dp as Decimal — the
 * figure that goes into lottery_payouts.ks, the wallet and the ticket.
 */
export function bahtToKs(
  baht: number | Prisma.Decimal,
  rate: number | Prisma.Decimal,
): Prisma.Decimal {
  return new Prisma.Decimal(baht)
    .mul(rate)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * The wins of one ticket and what they are worth at `rate`. The Ks is the
 * sum of the per-group figures (each rounded to the satang, as `winsWithKs`
 * stores them), not the rounded sum: a ticket's prizeKs then equals the
 * sum of its wonGroups' ks on every screen, which a hand-entered Baht
 * with decimals at a four-decimal rate would otherwise miss by 0.01.
 */
export function ticketPrize(
  number: string,
  groups: readonly PrizeGroup[],
  rate: number | Prisma.Decimal,
): TicketPrize {
  const wins = matchTicket(number, groups);
  const baht = prizeBahtOf(wins);
  const ks = wins.reduce(
    (sum, win) => sum.add(bahtToKs(win.baht, rate)),
    new Prisma.Decimal(0),
  );
  return { wins, baht, ks };
}

/** The wins with their Ks each, for a ticket's `wonGroups` and a payout's `groups`. */
export function winsWithKs(
  wins: readonly TicketWin[],
  rate: number | Prisma.Decimal,
): TicketWinKs[] {
  return wins.map((win) => ({
    ...win,
    ks: bahtToKs(win.baht, rate).toNumber(),
  }));
}

/** The sheet with every group's Ks prize at `rate`, for the admin card and the public results. */
export function groupsWithKs(
  groups: readonly PrizeGroup[],
  rate: number | Prisma.Decimal | null,
): Array<PrizeGroup & { ks: number | null }> {
  return groups.map((group) => ({
    ...group,
    ks: rate === null ? null : bahtToKs(group.baht, rate).toNumber(),
  }));
}
