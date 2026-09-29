import type { Prisma, UserStatus } from '../generated/prisma/client';

/** H-16: a closed account is terminal — no staff route may change it. */
export const CLOSED_ACCOUNT_MESSAGE =
  'This account was closed by its owner and cannot be changed.';

/**
 * H-16: the first statement of every transaction that inserts a deposit or
 * withdrawal — and of a staff wallet adjustment, right after its replay
 * probe (which writes nothing). It share-locks the account row and returns
 * its status as of that lock (null: no such account).
 *
 * DELETE /users/me (UsersService.deleteOwnAccount) takes the same row FOR
 * UPDATE before its "no money left, nothing pending" checks, so the two are
 * serialised in one order — users first, then the wallet and money rows:
 * - the close came first: this waits until it commits, then reads CLOSED,
 *   and the caller refuses before anything is written;
 * - the insert came first: the close waits until it commits, then its
 *   checks see the new pending deposit/withdrawal (or the held money) and
 *   refuse to close.
 * A foreign key's own KEY SHARE lock only made the insert wait, never look.
 */
export async function lockAccountStatus(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<UserStatus | null> {
  const rows = await tx.$queryRaw<
    { status: UserStatus }[]
  >`SELECT "status" FROM "users" WHERE "id" = ${userId} FOR SHARE`;
  return rows[0]?.status ?? null;
}
