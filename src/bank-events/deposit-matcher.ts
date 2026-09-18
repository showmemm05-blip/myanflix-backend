import { Prisma } from '../generated/prisma/client';
import type { Deposit } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { depositSnapshot } from '../audit/audit-snapshots';
import type {
  DepositMatchOutcome,
  NormalizedBankEvent,
} from './bank-event.types';
import {
  findDepositTwins,
  countRecentDepositsByUser,
  recomputeDepositTwins,
  updateDepositRisk,
  type DepositRiskRow,
} from './deposit-risk';
import {
  AMBIGUITY_PROBE_LIMIT,
  CLOCK_SKEW_MS,
  DEPOSIT_MATCH_WINDOW_MS,
  type RiskReason,
  amountsEqual,
  depositTimingReasons,
  normalizeReasons,
  reasonsEqual,
  referenceTwinReasons,
  scoreVerification,
  velocityReasons,
  yangonTimeOfDay,
} from './risk-rules';

/**
 * Matches one "You received …" bank event to a pending deposit and writes
 * the bank's values onto that row. The matching queries (Q1/Q2) are
 * written as literal SQL on purpose: their WHERE spells out
 * `status = 'PENDING' AND "bankCheckedAt" IS NULL` as text, which is what
 * lets Postgres prove the query implies the predicate of the partial
 * deposits_open_* indexes. A parameterised `status = $n` cannot be proven
 * and would fall back to a bigger index or a scan.
 */

/** The columns Q1/Q2 return — enough to run every rule without a second read. */
interface OpenDepositRow {
  id: string;
  userId: string;
  amount: Prisma.Decimal;
  reference: string;
  createdAt: Date;
  declaredTransferAt: Date | null;
  matchStatus: DepositRiskRow['matchStatus'];
  riskLevel: DepositRiskRow['riskLevel'];
  riskReasons: string[];
}

/**
 * $queryRaw hands numerics back as Decimal and timestamps as Date with the
 * pg driver adapter; coerce anyway so a raw-row shape change can never
 * silently turn a money compare into a string compare.
 */
function toOpenDepositRow(raw: Record<string, unknown>): OpenDepositRow {
  return {
    id: String(raw.id),
    userId: String(raw.userId),
    amount: new Prisma.Decimal(raw.amount as string | number),
    reference: String(raw.reference),
    createdAt: new Date(raw.createdAt as string | Date),
    declaredTransferAt:
      raw.declaredTransferAt == null
        ? null
        : new Date(raw.declaredTransferAt as string | Date),
    matchStatus: raw.matchStatus as DepositRiskRow['matchStatus'],
    riskLevel: (raw.riskLevel ?? null) as DepositRiskRow['riskLevel'],
    riskReasons: Array.isArray(raw.riskReasons)
      ? (raw.riskReasons as string[])
      : [],
  };
}

const OPEN_DEPOSIT_COLUMNS = Prisma.sql`id, "userId", amount, reference, "createdAt", "declaredTransferAt", "matchStatus", "riskLevel", "riskReasons"`;

/**
 * Q1 — the user's own last-6 on the declared account, open set only.
 * Index: deposits_open_match_idx. ≤ 1 row by deposits_reference_active_key;
 * LIMIT 2 is a guard so a broken invariant surfaces as "ambiguous" rather
 * than a silent pick.
 */
export async function findOpenDepositByReference(
  tx: Prisma.TransactionClient,
  paymentAccountId: string,
  reference: string,
): Promise<OpenDepositRow[]> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT ${OPEN_DEPOSIT_COLUMNS}
      FROM deposits
      WHERE "declaredPaymentAccountId" = ${paymentAccountId}
        AND reference = ${reference}
        AND status = 'PENDING'::"DepositStatus"
        AND "bankCheckedAt" IS NULL
      LIMIT 2`,
  );
  return rows.map(toOpenDepositRow);
}

/**
 * Q2 — the fallback when the reference misses: same account, same amount,
 * created inside the window around the bank's timestamp, open set only.
 * Index: deposits_open_amount_idx (equality, equality, range — one
 * contiguous range in createdAt order, so no sort). LIMIT 3: the matcher
 * only needs to tell 0 / 1 / many apart.
 */
export async function findOpenDepositsByAmount(
  tx: Prisma.TransactionClient,
  paymentAccountId: string,
  amount: Prisma.Decimal,
  occurredAt: Date,
): Promise<OpenDepositRow[]> {
  const from = new Date(occurredAt.getTime() - CLOCK_SKEW_MS);
  const to = new Date(occurredAt.getTime() + DEPOSIT_MATCH_WINDOW_MS);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT ${OPEN_DEPOSIT_COLUMNS}
      FROM deposits
      WHERE "declaredPaymentAccountId" = ${paymentAccountId}
        AND amount = ${amount.toFixed(2)}::numeric
        AND "createdAt" BETWEEN ${from} AND ${to}
        AND status = 'PENDING'::"DepositStatus"
        AND "bankCheckedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${AMBIGUITY_PROBE_LIMIT}`,
  );
  return rows.map(toOpenDepositRow);
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

/**
 * Every rule that applies to a row the event is about to be written onto:
 * amount, timing, reference twins, velocity, plus whatever the caller
 * already knows (CODE_MISMATCH on the amount-fallback path). Pure apart
 * from the two indexed reads it needs (Q4, Q5).
 */
async function evaluateCandidate(
  tx: Prisma.TransactionClient,
  row: OpenDepositRow,
  event: NormalizedBankEvent,
  extra: readonly RiskReason[],
) {
  const reasons: RiskReason[] = [...extra];
  if (!amountsEqual(event.amount, row.amount)) reasons.push('AMOUNT_MISMATCH');
  reasons.push(...depositTimingReasons(row, event.occurredAt));
  const twins = await findDepositTwins(tx, row.reference, row.id);
  reasons.push(...referenceTwinReasons(row, twins));
  const recent = await countRecentDepositsByUser(tx, row.userId, row.createdAt);
  reasons.push(...velocityReasons(recent));
  return { score: scoreVerification(reasons, true), twins };
}

/**
 * The claim (Q9): bank values onto exactly one row, guarded by the same
 * open-set predicate the lookup used, so two events racing for one row can
 * never both write. Deliberately never touches receivingPaymentAccountId /
 * receivingAccount* — those drive the payment-account LEDGER at approval
 * (syncDepositLink no-ops when the id is already set), so pre-filling them
 * here would silently skip the DEPOSIT_IN credit.
 */
async function claimDeposit(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: OpenDepositRow,
  event: NormalizedBankEvent,
  extra: readonly RiskReason[],
  now: Date,
): Promise<DepositMatchOutcome> {
  const { score, twins } = await evaluateCandidate(tx, row, event, extra);
  const before = await tx.deposit.findUniqueOrThrow({ where: { id: row.id } });

  const claim = await tx.deposit.updateMany({
    where: { id: row.id, status: 'PENDING', bankCheckedAt: null },
    data: {
      receivingAmount: event.amount,
      receivingTransactionCode: event.txCodeLast6,
      receivingTransactionTime: yangonTimeOfDay(event.occurredAt),
      receivingTransactionAt: event.occurredAt,
      receivingEventKey: event.idempotencyKey,
      bankCheckedAt: now,
      matchStatus: score.matchStatus,
      riskLevel: score.riskLevel,
      riskReasons: score.riskReasons,
    },
  });
  if (claim.count !== 1) {
    // Claimed (matched/approved/rejected) between the lookup and here; the
    // phone-monitor's retry will hit Q3 or find nothing — never guess now.
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'no_match',
        reason: 'ROW_CLAIMED_CONCURRENTLY',
      },
      touchedDepositIds: [],
    };
  }

  const after = await tx.deposit.findUniqueOrThrow({ where: { id: row.id } });
  await audit.record({
    action: 'deposit.bank_match',
    actor: null,
    target: { type: 'deposit', id: row.id, label: row.reference },
    before: depositSnapshot(before),
    after: depositSnapshot(after),
    metadata: {
      ...eventMetadata(event),
      outcome: 'matched',
      matchStatus: score.matchStatus,
      riskReasons: score.riskReasons,
    },
    tx,
  });

  const changedTwins = await recomputeDepositTwins(tx, audit, row, twins, {
    ...eventMetadata(event),
    trigger: 'bank_match',
    anchorDepositId: row.id,
  });

  return {
    result: {
      idempotencyKey: event.idempotencyKey,
      outcome: 'matched',
      depositId: row.id,
      matchStatus: score.matchStatus,
      screenshotWanted: true,
    },
    touchedDepositIds: [row.id, ...changedTwins.map((twin) => twin.id)],
  };
}

/**
 * ≥ 2 open candidates fit by amount + window and none by reference: NEVER
 * GUESS. No bank values on anyone; each candidate gets AMBIGUOUS_MATCH →
 * PENDING_REVIEW (only if not already there, so a retry is a no-op with
 * zero writes and zero audit rows). An admin resolves by approving /
 * rejecting / unlinking until one candidate remains; the phone-monitor keeps
 * retrying and lands on the 1-row branch then.
 */
async function flagAmbiguous(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  candidates: readonly OpenDepositRow[],
  event: NormalizedBankEvent,
): Promise<DepositMatchOutcome> {
  const candidateIds = candidates.map((row) => row.id);
  const touched: string[] = [];
  for (const row of candidates) {
    const riskReasons = normalizeReasons([
      ...row.riskReasons,
      'AMBIGUOUS_MATCH',
    ]);
    if (reasonsEqual(riskReasons, row.riskReasons)) continue;
    const next = scoreVerification(riskReasons, false);
    await updateDepositRisk(
      tx,
      audit,
      { ...row, status: 'PENDING', bankCheckedAt: null },
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
    touchedDepositIds: touched,
  };
}

/**
 * Q3 first (already applied?), then Q1 (the user's own last-6 → THE row,
 * bank values always written, reasons say how well it fits), then Q2 (the
 * amount fallback: 0 → no_match, 1 → the "mistyped last-6" case written
 * with CODE_MISMATCH, ≥ 2 → ambiguous). Runs inside the caller's
 * transaction — one per event, so one bad event never rolls back its
 * neighbours.
 */
export async function applyReceivedEvent(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  event: NormalizedBankEvent,
  now: Date = new Date(),
): Promise<DepositMatchOutcome> {
  const applied = await tx.deposit.findUnique({
    where: { receivingEventKey: event.idempotencyKey },
    select: { id: true, receivingScreenshotKey: true, matchStatus: true },
  });
  if (applied) {
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'already_applied',
        depositId: applied.id,
        matchStatus: applied.matchStatus,
        screenshotWanted: applied.receivingScreenshotKey === null,
      },
      touchedDepositIds: [],
    };
  }

  const byReference = await findOpenDepositByReference(
    tx,
    event.paymentAccountId,
    event.txCodeLast6,
  );
  if (byReference.length > 1) {
    // Impossible while deposits_reference_active_key holds; treat exactly
    // like any other ambiguity rather than picking one.
    return flagAmbiguous(tx, audit, byReference, event);
  }
  if (byReference.length === 1) {
    return claimDeposit(tx, audit, byReference[0], event, [], now);
  }

  const byAmount = await findOpenDepositsByAmount(
    tx,
    event.paymentAccountId,
    event.amount,
    event.occurredAt,
  );
  if (byAmount.length === 0) {
    return {
      result: {
        idempotencyKey: event.idempotencyKey,
        outcome: 'no_match',
        reason: 'NO_OPEN_CANDIDATE',
      },
      touchedDepositIds: [],
    };
  }
  if (byAmount.length === 1) {
    return claimDeposit(tx, audit, byAmount[0], event, ['CODE_MISMATCH'], now);
  }
  return flagAmbiguous(tx, audit, byAmount, event);
}

/** Re-exported so the service can type the rows it pushes over the socket. */
export type MatchedDeposit = Deposit;
