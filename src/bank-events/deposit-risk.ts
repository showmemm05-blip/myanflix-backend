import {
  BankMatchStatus,
  BankRiskLevel,
  Prisma,
} from '../generated/prisma/client';
import type { Deposit } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { DepositVerificationPayload } from '../realtime/realtime.gateway';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  REFERENCE_TWIN_REASONS,
  TWIN_PROBE_LIMIT,
  VELOCITY_PROBE_LIMIT,
  VELOCITY_WINDOW_MS,
  reasonsEqual,
  referenceTwinReasons,
  replaceReasonClass,
  scoreVerification,
  verificationView,
} from './risk-rules';

/**
 * The deposit-side database helpers the bank-verification feature shares
 * between DepositsService (create / approve / review) and the bank-events
 * matcher. Every query here is keyed on an index that scales with the rows
 * it actually needs (see the query notes in the spec, Q3–Q5, Q10): a
 * primary key, the unique event key, the reference index, or the
 * (userId, createdAt) composite. None of them can walk the table.
 */

/** The subset of a deposit the risk rules read. */
export interface DepositRiskRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  reference: string;
  status: string;
  bankCheckedAt: Date | null;
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

/** A twin: another row carrying the same reference (any status). */
export interface DepositTwinRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  status: string;
  bankCheckedAt: Date | null;
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

const TWIN_SELECT = {
  id: true,
  userId: true,
  amount: true,
  status: true,
  bankCheckedAt: true,
  matchStatus: true,
  riskLevel: true,
  riskReasons: true,
} satisfies Prisma.DepositSelect;

/**
 * Q4 — every OTHER row with this reference, any status, bounded. Index:
 * deposits_reference_idx. A REJECTED twin is still a reused reference.
 */
export async function findDepositTwins(
  tx: Prisma.TransactionClient,
  reference: string,
  excludeId: string,
): Promise<DepositTwinRow[]> {
  return tx.deposit.findMany({
    where: { reference, id: { not: excludeId } },
    select: TWIN_SELECT,
    take: TWIN_PROBE_LIMIT,
  });
}

/**
 * Q5 — how many rows this user submitted in the VELOCITY window ending at
 * `until` (the row's own createdAt, so the answer is "was this row part of
 * a burst" and does not drift as the clock moves on). Index:
 * deposits_userId_createdAt_idx. Capped at VELOCITY_PROBE_LIMIT rows: the
 * rule only asks "≥ VELOCITY_LIMIT", never the exact count.
 */
export async function countRecentDepositsByUser(
  tx: Prisma.TransactionClient,
  userId: string,
  until: Date,
): Promise<number> {
  const rows = await tx.deposit.findMany({
    where: {
      userId,
      createdAt: {
        gte: new Date(until.getTime() - VELOCITY_WINDOW_MS),
        lte: until,
      },
    },
    select: { id: true },
    take: VELOCITY_PROBE_LIMIT,
  });
  return rows.length;
}

/** What a risk_update audit row diffs — nothing but the verification state. */
export function riskSnapshot(row: {
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}) {
  return {
    matchStatus: row.matchStatus,
    riskLevel: row.riskLevel,
    riskReasons: [...row.riskReasons],
  };
}

export interface RiskWrite {
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

/**
 * Q10 — write a row's verification state by primary key and record it.
 * Callers diff first and only call this when something changed, so a
 * retried event that re-derives the same flags costs no write and no audit
 * row. `metadata` says what triggered the recompute.
 */
export async function updateDepositRisk(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: DepositTwinRow | DepositRiskRow,
  next: RiskWrite,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.deposit.update({
    where: { id: row.id },
    data: {
      matchStatus: next.matchStatus,
      riskLevel: next.riskLevel,
      riskReasons: next.riskReasons,
    },
  });
  await audit.record({
    action: 'deposit.risk_update',
    actor: null,
    target: { type: 'deposit', id: row.id },
    before: riskSnapshot(row),
    after: riskSnapshot(next),
    metadata,
    tx,
  });
}

/**
 * Recompute the reference-twin class of reasons on every row that shares
 * `anchor.reference` — the anchor itself is NOT rewritten here (its caller
 * owns its full reason set). For each twin the others are the anchor plus
 * the remaining twins, the class is swapped in over its stored reasons,
 * status/level re-derived, and only rows whose reasons actually changed
 * are written (Q10) and audited. Returns the ids that changed so the
 * caller can push admin realtime updates after commit.
 */
export async function recomputeDepositTwins(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  anchor: {
    id: string;
    userId: string;
    amount: Prisma.Decimal;
    reference: string;
  },
  twins: readonly DepositTwinRow[],
  metadata: Record<string, unknown>,
): Promise<DepositTwinRow[]> {
  const everyone: readonly {
    id: string;
    userId: string;
    amount: Prisma.Decimal;
  }[] = [anchor, ...twins];
  const changed: DepositTwinRow[] = [];
  for (const twin of twins) {
    const others = everyone.filter((row) => row.id !== twin.id);
    const classReasons = referenceTwinReasons(twin, others);
    const riskReasons = replaceReasonClass(
      twin.riskReasons,
      REFERENCE_TWIN_REASONS,
      classReasons,
    );
    if (reasonsEqual(riskReasons, twin.riskReasons)) continue;
    const next = scoreVerification(riskReasons, twin.bankCheckedAt !== null);
    await updateDepositRisk(tx, audit, twin, next, metadata);
    changed.push({ ...twin, ...next });
  }
  return changed;
}

/**
 * Admins-room realtime payload for one deposit, with the read-time
 * NO_BANK_TRANSACTION derivation applied exactly as the list response
 * applies it — the socket row and the fetched row must never disagree.
 */
export function depositVerificationPayload(
  row: Pick<
    Deposit,
    | 'id'
    | 'status'
    | 'createdAt'
    | 'bankCheckedAt'
    | 'matchStatus'
    | 'riskLevel'
    | 'riskReasons'
    | 'receivingAmount'
    | 'receivingTransactionCode'
    | 'receivingTransactionAt'
    | 'receivingScreenshotKey'
  >,
  now: Date = new Date(),
): DepositVerificationPayload {
  const view = verificationView(row, now);
  return {
    id: row.id,
    matchStatus: view.matchStatus,
    riskLevel: view.riskLevel,
    riskReasons: view.riskReasons,
    receivingAmount:
      row.receivingAmount == null ? null : decimalToNumber(row.receivingAmount),
    receivingTransactionCode: row.receivingTransactionCode,
    receivingTransactionAt: row.receivingTransactionAt,
    bankCheckedAt: row.bankCheckedAt,
    hasBankScreenshot: row.receivingScreenshotKey !== null,
  };
}
