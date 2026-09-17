/**
 * The audit-log label for one of OUR payment accounts: `type · subname`, or
 * just `type` when the account has no internal subname. Shared by the
 * accounts service and the ledger service so every audit row about the same
 * account reads the same.
 */
export function paymentAccountLabel(account: {
  type: string;
  subname?: string | null;
}): string {
  return account.subname
    ? `${account.type} · ${account.subname}`
    : account.type;
}
