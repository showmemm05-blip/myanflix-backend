import type { Prisma } from '../generated/prisma/client';

/**
 * H-22 — a user's money history is never deleted with the user. The models
 * below hold it, and each one's foreign key to users is ON DELETE RESTRICT
 * (migration 20260928150200_money_rows_restrict_user_delete): the database
 * refuses to delete a user row that any of them still points at.
 * user-money-records.spec.ts reads schema.prisma to keep this list and the
 * schema in step.
 */
export const MONEY_RECORD_MODELS = [
  'Wallet',
  'Transaction',
  'Deposit',
  'Withdrawal',
  'WalletAdjustment',
  'UserSubscription',
  'Purchase',
  'SeriesPurchase',
] as const;

/** Shown verbatim by the admin — says what to do instead. */
export const MONEY_RECORDS_DELETE_MESSAGE =
  'This account has wallet money or payment records, so it cannot be deleted. Suspend it instead.';

export type MoneyRecordKind =
  | 'wallet_balance'
  | 'transactions'
  | 'deposits'
  | 'withdrawals'
  | 'wallet_adjustments'
  | 'subscriptions'
  | 'purchases'
  | 'series_purchases';

/**
 * Which kinds of money record this user has — [] means the account can be
 * deleted (its wallet row, if any, is empty and goes with it). A wallet row
 * with a zero balance is not a record on its own: every account gets one at
 * sign-up. Each probe reads at most one id by an indexed userId column.
 * Pass the transaction the delete runs in, so the answer and the delete see
 * the same data; the RESTRICT foreign keys still catch anything written in
 * between.
 */
export async function findMoneyRecordKinds(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<MoneyRecordKind[]> {
  const first = { where: { userId }, select: { id: true } } as const;
  const wallet = await tx.wallet.findUnique({
    where: { userId },
    select: { balance: true },
  });
  const found: [MoneyRecordKind, boolean][] = [
    ['wallet_balance', wallet !== null && !wallet.balance.isZero()],
    ['transactions', (await tx.transaction.findFirst(first)) !== null],
    ['deposits', (await tx.deposit.findFirst(first)) !== null],
    ['withdrawals', (await tx.withdrawal.findFirst(first)) !== null],
    [
      'wallet_adjustments',
      (await tx.walletAdjustment.findFirst(first)) !== null,
    ],
    ['subscriptions', (await tx.userSubscription.findFirst(first)) !== null],
    ['purchases', (await tx.purchase.findFirst(first)) !== null],
    ['series_purchases', (await tx.seriesPurchase.findFirst(first)) !== null],
  ];
  return found.filter(([, present]) => present).map(([kind]) => kind);
}
