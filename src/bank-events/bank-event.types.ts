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

export type BankEventOutcome =
  'matched' | 'no_match' | 'ambiguous' | 'already_applied' | 'rejected';

/**
 * Per-event reply. The phone-monitor keys its outbox transitions on
 * `outcome`: matched / already_applied → sent (upload the screenshot when
 * `screenshotWanted`); no_match / ambiguous → retry on its schedule;
 * rejected → failed for good, never retried.
 */
export interface BankEventResult {
  idempotencyKey: string;
  outcome: BankEventOutcome;
  depositId?: string;
  withdrawalId?: string;
  matchStatus?: string;
  screenshotWanted?: boolean;
  reason?: string;
}

/**
 * What a matcher hands back: the reply for the phone-monitor plus the rows
 * whose verification state changed, so the service can push admin realtime
 * updates AFTER the transaction has committed.
 */
export interface DepositMatchOutcome {
  result: BankEventResult;
  touchedDepositIds: string[];
}

export interface WithdrawalMatchOutcome {
  result: BankEventResult;
  touchedWithdrawalIds: string[];
}
