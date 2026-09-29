/**
 * The five bank-verification tabs on the admin deposits / withdrawals
 * pages, as a server-side filter (`?verification=`). Each is a combination
 * of the MONEY state (status) and the BANK state (matchStatus /
 * bankCheckedAt) — see DepositsService.findAllAdmin for the predicates and
 * the index each one lands on.
 */
export const VERIFICATION_FILTERS = [
  'all',
  'awaiting_bank',
  'verified',
  'needs_review',
  'no_bank_transaction',
] as const;

export type VerificationFilter = (typeof VERIFICATION_FILTERS)[number];
