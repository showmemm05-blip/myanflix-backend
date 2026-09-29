import type { Prisma } from '../generated/prisma/client';
import type { BankEventDirection } from './dto/bank-event-batch.dto';

/** A validated batch event with money and time already parsed. */
export interface NormalizedBankEvent {
  idempotencyKey: string;
  deviceSerial: string;
  paymentAccountId: string;
  direction: BankEventDirection;
  amount: Prisma.Decimal;
  /** Full code as printed. */
  txCode: string;
  /** Last six as printed — what the user was asked to type. */
  txCodeLast6: string;
  occurredAt: Date;
}

/**
 * Store-first outcomes. Every event that passes validation is STORED as a
 * bank_transactions row before matching is even attempted, so the phone
 * posts each event once and never retries a "no match":
 *   stored_unmatched — new (or re-posted) row, no open candidate
 *   matched          — the row is linked to exactly one deposit/withdrawal now
 *   ambiguous        — ≥ 2 candidates fit; nobody guessed, state AMBIGUOUS
 *   already_stored   — the key was known and MATCHED (or legacy-backfilled):
 *                      nothing re-run, the existing link is reported
 *   rejected         — permanent (currency / last-6 / unknown or inactive
 *                      account); nothing stored, never retried
 *   error            — the per-event transaction threw and rolled back; the
 *                      phone retries with backoff, and a retry is idempotent
 */
export type BankEventOutcome =
  | 'stored_unmatched'
  | 'matched'
  | 'ambiguous'
  | 'already_stored'
  | 'rejected'
  | 'error';

/**
 * Per-event reply. The phone-monitor marks its outbox row `sent` on ANY
 * stored outcome (transactionId present) and uploads the screenshot when
 * `screenshotWanted` — which is simply "the row has none yet".
 */
export interface BankEventResult {
  idempotencyKey: string;
  outcome: BankEventOutcome;
  /** Always present for every outcome except rejected / error. */
  transactionId?: string;
  state?: 'UNMATCHED' | 'MATCHED' | 'AMBIGUOUS';
  depositId?: string;
  withdrawalId?: string;
  matchStatus?: string;
  screenshotWanted?: boolean;
  reason?: string;
}

/**
 * What a matcher hands back: the reply for the phone-monitor, the
 * deposits/withdrawals whose verification state changed (admin realtime
 * pushes happen AFTER the transaction has committed), and whether the
 * bank_transactions row itself changed state/link (its own push).
 */
export interface DepositMatchOutcome {
  result: BankEventResult;
  touchedDepositIds: string[];
  transactionChanged: boolean;
}

export interface WithdrawalMatchOutcome {
  result: BankEventResult;
  touchedWithdrawalIds: string[];
  transactionChanged: boolean;
}
