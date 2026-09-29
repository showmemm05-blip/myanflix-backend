import { Prisma, WithdrawalStatus } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { withdrawalSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import {
  eventFromTransaction,
  findParkedSentByCode,
  linkToWithdrawal,
  markAmbiguous,
  markUnmatched,
  transactionMetadata,
  type LinkTrigger,
  type StoredBankTransaction,
} from '../bank-transactions/bank-transaction-store';
import type { WithdrawalMatchOutcome } from './bank-event.types';
import {
  AMBIGUITY_PROBE_LIMIT,
  CLOCK_SKEW_MS,
  CODE_KEY_PROBE_LIMIT,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  type RiskReason,
  amountsEqual,
  codesEqual,
  isPlainCode,
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
 * The deposit matcher pointed the other way: a stored "You sent …"
 * transaction confirms an APPROVED payout. Three events decide a payout's
 * bank check — the money leaving (the phone posts the record), the
 * approval, and staff typing the code in "Our Transfer Account" — and they
 * can happen in ANY order (27 Sep: sent 01:37:01, posted 01:37:27,
 * approved 01:38:13, code typed after). So each of them looks at what the
 * other two already left behind, and the result no longer depends on the
 * order:
 *
 *  - The record is posted (applySentEvent — ingestion, or the phone's
 *    Resend): a withdrawal whose hand-typed code IS this record's last 6
 *    (the code key, W3) is claimed when the amount agrees, and gets
 *    AMOUNT_MISMATCH when it does not — then the record stays UNMATCHED
 *    and no other row is tried, since a record that names a code is never
 *    handed to someone else. Otherwise the open payout set is searched by
 *    amount + approvedAt window (Q7): 1 → claim, ≥ 2 → AMBIGUOUS,
 *    0 → UNMATCHED ("parked").
 *  - The approval commits (rematchParkedSentTransaction, from
 *    WithdrawalsService.approve): the parked records whose bank time is
 *    within CLOCK_SKEW_MS BEFORE approvedAt — exactly the records whose Q7
 *    window (approvedAt ≤ bank time + CLOCK_SKEW_MS) now contains this
 *    approval — are re-run through applySentEvent, the same function the
 *    Resend runs. It is the 5-minute clock rule ingestion already accepts,
 *    applied from the other side: it adds no new guess.
 *  - The code is typed (matchTypedCode, from updateTransferAccount): the
 *    parked records carrying that last 6 (and account, when recorded) are
 *    looked up — exactly one of the same amount is claimed, one of another
 *    amount flags AMOUNT_MISMATCH, two are never guessed between.
 *
 * Never a guess: every claim needs exactly one candidate on its key, and two
 * same-amount payouts approved the same day still come back AMBIGUOUS until
 * someone types the code. The bank check is a LABEL: nothing here approves,
 * rejects, debits or credits, and transferPaymentAccountId (the ledger's
 * key) is never written.
 */

/** What made the matcher run: the phone's post, or a staff action looking back. */
export type WithdrawalMatchTrigger = Extract<
  LinkTrigger,
  'ingestion' | 'transfer_account_update' | 'withdrawal_approve'
>;

export interface WithdrawalMatchContext {
  trigger: WithdrawalMatchTrigger;
  /** The admin whose action ran the look-back; null for the phone's post. */
  actor: AuthenticatedUser | null;
}

export const INGESTION_CONTEXT: WithdrawalMatchContext = {
  trigger: 'ingestion',
  actor: null,
};

/**
 * The trigger an audit row names: ingestion says which key matched (the
 * code key is new, so it is told apart); a staff look-back names the staff
 * action — the matchKey metadata says which key.
 */
function auditTrigger(
  context: WithdrawalMatchContext,
  byCode: boolean,
): string {
  if (context.trigger === 'ingestion' && byCode) return 'ingestion_code';
  return context.trigger;
}

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

/** An approved, not-yet-bank-checked withdrawal whose code staff typed by hand. */
interface CodedWithdrawalRow extends OpenWithdrawalRow {
  transferTransactionCode: string;
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

const CODED_WITHDRAWAL_SELECT = {
  id: true,
  userId: true,
  amount: true,
  approvedAt: true,
  transferPaymentAccountId: true,
  transferTransactionCode: true,
  matchStatus: true,
  riskLevel: true,
  riskReasons: true,
} satisfies Prisma.WithdrawalSelect;

/** Narrowing only — the WHERE already guarantees a non-null code equal to `code` ignoring case. */
function carriesCode<T extends { transferTransactionCode: string | null }>(
  code: string,
) {
  return (row: T): row is T & { transferTransactionCode: string } =>
    typeof row.transferTransactionCode === 'string' &&
    codesEqual(row.transferTransactionCode, code);
}

/**
 * Q7c (W3) — approved, not yet bank-checked withdrawals whose hand-typed
 * code is this record's last 6 (ignoring case), approved within
 * WITHDRAWAL_PAYOUT_WINDOW_MS either side of the bank time, on this account
 * or none recorded. LIMIT 2: 0 / 1 / "more than one". Index:
 * withdrawals_coded_payout_idx on approvedAt, whose predicate ("bankCheckedAt"
 * IS NULL AND "transferTransactionCode" IS NOT NULL) Prisma renders
 * literally; status stays a filter (only APPROVED rows ever carry a code).
 */
async function findCodedWithdrawalsForEvent(
  tx: Prisma.TransactionClient,
  transaction: StoredBankTransaction,
): Promise<CodedWithdrawalRow[]> {
  const code = transaction.txCodeLast6;
  if (!isPlainCode(code)) return [];
  const bankAt = transaction.occurredAt.getTime();
  const rows = await tx.withdrawal.findMany({
    where: {
      status: WithdrawalStatus.APPROVED,
      bankCheckedAt: null,
      transferTransactionCode: { not: null, equals: code, mode: 'insensitive' },
      approvedAt: {
        gte: new Date(bankAt - WITHDRAWAL_PAYOUT_WINDOW_MS),
        lte: new Date(bankAt + WITHDRAWAL_PAYOUT_WINDOW_MS),
      },
      OR: [
        { transferPaymentAccountId: null },
        { transferPaymentAccountId: transaction.paymentAccountId },
      ],
    },
    select: CODED_WITHDRAWAL_SELECT,
    orderBy: { approvedAt: 'desc' },
    take: CODE_KEY_PROBE_LIMIT,
  });
  return rows.filter(carriesCode(code));
}

/**
 * The claim + the link, one transaction — see claimDepositWithTransaction
 * for the rules (lost race throws; screenshot pointer copied when the
 * transaction already holds one; never the ledger-driving
 * transferPaymentAccountId). One function for both keys:
 *  - `typedCode === null` — the open-set claim (Q7): the guard requires "no
 *    code", and the bank's last 6 is written as the payout code;
 *  - `typedCode` set — the code-key claim: the guard requires the row still
 *    carries exactly what staff typed, and that typed code is kept.
 * Either way the row is scored fresh (only the twin check can add a reason:
 * the amount is equal by construction and the window is in the lookup), so
 * an earlier AMOUNT_MISMATCH / AMBIGUOUS_MATCH on it is cleared.
 */
async function claimWithdrawal(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: OpenWithdrawalRow,
  transaction: StoredBankTransaction,
  now: Date,
  typedCode: string | null,
  context: WithdrawalMatchContext,
): Promise<WithdrawalMatchOutcome> {
  const event = eventFromTransaction(transaction);
  const code = typedCode ?? last6(event.txCode);
  // Q8 — the same payout code on another withdrawal: flag, never block.
  const twins = await findWithdrawalCodeTwins(tx, code, row.id);
  const reasons: RiskReason[] =
    twins.length > 0 ? ['DUPLICATE_PAYOUT_CODE'] : [];
  const score = scoreVerification(reasons, true);
  const before = await tx.withdrawal.findUniqueOrThrow({
    where: { id: row.id },
  });

  const claim = await tx.withdrawal.updateMany({
    where: {
      id: row.id,
      status: 'APPROVED',
      bankCheckedAt: null,
      transferTransactionCode: typedCode,
    },
    data: {
      transferAmount: event.amount,
      ...(typedCode === null && { transferTransactionCode: code }),
      transferTransactionTime: yangonTimeOfDay(event.occurredAt),
      transferTransactionAt: event.occurredAt,
      transferEventKey: event.idempotencyKey,
      ...(transaction.screenshotKey !== null && {
        transferScreenshotKey: transaction.screenshotKey,
      }),
      bankCheckedAt: now,
      matchStatus: score.matchStatus,
      riskLevel: score.riskLevel,
      riskReasons: score.riskReasons,
    },
  });
  if (claim.count !== 1) {
    throw new Error('WITHDRAWAL_CLAIMED_CONCURRENTLY');
  }

  const after = await tx.withdrawal.findUniqueOrThrow({
    where: { id: row.id },
  });
  await audit.record({
    action: 'withdrawal.bank_match',
    actor: context.actor,
    target: {
      type: 'withdrawal',
      id: row.id,
      label: `${row.amount.toFixed(2)} Ks`,
    },
    before: withdrawalSnapshot(before),
    after: withdrawalSnapshot(after),
    metadata: {
      ...transactionMetadata(transaction),
      trigger: auditTrigger(context, typedCode !== null),
      matchKey: typedCode === null ? 'amount_window' : 'transaction_code',
      bankTransactionId: transaction.id,
      outcome: 'matched',
      matchStatus: score.matchStatus,
      riskReasons: score.riskReasons,
    },
    tx,
  });

  await linkToWithdrawal(
    tx,
    audit,
    transaction,
    row.id,
    now,
    context.trigger,
    context.actor,
  );

  const changedTwins = await flagWithdrawalCodeTwins(tx, audit, twins, {
    ...transactionMetadata(transaction),
    trigger: 'bank_match',
    anchorWithdrawalId: row.id,
  });

  return {
    result: {
      idempotencyKey: event.idempotencyKey,
      outcome: 'matched',
      transactionId: transaction.id,
      state: 'MATCHED',
      withdrawalId: row.id,
      matchStatus: score.matchStatus,
      screenshotWanted: transaction.screenshotKey === null,
    },
    touchedWithdrawalIds: [row.id, ...changedTwins.map((twin) => twin.id)],
    transactionChanged: true,
  };
}

/**
 * The typed code names a stored record of ANOTHER amount: AMOUNT_MISMATCH
 * (a hard reason → SUSPICIOUS) on the withdrawal, through the ordinary risk
 * helper, only when not already there. The bank row is not written here.
 */
async function flagCodeAmountMismatch(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: CodedWithdrawalRow,
  transaction: StoredBankTransaction,
  context: WithdrawalMatchContext,
): Promise<boolean> {
  const riskReasons = normalizeReasons([...row.riskReasons, 'AMOUNT_MISMATCH']);
  if (reasonsEqual(riskReasons, row.riskReasons)) return false;
  await updateWithdrawalRisk(
    tx,
    audit,
    { ...row, status: 'APPROVED', bankCheckedAt: null },
    scoreVerification(riskReasons, false),
    {
      ...transactionMetadata(transaction),
      trigger: auditTrigger(context, true),
      bankTransactionId: transaction.id,
      reason: 'CODE_AMOUNT_MISMATCH',
    },
  );
  return true;
}

async function flagAmbiguous(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  candidates: readonly OpenWithdrawalRow[],
  transaction: StoredBankTransaction,
  context: WithdrawalMatchContext,
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
      {
        ...transactionMetadata(transaction),
        trigger: 'ambiguous_match',
        // Which staff action re-ran the record, when it was not the phone.
        ...(context.trigger !== 'ingestion' && { cause: context.trigger }),
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
    touchedWithdrawalIds: touched,
    transactionChanged,
  };
}

/**
 * Q3 (transferEventKey — legacy backfill) → Q7c (the typed code, W3) → Q7
 * (amount + window) → 0 stored_unmatched / 1 claim / ≥ 2 ambiguous. The
 * phone's post and Resend run it with INGESTION_CONTEXT; an approval re-runs
 * it for the records it may now complete (rematchParkedSentTransaction).
 */
export async function applySentEvent(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  transaction: StoredBankTransaction,
  now: Date = new Date(),
  context: WithdrawalMatchContext = INGESTION_CONTEXT,
): Promise<WithdrawalMatchOutcome> {
  const applied = await tx.withdrawal.findUnique({
    where: { transferEventKey: transaction.idempotencyKey },
    select: { id: true, matchStatus: true, bankCheckedAt: true },
  });
  if (applied) {
    await linkToWithdrawal(
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
        withdrawalId: applied.id,
        matchStatus: applied.matchStatus,
        screenshotWanted: transaction.screenshotKey === null,
      },
      touchedWithdrawalIds: [applied.id],
      transactionChanged: true,
    };
  }

  // W3 — staff typed this record's code before it arrived. Exactly one such
  // withdrawal decides the record: claimed when the amount agrees; when it
  // does not, the withdrawal is flagged and the record stays UNMATCHED —
  // the amount-only search is NOT run for a record that names a code.
  // Two (or none) fall through to Q7 unchanged, which never sees rows
  // carrying a typed code.
  const coded = await findCodedWithdrawalsForEvent(tx, transaction);
  if (coded.length === 1) {
    const [row] = coded;
    if (amountsEqual(row.amount, transaction.amount)) {
      return claimWithdrawal(
        tx,
        audit,
        row,
        transaction,
        now,
        row.transferTransactionCode,
        context,
      );
    }
    const flagged = await flagCodeAmountMismatch(
      tx,
      audit,
      row,
      transaction,
      context,
    );
    const transactionChanged = await markUnmatched(tx, audit, transaction);
    return {
      result: {
        idempotencyKey: transaction.idempotencyKey,
        outcome: 'stored_unmatched',
        transactionId: transaction.id,
        state: 'UNMATCHED',
        reason: 'CODE_AMOUNT_MISMATCH',
        screenshotWanted: transaction.screenshotKey === null,
      },
      touchedWithdrawalIds: flagged ? [row.id] : [],
      transactionChanged,
    };
  }

  const candidates = await findOpenWithdrawalsByAmount(
    tx,
    transaction.amount,
    transaction.occurredAt,
    transaction.paymentAccountId,
  );
  if (candidates.length === 1) {
    return claimWithdrawal(
      tx,
      audit,
      candidates[0],
      transaction,
      now,
      null,
      context,
    );
  }
  if (candidates.length > 1) {
    return flagAmbiguous(tx, audit, candidates, transaction, context);
  }
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
    touchedWithdrawalIds: [],
    transactionChanged,
  };
}

// ---------------------------------------------------------------------------
// The staff look-backs — called by WithdrawalsService AFTER its own write
// committed, each in its own transaction (a failure there never undoes or
// fails the approval / the save).
// ---------------------------------------------------------------------------

/**
 * W2, one record: re-read a parked "sent" record by primary key and, if it
 * is still parked, run applySentEvent on it exactly as the phone's Resend
 * would — the existing rules decide. null = no longer parked (matched or
 * linked since the lookup), nothing done.
 */
export async function rematchParkedSentTransaction(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  transactionId: string,
  now: Date,
  context: WithdrawalMatchContext,
): Promise<WithdrawalMatchOutcome | null> {
  const record = await tx.bankTransaction.findUnique({
    where: { id: transactionId },
  });
  if (
    !record ||
    record.direction !== 'SENT' ||
    record.state === 'MATCHED' ||
    record.linkedWithdrawalId !== null ||
    record.linkedDepositId !== null
  ) {
    return null;
  }
  return applySentEvent(tx, audit, record, now, context);
}

export interface TypedCodeCheckOutcome {
  outcome:
    | 'matched'
    | 'amount_mismatch'
    | 'ambiguous'
    | 'no_record'
    | 'not_applicable';
  /** Parked records carrying the code: 0, 1, or 2 meaning "two or more". */
  candidates: number;
  /** Withdrawals whose verification state changed (after-commit push). */
  touchedWithdrawalIds: string[];
  /** The bank_transactions row that was linked (after-commit push). */
  changedTransactionId: string | null;
}

const TYPED_CODE_ROW_SELECT = {
  ...CODED_WITHDRAWAL_SELECT,
  status: true,
  bankCheckedAt: true,
} satisfies Prisma.WithdrawalSelect;

/**
 * W1 — the code staff typed in "Our Transfer Account" is a key into the
 * parked "sent" records (Q-BT4): only for an APPROVED, not bank-checked
 * withdrawal that carries a typed code. Exactly one record with the same
 * amount → the code-key claim; exactly one with another amount →
 * AMOUNT_MISMATCH on the withdrawal, the record untouched; two → nothing
 * (the caller logs counts only); none → nothing. Idempotent, so an
 * unchanged re-save simply runs it again.
 */
export async function matchTypedCode(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  withdrawalId: string,
  now: Date,
  context: WithdrawalMatchContext,
): Promise<TypedCodeCheckOutcome> {
  const nothing = (
    outcome: TypedCodeCheckOutcome['outcome'],
    candidates = 0,
  ): TypedCodeCheckOutcome => ({
    outcome,
    candidates,
    touchedWithdrawalIds: [],
    changedTransactionId: null,
  });

  const row = await tx.withdrawal.findUnique({
    where: { id: withdrawalId },
    select: TYPED_CODE_ROW_SELECT,
  });
  if (
    !row ||
    row.status !== WithdrawalStatus.APPROVED ||
    row.bankCheckedAt !== null ||
    row.approvedAt === null ||
    row.transferTransactionCode === null
  ) {
    return nothing('not_applicable');
  }
  const coded: CodedWithdrawalRow = {
    ...row,
    transferTransactionCode: row.transferTransactionCode,
  };

  const records = await findParkedSentByCode(
    tx,
    coded.transferTransactionCode,
    coded.transferPaymentAccountId,
    row.approvedAt,
  );
  if (records.length === 0) return nothing('no_record');
  if (records.length > 1) return nothing('ambiguous', records.length);

  const [record] = records;
  if (amountsEqual(record.amount, coded.amount)) {
    const claimed = await claimWithdrawal(
      tx,
      audit,
      coded,
      record,
      now,
      coded.transferTransactionCode,
      context,
    );
    return {
      outcome: 'matched',
      candidates: 1,
      touchedWithdrawalIds: claimed.touchedWithdrawalIds,
      changedTransactionId: record.id,
    };
  }
  const flagged = await flagCodeAmountMismatch(
    tx,
    audit,
    coded,
    record,
    context,
  );
  return {
    outcome: 'amount_mismatch',
    candidates: 1,
    touchedWithdrawalIds: flagged ? [coded.id] : [],
    changedTransactionId: null,
  };
}
