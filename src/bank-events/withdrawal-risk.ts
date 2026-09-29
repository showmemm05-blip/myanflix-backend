import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { Withdrawal } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type {
  RealtimeGateway,
  WithdrawalVerificationPayload,
} from '../realtime/realtime.gateway';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  PAYOUT_CODE_PROBE_LIMIT,
  PAYOUT_CODE_TWIN_REASONS,
  reasonsEqual,
  replaceReasonClass,
  scoreVerification,
  withdrawalVerificationView,
} from './risk-rules';
import {
  BANK_TRANSACTION_LINK_INCLUDE,
  riskSnapshot,
  type RiskWrite,
} from './deposit-risk';

/**
 * Withdrawal-side twins of deposit-risk.ts. The one rule that lives here
 * is DUPLICATE_PAYOUT_CODE: the same payout code on two withdrawals could
 * mean one bank transfer was recorded as two payouts (or two payouts got
 * one code by mistake) — flagged, never blocked, whichever way the code
 * arrives (bank event or the admin's manual form).
 */

export interface WithdrawalCodeTwinRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  status: string;
  bankCheckedAt: Date | null;
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

const CODE_TWIN_SELECT = {
  id: true,
  userId: true,
  amount: true,
  status: true,
  bankCheckedAt: true,
  matchStatus: true,
  riskLevel: true,
  riskReasons: true,
} satisfies Prisma.WithdrawalSelect;

/**
 * Q8 — every OTHER withdrawal carrying this payout code, bounded. Index:
 * withdrawals_transferTransactionCode_idx (new — this used to be a
 * sequential scan).
 */
export async function findWithdrawalCodeTwins(
  tx: Prisma.TransactionClient,
  transferTransactionCode: string,
  excludeId: string,
): Promise<WithdrawalCodeTwinRow[]> {
  return tx.withdrawal.findMany({
    where: { transferTransactionCode, id: { not: excludeId } },
    select: CODE_TWIN_SELECT,
    take: PAYOUT_CODE_PROBE_LIMIT,
  });
}

/** Q10 (withdrawals) — by primary key, audited, only called on a real change. */
export async function updateWithdrawalRisk(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: WithdrawalCodeTwinRow,
  next: RiskWrite,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.withdrawal.update({
    where: { id: row.id },
    data: {
      matchStatus: next.matchStatus,
      riskLevel: next.riskLevel,
      riskReasons: next.riskReasons,
    },
  });
  await audit.record({
    action: 'withdrawal.risk_update',
    actor: null,
    target: { type: 'withdrawal', id: row.id },
    before: riskSnapshot(row),
    after: riskSnapshot(next),
    metadata,
    tx,
  });
}

/**
 * Every twin that shares the anchor's payout code now has at least one
 * other row with that code (the anchor), so each gets DUPLICATE_PAYOUT_CODE
 * — written only where it was not already present. Returns the changed
 * rows for the after-commit realtime push.
 */
export async function flagWithdrawalCodeTwins(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  twins: readonly WithdrawalCodeTwinRow[],
  metadata: Record<string, unknown>,
): Promise<WithdrawalCodeTwinRow[]> {
  const changed: WithdrawalCodeTwinRow[] = [];
  for (const twin of twins) {
    const riskReasons = replaceReasonClass(
      twin.riskReasons,
      PAYOUT_CODE_TWIN_REASONS,
      ['DUPLICATE_PAYOUT_CODE'],
    );
    if (reasonsEqual(riskReasons, twin.riskReasons)) continue;
    const next = scoreVerification(riskReasons, twin.bankCheckedAt !== null);
    await updateWithdrawalRisk(tx, audit, twin, next, metadata);
    changed.push({ ...twin, ...next });
  }
  return changed;
}

/** Mirrors depositVerificationPayload — admins room only. */
export function withdrawalVerificationPayload(
  row: Pick<
    Withdrawal,
    | 'id'
    | 'status'
    | 'approvedAt'
    | 'bankCheckedAt'
    | 'matchStatus'
    | 'riskLevel'
    | 'riskReasons'
    | 'transferAmount'
    | 'transferTransactionCode'
    | 'transferTransactionAt'
    | 'transferScreenshotKey'
  > & { bankTransaction?: { id: string } | null },
  now: Date = new Date(),
): WithdrawalVerificationPayload {
  const view = withdrawalVerificationView(row, now);
  return {
    id: row.id,
    matchStatus: view.matchStatus,
    riskLevel: view.riskLevel,
    riskReasons: view.riskReasons,
    transferAmount:
      row.transferAmount == null ? null : decimalToNumber(row.transferAmount),
    transferTransactionCode: row.transferTransactionCode,
    transferTransactionAt: row.transferTransactionAt,
    bankCheckedAt: row.bankCheckedAt,
    hasBankScreenshot: row.transferScreenshotKey !== null,
    bankTransactionId: row.bankTransaction?.id ?? null,
  };
}

/** Exactly the columns withdrawalVerificationPayload reads, plus the link id. */
const WITHDRAWAL_VERIFICATION_SELECT = {
  id: true,
  status: true,
  approvedAt: true,
  bankCheckedAt: true,
  matchStatus: true,
  riskLevel: true,
  riskReasons: true,
  transferAmount: true,
  transferTransactionCode: true,
  transferTransactionAt: true,
  transferScreenshotKey: true,
  ...BANK_TRANSACTION_LINK_INCLUDE,
} satisfies Prisma.WithdrawalSelect;

/**
 * Admins-room push for every withdrawal whose verification state changed —
 * after commit, by primary key. Shared by ingestion (BankEventsService) and
 * the staff paths (WithdrawalsService), so a match reads the same whichever
 * event completed it. Never the user's room.
 */
export async function pushWithdrawalVerificationUpdates(
  db: Pick<Prisma.TransactionClient, 'withdrawal'>,
  gateway: Pick<RealtimeGateway, 'notifyAdminsWithdrawalVerificationUpdated'>,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.withdrawal.findMany({
    where: { id: { in: [...ids] } },
    select: WITHDRAWAL_VERIFICATION_SELECT,
  });
  for (const row of rows) {
    gateway.notifyAdminsWithdrawalVerificationUpdated(
      withdrawalVerificationPayload(row),
    );
  }
}
