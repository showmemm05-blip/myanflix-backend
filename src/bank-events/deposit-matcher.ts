import { Prisma } from '../generated/prisma/client';
import type { Deposit } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { depositSnapshot } from '../audit/audit-snapshots';
import {
  eventFromTransaction,
  linkToDeposit,
  markAmbiguous,
  markUnmatched,
  transactionMetadata,
  type LinkTrigger,
  type StoredBankTransaction,
} from '../bank-transactions/bank-transaction-store';
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
  type RiskReason,
  amountsEqual,
  counterpartyReasons,
  depositTimingReasons,
  normalizeReasons,
  reasonsEqual,
  referenceTwinReasons,
  scoreVerification,
  screenshotReasons,
  velocityReasons,
  yangonTimeOfDay,
} from './risk-rules';

/**
 * Matches one STORED "You received …" bank transaction to a pending deposit
 * and writes the bank's values onto that row, linking the two in the same
 * transaction. The ONLY key is the user's own last-6 (Q1): the owner's rule
 * is "the code decides, the amount only confirms". There used to be an
 * amount+window fallback for a mistyped code; it was removed on 2026-09-22
 * after a live test where a transfer arriving BEFORE its deposit was
 * submitted got attached to an unrelated pending deposit of the same
 * amount and consumed — the right deposit, submitted 30 s later, could
 * then never match. A Q1 miss now leaves the transaction stored and
 * UNMATCHED; the deposit that carries its code claims it the moment it is
 * created (DepositsService.create, the reverse lookup) — no retry needed.
 * The matching query is written as literal SQL on purpose: its WHERE
 * spells out `status = 'PENDING' AND "bankCheckedAt" IS NULL` as text,
 * which is what lets Postgres prove the query implies the predicate of the
 * partial deposits_open_* indexes. A parameterised `status = $n` cannot be
 * proven and would fall back to a bigger index or a scan.
 */

/** The columns Q1 returns — enough to run every rule without a second read. */
export interface OpenDepositRow {
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

/** A freshly inserted deposit as the claim wants it (DepositsService.create). */
export function openDepositRowOf(deposit: Deposit): OpenDepositRow {
  return {
    id: deposit.id,
    userId: deposit.userId,
    amount: deposit.amount,
    reference: deposit.reference,
    createdAt: deposit.createdAt,
    declaredTransferAt: deposit.declaredTransferAt,
    matchStatus: deposit.matchStatus,
    riskLevel: deposit.riskLevel,
    riskReasons: deposit.riskReasons,
  };
}

const OPEN_DEPOSIT_COLUMNS = Prisma.sql`id, "userId", amount, reference, "createdAt", "declaredTransferAt", "matchStatus", "riskLevel", "riskReasons"`;

/**
 * Q1 — the user's own last-6 on the declared account, open set only.
 * Index: deposits_open_match_idx. Two or more rows is a real state since
 * H-11 (2026-09-28): different users may submit the same 6-digit
 * reference (only one user's own live rows are unique —
 * deposits_user_reference_active_key), so two open twins on one account
 * are possible. LIMIT 2 is all the never-guess rule needs: exactly one row
 * is claimed, two or more are AMBIGUOUS for staff.
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
 * Every rule that applies to a row the event is about to be written onto:
 * amount, timing, reference twins, velocity, the sender's name, plus
 * whatever the caller already knows. Pure apart from the three indexed
 * reads it needs (Q4, Q5, and the depositor's name by primary key).
 *
 * M-16: the bank's "from" name against the depositor's registered display
 * name — a SOFT reason only (the phone's parse is best effort and a
 * customer's bank name is not always their app name), so whoever submits
 * a stolen code first no longer gets a clean green badge when the bank
 * says the money came from someone else. Nothing on the deposit itself
 * names the sender (Deposit.accountName is OUR account the user picked),
 * so the user's own profile name is the name compared.
 *
 * SEC-004: a transaction with no screenshot behind it adds NO_SCREENSHOT
 * (soft) — the green badge waits for the picture, which the upload path
 * clears (clearDepositScreenshotReason).
 */
async function evaluateCandidate(
  tx: Prisma.TransactionClient,
  row: OpenDepositRow,
  event: NormalizedBankEvent,
  counterparty: string | null,
  screenshotKey: string | null,
  extra: readonly RiskReason[],
) {
  const reasons: RiskReason[] = [...extra];
  if (!amountsEqual(event.amount, row.amount)) reasons.push('AMOUNT_MISMATCH');
  reasons.push(...depositTimingReasons(row, event.occurredAt));
  reasons.push(...screenshotReasons(screenshotKey));
  const twins = await findDepositTwins(tx, row.reference, row.id);
  reasons.push(...referenceTwinReasons(row, twins));
  const recent = await countRecentDepositsByUser(tx, row.userId, row.createdAt);
  reasons.push(...velocityReasons(recent));
  if (counterparty !== null) {
    const depositor = await tx.user.findUnique({
      where: { id: row.userId },
      select: { displayName: true },
    });
    reasons.push(...counterpartyReasons(counterparty, depositor?.displayName));
  }
  return { score: scoreVerification(reasons, true), twins };
}

/** claimDepositWithTransaction's outcome also hands back the claimed row for the caller's create response. */
export interface DepositClaimOutcome extends DepositMatchOutcome {
  deposit: Deposit;
}

/**
 * The claim (Q9) + the link (Q-BT2), one transaction: bank values onto
 * exactly one deposit, guarded by the same open-set predicate the lookup
 * used, then the bank transaction marked MATCHED and pointed at it. Used
 * by ingestion (the transfer arrived after the deposit) AND by
 * DepositsService.create (the transfer was waiting when the deposit was
 * submitted) — `trigger` says which in the audit rows. The deposit's
 * receivingEventKey is the transaction's idempotency key and its
 * screenshot pointer is the transaction's key when one was already
 * uploaded (the "screenshot arrived before the deposit" case); a later
 * upload sets both pointers itself.
 *
 * A lost race (count ≠ 1: claimed / approved / rejected between lookup and
 * write) THROWS: the caller's transaction rolls back whole, the phone
 * answers `error` and retries, and the next post finds the deposit gone
 * from the open set. Never a guess, never a half-written pair.
 *
 * Deliberately never touches receivingPaymentAccountId /
 * receivingAccount* — those drive the payment-account LEDGER at approval
 * (syncDepositLink no-ops when the id is already set), so pre-filling them
 * here would silently skip the DEPOSIT_IN credit.
 */
export async function claimDepositWithTransaction(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: OpenDepositRow,
  transaction: StoredBankTransaction,
  extra: readonly RiskReason[],
  now: Date,
  trigger: LinkTrigger,
): Promise<DepositClaimOutcome> {
  const event = eventFromTransaction(transaction);
  const { score, twins } = await evaluateCandidate(
    tx,
    row,
    event,
    transaction.counterparty ?? null,
    transaction.screenshotKey,
    extra,
  );
  const before = await tx.deposit.findUniqueOrThrow({ where: { id: row.id } });

  const claim = await tx.deposit.updateMany({
    where: { id: row.id, status: 'PENDING', bankCheckedAt: null },
    data: {
      receivingAmount: event.amount,
      receivingTransactionCode: event.txCodeLast6,
      receivingTransactionTime: yangonTimeOfDay(event.occurredAt),
      receivingTransactionAt: event.occurredAt,
      receivingEventKey: event.idempotencyKey,
      ...(transaction.screenshotKey !== null && {
        receivingScreenshotKey: transaction.screenshotKey,
      }),
      bankCheckedAt: now,
      matchStatus: score.matchStatus,
      riskLevel: score.riskLevel,
      riskReasons: score.riskReasons,
    },
  });
  if (claim.count !== 1) {
    throw new Error('DEPOSIT_CLAIMED_CONCURRENTLY');
  }

  const after = await tx.deposit.findUniqueOrThrow({ where: { id: row.id } });
  await audit.record({
    action: 'deposit.bank_match',
    actor: null,
    target: { type: 'deposit', id: row.id, label: row.reference },
    before: depositSnapshot(before),
    after: depositSnapshot(after),
    metadata: {
      ...transactionMetadata(transaction),
      trigger,
      bankTransactionId: transaction.id,
      outcome: 'matched',
      matchStatus: score.matchStatus,
      riskReasons: score.riskReasons,
    },
    tx,
  });

  await linkToDeposit(tx, audit, transaction, row.id, now, trigger);

  const changedTwins = await recomputeDepositTwins(tx, audit, row, twins, {
    ...transactionMetadata(transaction),
    trigger: 'bank_match',
    anchorDepositId: row.id,
  });

  return {
    result: {
      idempotencyKey: event.idempotencyKey,
      outcome: 'matched',
      transactionId: transaction.id,
      state: 'MATCHED',
      depositId: row.id,
      matchStatus: score.matchStatus,
      screenshotWanted: transaction.screenshotKey === null,
    },
    touchedDepositIds: [row.id, ...changedTwins.map((twin) => twin.id)],
    transactionChanged: true,
    deposit: after,
  };
}

/**
 * ≥ 2 open candidates fit and none can be told apart: NEVER GUESS. No bank
 * values on anyone; each candidate gets AMBIGUOUS_MATCH → PENDING_REVIEW
 * (only if not already there, so a re-post is a no-op with zero writes and
 * zero audit rows), and the transaction goes AMBIGUOUS. An admin resolves
 * by approving / rejecting / unlinking until one candidate remains, then
 * presses Resend on the phone — the re-post lands on the 1-row branch.
 */
async function flagAmbiguous(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  candidates: readonly OpenDepositRow[],
  transaction: StoredBankTransaction,
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
      {
        ...transactionMetadata(transaction),
        trigger: 'ambiguous_match',
        bankTransactionId: transaction.id,
        candidateIds,
      },
    );
    touched.push(row.id);
  }
  const transactionChanged = await markAmbiguous(
    tx,
    audit,
    transaction,
    candidateIds,
  );
  return {
    result: {
      idempotencyKey: transaction.idempotencyKey,
      outcome: 'ambiguous',
      transactionId: transaction.id,
      state: 'AMBIGUOUS',
      reason: 'MULTIPLE_CANDIDATES',
      screenshotWanted: transaction.screenshotKey === null,
    },
    touchedDepositIds: touched,
    transactionChanged,
  };
}

/**
 * For a stored, not-yet-MATCHED transaction: legacy backfill first (Q3 —
 * a deposit already carries this key from before bank_transactions
 * existed: link the two, reply already_stored; this is how the phone's
 * existing `sent` rows appear on the admin page when Resent), then Q1
 * (the user's own last-6 → THE row, bank values always written, reasons
 * say how well it fits). A Q1 miss leaves the row UNMATCHED — never a
 * guess by amount (see the file comment). Runs inside the caller's
 * transaction — one per event, so one bad event never rolls back its
 * neighbours.
 */
export async function applyReceivedEvent(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  transaction: StoredBankTransaction,
  now: Date = new Date(),
): Promise<DepositMatchOutcome> {
  const applied = await tx.deposit.findUnique({
    where: { receivingEventKey: transaction.idempotencyKey },
    select: { id: true, matchStatus: true, bankCheckedAt: true },
  });
  if (applied) {
    await linkToDeposit(
      tx,
      audit,
      transaction,
      applied.id,
      applied.bankCheckedAt ?? now,
      'legacy_backfill',
    );
    return {
      result: {
        idempotencyKey: transaction.idempotencyKey,
        outcome: 'already_stored',
        transactionId: transaction.id,
        state: 'MATCHED',
        depositId: applied.id,
        matchStatus: applied.matchStatus,
        screenshotWanted: transaction.screenshotKey === null,
      },
      touchedDepositIds: [applied.id],
      transactionChanged: true,
    };
  }

  const byReference = await findOpenDepositByReference(
    tx,
    transaction.paymentAccountId,
    transaction.txCodeLast6,
  );
  if (byReference.length > 1) {
    // Two users typed the same last-6 on this account (H-11 twins): never
    // pick one — both go to staff as AMBIGUOUS.
    return flagAmbiguous(tx, audit, byReference, transaction);
  }
  if (byReference.length === 1) {
    const claimed = await claimDepositWithTransaction(
      tx,
      audit,
      byReference[0],
      transaction,
      [],
      now,
      'ingestion',
    );
    return {
      result: claimed.result,
      touchedDepositIds: claimed.touchedDepositIds,
      transactionChanged: claimed.transactionChanged,
    };
  }

  // Nothing to claim: the row stays stored and waits for its deposit. A
  // re-posted AMBIGUOUS row whose candidates have all been resolved away
  // is plainly waiting again.
  const transactionChanged = await markUnmatched(tx, audit, transaction);
  return {
    result: {
      idempotencyKey: transaction.idempotencyKey,
      outcome: 'stored_unmatched',
      transactionId: transaction.id,
      state: 'UNMATCHED',
      reason: 'NO_OPEN_CANDIDATE',
      screenshotWanted: transaction.screenshotKey === null,
    },
    touchedDepositIds: [],
    transactionChanged,
  };
}
