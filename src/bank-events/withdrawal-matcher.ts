import { Prisma } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { withdrawalSnapshot } from '../audit/audit-snapshots';
import type {
  NormalizedBankEvent,
  WithdrawalMatchOutcome,
} from './bank-event.types';
import {
  AMBIGUITY_PROBE_LIMIT,
  CLOCK_SKEW_MS,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  type RiskReason,
  last6,
  normalizeReasons,
  reasonsEqual,
  scoreVerification,
  yangonTimeOfDay,
} from './risk-rules';
import {
  findWithdrawalCodeTwins,
  flagWithdrawalCodeTwins,
  updateWithdrawalRisk,
  type WithdrawalCodeTwinRow,
} from './withdrawal-risk';

/**
 * The deposit matcher pointed the other way: a "You sent …" event confirms
 * an APPROVED payout. A withdrawal has no declared "from" account until an
 * admin records one, so the key is amount + approvedAt window (Q7) with
 * the account as a filter when known — which is why two same-amount
 * payouts approved on the same day come back `ambiguous` until an admin
 * keys one code in by hand. That is the never-guess rule working as
 * intended.
 */

interface OpenWithdrawalRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  approvedAt: Date | null;
  transferPaymentAccountId: string | null;
  matchStatus: WithdrawalCodeTwinRow['matchStatus'];
  riskLevel: WithdrawalCodeTwinRow['riskLevel'];
  riskReasons: string[];
}

function toOpenWithdrawalRow(raw: Record<string, unknown>): OpenWithdrawalRow {
  return {
    id: String(raw.id),
    userId: String(raw.userId),
    amount: new Prisma.Decimal(raw.amount as string | number),
    approvedAt:
      raw.approvedAt == null ? null : new Date(raw.approvedAt as string | Date),
    transferPaymentAccountId:
      typeof raw.transferPaymentAccountId === 'string'
        ? raw.transferPaymentAccountId
        : null,
    matchStatus: raw.matchStatus as WithdrawalCodeTwinRow['matchStatus'],
    riskLevel: (raw.riskLevel ?? null) as WithdrawalCodeTwinRow['riskLevel'],
    riskReasons: Array.isArray(raw.riskReasons)
      ? (raw.riskReasons as string[])
      : [],
  };
}

/**
 * Q7 — approved, not yet bank-checked, no manual code, same amount,
 * approvedAt inside the payout window; account is a constraint when known.
 * Index: withdrawals_open_payout_idx, predicate spelled out as literal SQL
 * for the same reason as the deposit queries.
 */
export async function findOpenWithdrawalsByAmount(
  tx: Prisma.TransactionClient,
  amount: Prisma.Decimal,
  occurredAt: Date,
  paymentAccountId: string,
): Promise<OpenWithdrawalRow[]> {
  const from = new Date(occurredAt.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS);
  const to = new Date(occurredAt.getTime() + CLOCK_SKEW_MS);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT id, "userId", amount, "approvedAt", "transferPaymentAccountId", "matchStatus", "riskLevel", "riskReasons"
      FROM withdrawals
      WHERE amount = ${amount.toFixed(2)}::numeric
        AND "approvedAt" BETWEEN ${from} AND ${to}
        AND status = 'APPROVED'::"WithdrawalStatus"
        AND "bankCheckedAt" IS NULL
        AND "transferTransactionCode" IS NULL
        AND ("transferPaymentAccountId" IS NULL OR "transferPaymentAccountId" = ${paymentAccountId})
      ORDER BY "approvedAt" DESC
      LIMIT ${AMBIGUITY_PROBE_LIMIT}`,
  );
  return rows.map(toOpenWithdrawalRow);
}

function eventMetadata(event: NormalizedBankEvent) {
  return {
    source: 'phone-monitor',
    idempotencyKey: event.idempotencyKey,
    deviceSerial: event.deviceSerial,
    paymentAccountId: event.paymentAccountId,
    direction: event.direction,
  };
}

async function claimWithdrawal(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: OpenWithdrawalRow,
  event: NormalizedBankEvent,
  now: Date,
): Promise<WithdrawalMatchOutcome> {
  const code = last6(event.txCode);
  // Q8 — the same payout code on another withdrawal: flag, never block.
  const twins = await findWithdrawalCodeTwins(tx, code, row.id);
  const reasons: RiskReason[] =
    twins.length > 0 ? ['DUPLICATE_PAYOUT_CODE'] : [];
  // AMOUNT_MISMATCH cannot arise (amount is the lookup key) and neither can
  // a time gap (the window is in the WHERE).
  const score = scoreVerification(reasons, true);
  const before = await tx.withdrawal.findUniqueOrThrow({
    where: { id: row.id },
  });

  const claim = await tx.withdrawal.updateMany({
    where: {
      id: row.id,
      status: 'APPROVED',
      bankCheckedAt: null,
      transferTransactionCode: null,
    },
    data: {
      transferAmount: event.amount,
      transferTransactionCode: code,
      transferTransactionTime: yangonTimeOfDay(event.occurredAt),
      transferTransactionAt: event.occurredAt,
      transferEventKey: event.idempotencyKey,
      bankCheckedAt: now,
      matchStatus: score.matchStatus,
      riskLevel: score.riskLevel,
      riskReasons: score.riskReasons,
    },
  });
  if (claim.count !== 1) {
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'no_match',
        reason: 'ROW_CLAIMED_CONCURRENTLY',
      },
      touchedWithdrawalIds: [],
    };
  }

  const after = await tx.withdrawal.findUniqueOrThrow({
    where: { id: row.id },
  });
  await audit.record({
    action: 'withdrawal.bank_match',
    actor: null,
    target: {
      type: 'withdrawal',
      id: row.id,
      label: `${row.amount.toFixed(2)} Ks`,
    },
    before: withdrawalSnapshot(before),
    after: withdrawalSnapshot(after),
    metadata: {
      ...eventMetadata(event),
      outcome: 'matched',
      matchStatus: score.matchStatus,
      riskReasons: score.riskReasons,
    },
    tx,
  });

  const changedTwins = await flagWithdrawalCodeTwins(tx, audit, twins, {
    ...eventMetadata(event),
    trigger: 'bank_match',
    anchorWithdrawalId: row.id,
  });

  return {
    result: {
      idempotencyKey: event.idempotencyKey,
      outcome: 'matched',
      withdrawalId: row.id,
      matchStatus: score.matchStatus,
      screenshotWanted: true,
    },
    touchedWithdrawalIds: [row.id, ...changedTwins.map((twin) => twin.id)],
  };
}

async function flagAmbiguous(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  candidates: readonly OpenWithdrawalRow[],
  event: NormalizedBankEvent,
): Promise<WithdrawalMatchOutcome> {
  const candidateIds = candidates.map((row) => row.id);
  const touched: string[] = [];
  for (const row of candidates) {
    const riskReasons = normalizeReasons([
      ...row.riskReasons,
      'AMBIGUOUS_MATCH',
    ]);
    if (reasonsEqual(riskReasons, row.riskReasons)) continue;
    const next = scoreVerification(riskReasons, false);
    await updateWithdrawalRisk(
      tx,
      audit,
      { ...row, status: 'APPROVED', bankCheckedAt: null },
      next,
      { ...eventMetadata(event), trigger: 'ambiguous_match', candidateIds },
    );
    touched.push(row.id);
  }
  return {
    result: {
      idempotencyKey: event.idempotencyKey,
      outcome: 'ambiguous',
      reason: 'MULTIPLE_CANDIDATES',
    },
    touchedWithdrawalIds: touched,
  };
}

/** Q3 (transferEventKey) → Q7 → 0 no_match / 1 claim / ≥ 2 ambiguous. */
export async function applySentEvent(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  event: NormalizedBankEvent,
  now: Date = new Date(),
): Promise<WithdrawalMatchOutcome> {
  const applied = await tx.withdrawal.findUnique({
    where: { transferEventKey: event.idempotencyKey },
    select: { id: true, transferScreenshotKey: true, matchStatus: true },
  });
  if (applied) {
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'already_applied',
        withdrawalId: applied.id,
        matchStatus: applied.matchStatus,
        screenshotWanted: applied.transferScreenshotKey === null,
      },
      touchedWithdrawalIds: [],
    };
  }

  const candidates = await findOpenWithdrawalsByAmount(
    tx,
    event.amount,
    event.occurredAt,
    event.paymentAccountId,
  );
  if (candidates.length === 0) {
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'no_match',
        reason: 'NO_OPEN_CANDIDATE',
      },
      touchedWithdrawalIds: [],
    };
  }
  if (candidates.length === 1) {
    return claimWithdrawal(tx, audit, candidates[0], event, now);
  }
  return flagAmbiguous(tx, audit, candidates, event);
}
