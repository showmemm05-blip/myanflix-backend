import type { Prisma } from '../generated/prisma/client';

/** The client a holdings read needs: the plain PrismaService or a transaction's `tx`. */
export type TicketReader = Pick<Prisma.TransactionClient, 'lotteryTicket'>;

/**
 * How many tickets `userId` already holds of each of `numbers` in one draw
 * — the "held" side of the per-number limit (held + buying ≤ maxPerNumber).
 * Numbers with no ticket are simply absent from the map. Engineer B calls
 * this with the purchase transaction's `tx` AFTER locking the draw row, so
 * two checkouts of the same customer cannot both pass the limit.
 */
export async function heldCounts(
  client: TicketReader,
  userId: string,
  drawId: string,
  numbers: readonly string[],
): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  if (numbers.length === 0) return held;
  const groups = await client.lotteryTicket.groupBy({
    by: ['number'],
    where: { userId, drawId, number: { in: [...numbers] } },
    _count: { _all: true },
  });
  for (const group of groups) held.set(group.number, group._count._all);
  return held;
}

/** The numbers of `numbers` that are off sale in one draw. */
export async function offSaleNumbers(
  client: Pick<Prisma.TransactionClient, 'lotteryOffSaleNumber'>,
  drawId: string,
  numbers: readonly string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await client.lotteryOffSaleNumber.findMany({
    where: { drawId, number: { in: [...numbers] } },
    select: { number: true },
  });
  return new Set(rows.map((row) => row.number));
}

/** What is left to buy of one number: the limit minus what is held, never below 0, and 0 when off sale. */
export function leftToBuy(
  maxPerNumber: number,
  held: number,
  offSale: boolean,
): number {
  return offSale ? 0 : Math.max(0, maxPerNumber - held);
}
