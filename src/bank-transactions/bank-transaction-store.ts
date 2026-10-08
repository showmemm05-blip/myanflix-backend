import {
  BankTransactionDirection,
  BankTransactionState,
  Prisma,
} from '../generated/prisma/client';
import type { BankTransaction } from '../generated/prisma/client';
import type { AuditService } from '../audit/audit.service';
import { bankTransactionSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { NormalizedBankEvent } from '../bank-events/bank-event.types';
import type { BankEventDirection } from '../bank-events/dto/bank-event-batch.dto';
import {
  CLOCK_SKEW_MS,
  CODE_KEY_PROBE_LIMIT,
  PARKED_REMATCH_LIMIT,
  UNCLAIMED_AFTER_MS,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  isPlainCode,
} from '../bank-events/risk-rules';
import { decimalToNumber } from '../common/utils/decimal.util';
import type {
  BankTransactionPayload,
  RealtimeGateway,
} from '../realtime/realtime.gateway';

/**
 * The bank_transactions row helpers shared by ingestion (BankEventsService
 * → the matchers), deposit creation (DepositsService.create's reverse
 * lookup) and the staff reviews (unlink). Plain functions over a
 * Prisma.TransactionClient + AuditService — like deposit-risk.ts — so
 * BankEventsModule, DepositsModule and WithdrawalsModule all import this
 * file and never each other's services (no Nest cycle).
 *
 * Every query here is one index probe: the unique event key (store), the
 * primary key (link / state change), the unique link column (unlink), or
 * the partial open-set index (the reverse lookup, Q-BT1, whose predicate
 * is literal SQL for the same reason deposit-matcher.ts spells out its
 * own) — or, for the parked "sent" look-backs, a range on occurredAt that
 * a time window bounds. Nothing walks the table; "unclaimed" is computed,
 * never stored.
 */

// ---------------------------------------------------------------------------
// Direction mapping — the wire says 'received' / 'sent', the column RECEIVED / SENT.
// ---------------------------------------------------------------------------

export function directionOf(
  direction: BankEventDirection,
): BankTransactionDirection {
  return direction === 'received'
    ? BankTransactionDirection.RECEIVED
    : BankTransactionDirection.SENT;
}

export function eventDirectionOf(
  direction: BankTransactionDirection,
): BankEventDirection {
  return direction === BankTransactionDirection.RECEIVED ? 'received' : 'sent';
}

// ---------------------------------------------------------------------------
// Store (Q-BT0)
// ---------------------------------------------------------------------------

/** What ingestion stores — the validated batch event plus the optional new keys. */
export interface StoreBankEventInput extends NormalizedBankEvent {
  currency: string;
  postedAt: Date | null;
  counterparty: string | null;
  detailStatus: string | null;
}

/**
 * The columns the matchers need from a stored row — the full Prisma row
 * satisfies it, and so does Q-BT1's narrower SELECT.
 */
export interface StoredBankTransaction {
  id: string;
  idempotencyKey: string;
  deviceSerial: string;
  paymentAccountId: string;
  direction: BankTransactionDirection;
  amount: Prisma.Decimal;
  txCode: string;
  txCodeLast6: string;
  occurredAt: Date;
  screenshotKey: string | null;
  state: BankTransactionState;
  /**
   * The bank's "from" name as the phone parsed it (best effort, may be
   * null). Optional: only the deposit matcher reads it (M-16), and a row
   * built without it simply skips the name check.
   */
  counterparty?: string | null;
}

/** The audit-metadata shape every system row about a transaction carries. */
export function transactionMetadata(row: StoredBankTransaction) {
  return {
    source: 'phone-monitor',
    idempotencyKey: row.idempotencyKey,
    deviceSerial: row.deviceSerial,
    paymentAccountId: row.paymentAccountId,
    direction: eventDirectionOf(row.direction),
  };
}

/**
 * Q-BT0 — one stored row per event key. Read by the unique index first; a
 * key seen before is returned as-is (its state decides what the caller
 * does next), an unseen one is inserted and audited. A concurrent insert
 * of the same key (a phone whose earlier post timed out while the server
 * was still on it) trips the unique index: Postgres aborts the enclosing
 * transaction, the caller answers `error`, the phone retries and finds the
 * stored row. Never an upsert-by-scan.
 */
export async function storeTransaction(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: StoreBankEventInput,
): Promise<{ row: BankTransaction; created: boolean }> {
  const existing = await tx.bankTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return { row: existing, created: false };

  const row = await tx.bankTransaction.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      deviceSerial: input.deviceSerial,
      paymentAccountId: input.paymentAccountId,
      direction: directionOf(input.direction),
      amount: input.amount,
      currency: input.currency,
      txCode: input.txCode,
      txCodeLast6: input.txCodeLast6,
      occurredAt: input.occurredAt,
      // The phone's post time when it sent one; the bank's time otherwise
      // (a phone-monitor from before this table does not send postedAt).
      postedAt: input.postedAt ?? input.occurredAt,
      counterparty: input.counterparty,
      detailStatus: input.detailStatus,
    },
  });
  await audit.record({
    action: 'bank_transaction.store',
    actor: null,
    target: {
      type: 'bank_transaction',
      id: row.id,
      label: `${eventDirectionOf(row.direction)} · ${row.deviceSerial}`,
    },
    after: bankTransactionSnapshot(row),
    metadata: transactionMetadata(row),
    tx,
  });
  return { row, created: true };
}

// ---------------------------------------------------------------------------
// The open set (Q-BT1)
// ---------------------------------------------------------------------------

function toStoredRow(raw: Record<string, unknown>): StoredBankTransaction {
  return {
    id: String(raw.id),
    idempotencyKey: String(raw.idempotencyKey),
    deviceSerial: String(raw.deviceSerial),
    paymentAccountId: String(raw.paymentAccountId),
    direction: BankTransactionDirection.RECEIVED,
    amount: new Prisma.Decimal(raw.amount as string | number),
    txCode: String(raw.txCode),
    txCodeLast6: String(raw.txCodeLast6),
    occurredAt: new Date(raw.occurredAt as string | Date),
    screenshotKey:
      typeof raw.screenshotKey === 'string' ? raw.screenshotKey : null,
    state: BankTransactionState.UNMATCHED,
    counterparty:
      typeof raw.counterparty === 'string' ? raw.counterparty : null,
  };
}

/**
 * Q-BT1 — the "You received …" rows for this account and last-6 that
 * nobody has claimed. Index: bank_transactions_open_received_idx, whose
 * predicate is spelled out here as LITERAL SQL so Postgres can prove the
 * query implies it — a bound `state = $n` cannot, and would fall back to
 * the (account, occurredAt) index and a heap filter over the account's
 * whole history. No age bound: an unclaimed row still matches a day-late
 * deposit (the deposit then carries the timing reasons). LIMIT 2 tells
 * 0 / 1 / ≥ 2 apart and never reads more.
 */
export async function findOpenReceivedTransactions(
  tx: Prisma.TransactionClient,
  paymentAccountId: string,
  txCodeLast6: string,
): Promise<StoredBankTransaction[]> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT id, "idempotencyKey", "deviceSerial", "paymentAccountId", amount, "txCode", "txCodeLast6", "occurredAt", "screenshotKey", counterparty
      FROM bank_transactions
      WHERE "paymentAccountId" = ${paymentAccountId}
        AND "txCodeLast6" = ${txCodeLast6}
        AND state = 'UNMATCHED'::"BankTransactionState"
        AND direction = 'RECEIVED'::"BankTransactionDirection"
      LIMIT 2`,
  );
  return rows.map(toStoredRow);
}

/** The matcher's input shape, from a stored row — money and time already typed. */
export function eventFromTransaction(
  row: StoredBankTransaction,
): NormalizedBankEvent {
  return {
    idempotencyKey: row.idempotencyKey,
    deviceSerial: row.deviceSerial,
    paymentAccountId: row.paymentAccountId,
    direction: eventDirectionOf(row.direction),
    amount: row.amount,
    txCode: row.txCode,
    txCodeLast6: row.txCodeLast6,
    occurredAt: row.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// Link / state (Q-BT2, Q-BT2b)
// ---------------------------------------------------------------------------

/**
 * Who caused a link: the phone's post, a freshly submitted deposit, a
 * re-post of a key an older build had already applied — or a staff action
 * that looked back at the parked "sent" records (a code typed in "Our
 * Transfer Account", an approval).
 */
export type LinkTrigger =
  | 'ingestion'
  | 'deposit_create'
  | 'legacy_backfill'
  | 'transfer_account_update'
  | 'withdrawal_approve';

/**
 * Q-BT2 — mark the row MATCHED and point it at its deposit, by primary key,
 * guarded on "not already MATCHED" (an AMBIGUOUS row a re-post has just
 * resolved may link; a MATCHED one never re-links). count ≠ 1 means
 * another event won the row between lookup and write: THROW, so the
 * caller's whole transaction — including the deposit claim it just wrote
 * — rolls back and the phone's retry starts clean. linkedDepositId is
 * UNIQUE as the last line of defence against a double link.
 */
export async function linkToDeposit(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: StoredBankTransaction,
  depositId: string,
  matchedAt: Date,
  trigger: LinkTrigger,
): Promise<void> {
  const linked = await tx.bankTransaction.updateMany({
    where: {
      id: row.id,
      state: {
        in: [BankTransactionState.UNMATCHED, BankTransactionState.AMBIGUOUS],
      },
    },
    data: {
      state: BankTransactionState.MATCHED,
      linkedDepositId: depositId,
      matchedAt,
    },
  });
  if (linked.count !== 1) {
    throw new Error('BANK_TRANSACTION_CLAIMED_CONCURRENTLY');
  }
  await audit.record({
    action: 'bank_transaction.link',
    actor: null,
    target: { type: 'bank_transaction', id: row.id },
    before: { state: row.state, linkedDepositId: null },
    after: { state: BankTransactionState.MATCHED, linkedDepositId: depositId },
    metadata: { ...transactionMetadata(row), trigger, depositId },
    tx,
  });
}

/**
 * Mirror of linkToDeposit for a "You sent …" row and its withdrawal. The
 * same guard (UNMATCHED or AMBIGUOUS → MATCHED) serves every trigger, so a
 * code-key claim may resolve a row a same-amount ambiguity had parked.
 * `actor` is the admin whose action ran the look-back; null (a system row)
 * for the phone's post.
 */
export async function linkToWithdrawal(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: StoredBankTransaction,
  withdrawalId: string,
  matchedAt: Date,
  trigger: LinkTrigger,
  actor: AuthenticatedUser | null = null,
): Promise<void> {
  const linked = await tx.bankTransaction.updateMany({
    where: {
      id: row.id,
      state: {
        in: [BankTransactionState.UNMATCHED, BankTransactionState.AMBIGUOUS],
      },
    },
    data: {
      state: BankTransactionState.MATCHED,
      linkedWithdrawalId: withdrawalId,
      matchedAt,
    },
  });
  if (linked.count !== 1) {
    throw new Error('BANK_TRANSACTION_CLAIMED_CONCURRENTLY');
  }
  await audit.record({
    action: 'bank_transaction.link',
    actor,
    target: { type: 'bank_transaction', id: row.id },
    before: { state: row.state, linkedWithdrawalId: null },
    after: {
      state: BankTransactionState.MATCHED,
      linkedWithdrawalId: withdrawalId,
    },
    metadata: { ...transactionMetadata(row), trigger, withdrawalId },
    tx,
  });
}

/**
 * Q-BT2b — UNMATCHED → AMBIGUOUS when ≥ 2 candidates fit. Guarded so a
 * re-post of an already-AMBIGUOUS row costs no write and no audit row.
 * Returns whether the state actually changed.
 */
export async function markAmbiguous(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: StoredBankTransaction,
  candidateIds: readonly string[],
): Promise<boolean> {
  const changed = await tx.bankTransaction.updateMany({
    where: { id: row.id, state: BankTransactionState.UNMATCHED },
    data: { state: BankTransactionState.AMBIGUOUS },
  });
  if (changed.count !== 1) return false;
  await audit.record({
    action: 'bank_transaction.state_change',
    actor: null,
    target: { type: 'bank_transaction', id: row.id },
    before: { state: BankTransactionState.UNMATCHED },
    after: { state: BankTransactionState.AMBIGUOUS },
    metadata: {
      ...transactionMetadata(row),
      reason: 'MULTIPLE_CANDIDATES',
      candidateIds: [...candidateIds],
    },
    tx,
  });
  return true;
}

/**
 * AMBIGUOUS → UNMATCHED: a re-run found no candidate at all any more (an
 * admin rejected / resolved every one), or — for a "sent" row — its code
 * names a withdrawal of another amount, so the row is plainly waiting
 * again and re-enters the open set for a later deposit to claim. A stored
 * row is re-run by the phone's Resend (the phone posts once and never
 * retries a stored reply) and, for a "sent" row, by an approval whose
 * window now holds it (WithdrawalsService.approve → the withdrawal
 * matcher); a typed payout code claims one directly.
 */
export async function markUnmatched(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  row: StoredBankTransaction,
): Promise<boolean> {
  const changed = await tx.bankTransaction.updateMany({
    where: { id: row.id, state: BankTransactionState.AMBIGUOUS },
    data: { state: BankTransactionState.UNMATCHED },
  });
  if (changed.count !== 1) return false;
  await audit.record({
    action: 'bank_transaction.state_change',
    actor: null,
    target: { type: 'bank_transaction', id: row.id },
    before: { state: BankTransactionState.AMBIGUOUS },
    after: { state: BankTransactionState.UNMATCHED },
    metadata: { ...transactionMetadata(row), reason: 'NO_OPEN_CANDIDATE' },
    tx,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The PARKED "sent" set — the staff look-backs (Q-BT4, Q-BT5)
// ---------------------------------------------------------------------------

/**
 * "You sent …" rows no withdrawal has claimed yet: stored UNMATCHED (nothing
 * fitted when the phone posted) or AMBIGUOUS (more than one did), linked to
 * nothing either way. A payout used to be matched only when the phone
 * posted, so a record posted BEFORE the approval or the typed code stayed
 * here for good; the two lookups below let those staff actions look back.
 * Both are bounded by a window on occurredAt, served by the
 * (paymentAccountId, occurredAt) / (direction, occurredAt) /
 * (state, occurredAt) indexes — proportional to a day's transfers, never to
 * history. Ordinary Prisma filters: no partial index is involved, so a
 * bound enum parameter costs nothing here.
 */
const PARKED_SENT_WHERE = {
  direction: BankTransactionDirection.SENT,
  state: {
    in: [BankTransactionState.UNMATCHED, BankTransactionState.AMBIGUOUS],
  },
  linkedWithdrawalId: null,
  linkedDepositId: null,
} satisfies Prisma.BankTransactionWhereInput;

/**
 * Q-BT4 — the parked records carrying this payout code (last 6, ignoring
 * case), on the withdrawal's account when one is recorded (any account
 * otherwise), whose bank time is within WITHDRAWAL_PAYOUT_WINDOW_MS either
 * side of the approval. LIMIT 2: the caller only claims when exactly one
 * fits.
 */
export async function findParkedSentByCode(
  tx: Prisma.TransactionClient,
  code: string,
  paymentAccountId: string | null,
  approvedAt: Date,
): Promise<BankTransaction[]> {
  if (!isPlainCode(code)) return [];
  return tx.bankTransaction.findMany({
    where: {
      ...PARKED_SENT_WHERE,
      txCodeLast6: { equals: code, mode: 'insensitive' },
      occurredAt: {
        gte: new Date(approvedAt.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS),
        lte: new Date(approvedAt.getTime() + WITHDRAWAL_PAYOUT_WINDOW_MS),
      },
      ...(paymentAccountId !== null && { paymentAccountId }),
    },
    orderBy: { occurredAt: 'asc' },
    take: CODE_KEY_PROBE_LIMIT,
  });
}

/**
 * Q-BT5 — the parked records of this exact amount whose bank time is in
 * [approvedAt − CLOCK_SKEW_MS, approvedAt]: precisely the records whose
 * ingestion window (Q7: approvedAt ≤ bank time + CLOCK_SKEW_MS) now holds
 * this approval. Oldest first, bounded by PARKED_REMATCH_LIMIT.
 */
export async function findParkedSentForApproval(
  db: Pick<Prisma.TransactionClient, 'bankTransaction'>,
  amount: Prisma.Decimal,
  approvedAt: Date,
): Promise<BankTransaction[]> {
  return db.bankTransaction.findMany({
    where: {
      ...PARKED_SENT_WHERE,
      amount,
      occurredAt: {
        gte: new Date(approvedAt.getTime() - CLOCK_SKEW_MS),
        lte: approvedAt,
      },
    },
    orderBy: { occurredAt: 'asc' },
    take: PARKED_REMATCH_LIMIT,
  });
}

// ---------------------------------------------------------------------------
// Unlink (Q-BT3) — the staff review on a deposit / withdrawal
// ---------------------------------------------------------------------------

/**
 * Q-BT3 — the row that claimed this deposit goes back to UNMATCHED (so a
 * later deposit can claim it at create time), by the unique link column.
 * The screenshot object is NOT touched: it is the transaction's evidence,
 * the deposit merely pointed at it. Returns the transaction id for the
 * caller's after-commit realtime push, or null when the deposit's bank
 * values came from before this table existed (nothing linked).
 */
export async function unlinkByDeposit(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actor: AuthenticatedUser,
  depositId: string,
): Promise<string | null> {
  const linked = await tx.bankTransaction.findUnique({
    where: { linkedDepositId: depositId },
    select: { id: true, state: true },
  });
  if (!linked) return null;
  await tx.bankTransaction.update({
    where: { id: linked.id },
    data: {
      state: BankTransactionState.UNMATCHED,
      linkedDepositId: null,
      matchedAt: null,
    },
  });
  await audit.record({
    action: 'bank_transaction.unlink',
    actor,
    target: { type: 'bank_transaction', id: linked.id },
    before: { state: linked.state, linkedDepositId: depositId },
    after: { state: BankTransactionState.UNMATCHED, linkedDepositId: null },
    metadata: { depositId },
    tx,
  });
  return linked.id;
}

/** Mirror of unlinkByDeposit on linkedWithdrawalId. */
export async function unlinkByWithdrawal(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actor: AuthenticatedUser,
  withdrawalId: string,
): Promise<string | null> {
  const linked = await tx.bankTransaction.findUnique({
    where: { linkedWithdrawalId: withdrawalId },
    select: { id: true, state: true },
  });
  if (!linked) return null;
  await tx.bankTransaction.update({
    where: { id: linked.id },
    data: {
      state: BankTransactionState.UNMATCHED,
      linkedWithdrawalId: null,
      matchedAt: null,
    },
  });
  await audit.record({
    action: 'bank_transaction.unlink',
    actor,
    target: { type: 'bank_transaction', id: linked.id },
    before: { state: linked.state, linkedWithdrawalId: withdrawalId },
    after: {
      state: BankTransactionState.UNMATCHED,
      linkedWithdrawalId: null,
    },
    metadata: { withdrawalId },
    tx,
  });
  return linked.id;
}

// ---------------------------------------------------------------------------
// Read-time view — nothing is ever written for it
// ---------------------------------------------------------------------------

export type BankTransactionView = BankTransactionPayload['view'];

/**
 * What the admin sees: the stored state with "unclaimed" layered on top —
 * UNMATCHED and older than UNCLAIMED_AFTER_MS by the BANK's time. Computed
 * from `now` at read time so it flips on its own with no timer and no
 * write, exactly like NO_BANK_TRANSACTION on a deposit. A MATCHED row
 * whose links are both null (its deposit was hard-deleted; the FK is SET
 * NULL) reads as WAITING rather than claiming a match nothing backs.
 */
export function transactionView(
  row: {
    state: BankTransactionState;
    occurredAt: Date;
    linkedDepositId: string | null;
    linkedWithdrawalId: string | null;
  },
  now: Date,
): BankTransactionView {
  if (row.state === BankTransactionState.AMBIGUOUS) return 'AMBIGUOUS';
  if (row.state === BankTransactionState.MATCHED) {
    return row.linkedDepositId === null && row.linkedWithdrawalId === null
      ? 'WAITING'
      : 'MATCHED';
  }
  return row.occurredAt.getTime() < now.getTime() - UNCLAIMED_AFTER_MS
    ? 'UNCLAIMED'
    : 'WAITING';
}

/**
 * The admins-room realtime payload / the list item minus the account join.
 * The screenshot key never leaves the server — only `hasScreenshot`.
 */
export function bankTransactionPayload(
  row: BankTransaction,
  now: Date = new Date(),
): BankTransactionPayload {
  return {
    id: row.id,
    deviceSerial: row.deviceSerial,
    paymentAccountId: row.paymentAccountId,
    direction: row.direction,
    amount: decimalToNumber(row.amount),
    currency: row.currency,
    txCode: row.txCode,
    txCodeLast6: row.txCodeLast6,
    occurredAt: row.occurredAt,
    postedAt: row.postedAt,
    counterparty: row.counterparty,
    detailStatus: row.detailStatus,
    state: row.state,
    view: transactionView(row, now),
    linkedDepositId: row.linkedDepositId,
    linkedWithdrawalId: row.linkedWithdrawalId,
    matchedAt: row.matchedAt,
    hasScreenshot: row.screenshotKey !== null,
    createdAt: row.createdAt,
  };
}

/**
 * Q-BT8 — the stored row by primary key, after commit, to the admins room.
 * Shared by ingestion (BankEventsService) and the staff look-backs
 * (WithdrawalsService), so both push exactly the same payload.
 */
export async function pushBankTransactionChange(
  db: Pick<Prisma.TransactionClient, 'bankTransaction'>,
  gateway: Pick<
    RealtimeGateway,
    'notifyAdminsBankTransactionCreated' | 'notifyAdminsBankTransactionUpdated'
  >,
  id: string,
  kind: 'created' | 'updated',
): Promise<void> {
  const row = await db.bankTransaction.findUnique({ where: { id } });
  if (!row) return;
  const payload = bankTransactionPayload(row);
  if (kind === 'created') {
    gateway.notifyAdminsBankTransactionCreated(payload);
  } else {
    gateway.notifyAdminsBankTransactionUpdated(payload);
  }
}
