import { BankMatchStatus, BankRiskLevel } from '../generated/prisma/client';

/**
 * The bank-verification rulebook: every constant, reason code, weight and
 * the deterministic mapping from reasons to matchStatus/riskLevel. Pure —
 * no database, no clock (callers pass `now`) — so every rule is unit-tested
 * in isolation and the matcher/service files only orchestrate.
 */

// ---------------------------------------------------------------------------
// Time constants — each with the reason it is that number and not another.
// ---------------------------------------------------------------------------

/**
 * The phone's clock, the bank's timestamp and the server's clock are three
 * different clocks; five minutes covers every honest disagreement we have
 * seen and is far below the gap a fraudster needs.
 */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * A user who transferred must submit within a day; the same 24 h is when a
 * pending deposit becomes NO_BANK_TRANSACTION, so the two rules are one
 * number.
 */
export const DEPOSIT_MATCH_WINDOW_MS = 24 * 3_600_000;

/** By construction equal to the match window — see DEPOSIT_MATCH_WINDOW_MS. */
export const NO_BANK_TRANSACTION_AFTER_MS = DEPOSIT_MATCH_WINDOW_MS;

/**
 * Staff pay out the day they approve; a "sent" notification a day after
 * approval is still that payout.
 */
export const WITHDRAWAL_PAYOUT_WINDOW_MS = 24 * 3_600_000;

/**
 * Three submissions in ten minutes is what reference-guessing looks like; a
 * real person tops up once. Counts ROWS only — refused duplicates never
 * became rows, which the owner accepts.
 */
export const VELOCITY_LIMIT = 3;
export const VELOCITY_WINDOW_MS = 10 * 60_000;
/** Q5 only needs "≥ VELOCITY_LIMIT", never the exact count — cap the scan. */
export const VELOCITY_PROBE_LIMIT = 10;

/** Q2 only needs to tell 0 / 1 / "more than one" apart. */
export const AMBIGUITY_PROBE_LIMIT = 3;

/** Bounds Q4; a reference reused more than 20 times is flagged the same way. */
export const TWIN_PROBE_LIMIT = 20;

/** Bounds Q8 — one other row is already a flag. */
export const PAYOUT_CODE_PROBE_LIMIT = 5;

/**
 * Fills the legacy `receivingTransactionTime` / `transferTransactionTime`
 * HH:MM:SS columns from the full timestamp in the owner's local time, as an
 * admin would have typed it. Myanmar has no DST, so a fixed offset is exact.
 */
export const YANGON_UTC_OFFSET_MINUTES = 390;

// ---------------------------------------------------------------------------
// Reasons, weights, classes
// ---------------------------------------------------------------------------

export const RISK_REASONS = [
  'SHARED_REFERENCE_ACROSS_USERS',
  'AMOUNT_MISMATCH',
  'SUBMITTED_BEFORE_TRANSFER',
  'CODE_MISMATCH',
  'DUPLICATE_PAYOUT_CODE',
  'AMBIGUOUS_MATCH',
  'DUPLICATE_REFERENCE',
  'TIME_GAP_TOO_LARGE',
  'NO_BANK_TRANSACTION',
  'VELOCITY',
] as const;

export type RiskReason = (typeof RISK_REASONS)[number];

/**
 * Deterministic weights. Hard reasons are the ones that cannot be honest
 * (or, for a payout, that could mean money went out twice); soft reasons
 * are "look at this" — a reused reference, an ambiguous transfer, a long
 * gap, a burst of submissions, silence from the bank.
 */
export const RISK_REASON_WEIGHTS: Readonly<Record<RiskReason, number>> = {
  SHARED_REFERENCE_ACROSS_USERS: 70,
  AMOUNT_MISMATCH: 60,
  SUBMITTED_BEFORE_TRANSFER: 60,
  CODE_MISMATCH: 50,
  DUPLICATE_PAYOUT_CODE: 50,
  AMBIGUOUS_MATCH: 40,
  DUPLICATE_REFERENCE: 30,
  TIME_GAP_TOO_LARGE: 30,
  NO_BANK_TRANSACTION: 30,
  VELOCITY: 20,
};

export const HARD_REASONS: ReadonlySet<RiskReason> = new Set<RiskReason>([
  'SHARED_REFERENCE_ACROSS_USERS',
  'AMOUNT_MISMATCH',
  'SUBMITTED_BEFORE_TRANSFER',
  'CODE_MISMATCH',
  'DUPLICATE_PAYOUT_CODE',
]);

/**
 * The reasons that describe a row's relation to OTHER rows sharing its
 * reference. Recomputed as a class: when twins change, exactly these are
 * replaced and every other stored reason is kept.
 */
export const REFERENCE_TWIN_REASONS: readonly RiskReason[] = [
  'DUPLICATE_REFERENCE',
  'SHARED_REFERENCE_ACROSS_USERS',
];

/** Same idea for withdrawals sharing a payout code. */
export const PAYOUT_CODE_TWIN_REASONS: readonly RiskReason[] = [
  'DUPLICATE_PAYOUT_CODE',
];

/** Read-time only — never stored, so nothing ever has to sweep it. */
export const READ_TIME_ONLY_REASONS: ReadonlySet<RiskReason> =
  new Set<RiskReason>(['NO_BANK_TRANSACTION']);

export function isRiskReason(value: unknown): value is RiskReason {
  return (
    typeof value === 'string' &&
    (RISK_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Reasons are a SET: sorted, de-duplicated, unknown strings dropped (a stale
 * value from an older build must not survive in the column), read-time-only
 * codes dropped (they are derived, never persisted). Idempotent, so a
 * recompute that changes nothing produces a byte-identical array — which is
 * what lets the update paths skip unchanged rows.
 */
export function normalizeReasons(reasons: Iterable<string>): RiskReason[] {
  const set = new Set<RiskReason>();
  for (const reason of reasons) {
    if (isRiskReason(reason) && !READ_TIME_ONLY_REASONS.has(reason)) {
      set.add(reason);
    }
  }
  return [...set].sort();
}

export function reasonsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = normalizeReasons(a);
  const right = normalizeReasons(b);
  return (
    left.length === right.length &&
    left.every((reason, i) => reason === right[i])
  );
}

/**
 * Replace one CLASS of reasons on a stored set: everything in `classReasons`
 * is removed, then `computed` (which must only contain class members) is
 * added. Used for the twin recomputes so a row's unrelated reasons
 * (AMOUNT_MISMATCH, VELOCITY, …) survive its twins changing.
 */
export function replaceReasonClass(
  stored: readonly string[],
  classReasons: readonly RiskReason[],
  computed: readonly RiskReason[],
): RiskReason[] {
  const kept = normalizeReasons(stored).filter(
    (reason) => !classReasons.includes(reason),
  );
  return normalizeReasons([...kept, ...computed]);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function riskScore(reasons: readonly RiskReason[]): number {
  return reasons.reduce((sum, reason) => sum + RISK_REASON_WEIGHTS[reason], 0);
}

/** 0–29 → LOW; 30–59 → MEDIUM; ≥ 60 → HIGH. */
export function riskLevelForScore(score: number): BankRiskLevel {
  if (score >= 60) return BankRiskLevel.HIGH;
  if (score >= 30) return BankRiskLevel.MEDIUM;
  return BankRiskLevel.LOW;
}

const RISK_LEVEL_RANK: Readonly<Record<BankRiskLevel, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export function maxRiskLevel(
  a: BankRiskLevel | null,
  b: BankRiskLevel | null,
): BankRiskLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return RISK_LEVEL_RANK[a] >= RISK_LEVEL_RANK[b] ? a : b;
}

export interface VerificationScore {
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: RiskReason[];
}

/**
 * THE mapping (deterministic, pure):
 *   no reasons + bank values present → MATCHED / LOW
 *   no reasons + no bank values      → UNVERIFIED / not scored (null)
 *   any hard reason                  → SUSPICIOUS / by score
 *   only soft reasons                → PENDING_REVIEW / by score
 * MATCHED therefore requires every exact check to have passed AND an empty
 * reason list — exactly as decided with the owner.
 */
export function scoreVerification(
  reasons: Iterable<string>,
  hasBankValues: boolean,
): VerificationScore {
  const riskReasons = normalizeReasons(reasons);
  if (riskReasons.length === 0) {
    return hasBankValues
      ? {
          matchStatus: BankMatchStatus.MATCHED,
          riskLevel: BankRiskLevel.LOW,
          riskReasons,
        }
      : {
          matchStatus: BankMatchStatus.UNVERIFIED,
          riskLevel: null,
          riskReasons,
        };
  }
  const hard = riskReasons.some((reason) => HARD_REASONS.has(reason));
  return {
    matchStatus: hard
      ? BankMatchStatus.SUSPICIOUS
      : BankMatchStatus.PENDING_REVIEW,
    riskLevel: riskLevelForScore(riskScore(riskReasons)),
    riskReasons,
  };
}

// ---------------------------------------------------------------------------
// Individual rules — each returns the reason it detects, or null.
// ---------------------------------------------------------------------------

/** Equality on money — both sides normalised to a 2 dp string. */
export function amountsEqual(
  a: { toFixed(dp: number): string },
  b: { toFixed(dp: number): string },
): boolean {
  return a.toFixed(2) === b.toFixed(2);
}

/**
 * Case-insensitive compare of two last-6 codes. The user's `reference` is
 * digits-only so case cannot matter there; a bank code can mix letters and
 * we store it as the bank prints it, so the compare must not.
 */
export function codesEqual(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** The last six characters as printed — the part the user is asked to type. */
export function last6(code: string): string {
  return code.slice(-6);
}

/**
 * Timing reasons for a deposit against the bank's timestamp.
 *
 * SUBMITTED_BEFORE_TRANSFER always uses `createdAt` — you cannot submit a
 * code the bank has not printed yet, and `declaredTransferAt` is user-typed
 * so it must never soften this. TIME_GAP_TOO_LARGE uses the user's own
 * declared transfer time when present (the honest "I paid yesterday and am
 * submitting now" case), else `createdAt`.
 */
export function depositTimingReasons(
  row: { createdAt: Date; declaredTransferAt: Date | null },
  occurredAt: Date,
): RiskReason[] {
  const reasons: RiskReason[] = [];
  const bank = occurredAt.getTime();
  if (row.createdAt.getTime() < bank - CLOCK_SKEW_MS) {
    reasons.push('SUBMITTED_BEFORE_TRANSFER');
  }
  const t = (row.declaredTransferAt ?? row.createdAt).getTime();
  if (t - bank > DEPOSIT_MATCH_WINDOW_MS) {
    reasons.push('TIME_GAP_TOO_LARGE');
  }
  return reasons;
}

/**
 * Reference-twin reasons for one row given the OTHER rows carrying the same
 * reference (any status — a REJECTED twin is still a reused reference).
 * SHARED_REFERENCE_ACROSS_USERS needs no second query: same reference AND
 * same amount from a different user is right there in the twin list.
 */
export function referenceTwinReasons(
  me: { userId: string; amount: { toFixed(dp: number): string } },
  twins: readonly {
    userId: string;
    amount: { toFixed(dp: number): string };
  }[],
): RiskReason[] {
  if (twins.length === 0) return [];
  const reasons: RiskReason[] = ['DUPLICATE_REFERENCE'];
  if (
    twins.some(
      (twin) =>
        twin.userId !== me.userId && amountsEqual(twin.amount, me.amount),
    )
  ) {
    reasons.push('SHARED_REFERENCE_ACROSS_USERS');
  }
  return reasons;
}

/** `recentCount` includes the row itself when it is inside the window. */
export function velocityReasons(recentCount: number): RiskReason[] {
  return recentCount >= VELOCITY_LIMIT ? ['VELOCITY'] : [];
}

// ---------------------------------------------------------------------------
// Read-time derivation — Q12. Nothing is ever written for it.
// ---------------------------------------------------------------------------

/** The stored enum plus the one value that only exists in a response. */
export type BankMatchStatusView = BankMatchStatus | 'NO_BANK_TRANSACTION';

/**
 * PENDING, never bank-checked, and older than the window: the bank has had
 * its 24 h and said nothing. Computed from `now` at read time, so it flips
 * on its own with no timer and no write.
 */
export function isNoBankTransaction(
  row: { status: string; bankCheckedAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  return (
    row.status === 'PENDING' &&
    row.bankCheckedAt === null &&
    row.createdAt.getTime() < now.getTime() - NO_BANK_TRANSACTION_AFTER_MS
  );
}

/**
 * The withdrawal twin: APPROVED, never bank-checked, no code keyed in by
 * hand, and approved longer ago than the payout window — the bank should
 * have said "You sent …" by now and has not.
 */
export function isWithdrawalNoBankTransaction(
  row: {
    status: string;
    bankCheckedAt: Date | null;
    transferTransactionCode: string | null;
    approvedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    row.status === 'APPROVED' &&
    row.bankCheckedAt === null &&
    row.transferTransactionCode === null &&
    row.approvedAt !== null &&
    row.approvedAt.getTime() < now.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS
  );
}

export interface VerificationView {
  matchStatus: BankMatchStatusView;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

interface StoredVerification {
  matchStatus: BankMatchStatus;
  riskLevel: BankRiskLevel | null;
  riskReasons: string[];
}

/** The stored state with NO_BANK_TRANSACTION layered on top. */
function layerNoBank(
  row: StoredVerification,
  noBank: boolean,
): VerificationView {
  if (!noBank) {
    return {
      matchStatus: row.matchStatus,
      riskLevel: row.riskLevel,
      riskReasons: [...row.riskReasons],
    };
  }
  return {
    matchStatus: 'NO_BANK_TRANSACTION',
    riskLevel: maxRiskLevel(row.riskLevel, BankRiskLevel.MEDIUM),
    riskReasons: [...row.riskReasons, 'NO_BANK_TRANSACTION'],
  };
}

/**
 * What an admin response / admin realtime payload shows for a deposit: the
 * stored state with NO_BANK_TRANSACTION layered on top when it applies
 * (reason appended, level raised to at least MEDIUM, view status replaced).
 */
export function verificationView(
  row: StoredVerification & {
    status: string;
    bankCheckedAt: Date | null;
    createdAt: Date;
  },
  now: Date,
): VerificationView {
  return layerNoBank(row, isNoBankTransaction(row, now));
}

/** Same for a withdrawal, keyed on approvedAt and the open payout set. */
export function withdrawalVerificationView(
  row: StoredVerification & {
    status: string;
    bankCheckedAt: Date | null;
    transferTransactionCode: string | null;
    approvedAt: Date | null;
  },
  now: Date,
): VerificationView {
  return layerNoBank(row, isWithdrawalNoBankTransaction(row, now));
}

// ---------------------------------------------------------------------------
// Time-of-day for the legacy columns
// ---------------------------------------------------------------------------

/** "HH:MM:SS" in Asia/Yangon (UTC+6:30) — the format the admin form stores. */
export function yangonTimeOfDay(at: Date): string {
  const shifted = new Date(at.getTime() + YANGON_UTC_OFFSET_MINUTES * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}`;
}
