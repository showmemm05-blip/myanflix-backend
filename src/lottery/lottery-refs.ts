import type { Prisma } from '../generated/prisma/client';
import { myanmarYymmdd } from './lottery-time';

/** "LP-261019-0042": the Myanmar date the purchase was made, then the sequence value (4+ digits). */
export function purchaseRef(seq: number | bigint, at: Date): string {
  return `LP-${myanmarYymmdd(at)}-${String(seq).padStart(4, '0')}`;
}

/** "MFL-24-000468": our draw number, then the ticket's seq in that draw. */
export function ticketNo(drawNo: number, seq: number): string {
  return `MFL-${drawNo}-${String(seq).padStart(6, '0')}`;
}

/**
 * The next value of lottery_purchase_ref_seq (created by the lottery_draws
 * migration), inside the caller's transaction. Postgres sequences are not
 * rolled back, so a failed purchase simply leaves a gap — refs are for
 * people and uniqueness, not for counting.
 */
export async function nextPurchaseRefSeq(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<number> {
  const rows = await tx.$queryRaw<
    Array<{ seq: bigint | number }>
  >`SELECT nextval('lottery_purchase_ref_seq') AS seq`;
  return Number(rows[0].seq);
}
