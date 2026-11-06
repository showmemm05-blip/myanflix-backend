import {
  LotteryClaimRejectReason,
  LotteryClaimStatus,
  LotteryPayoutStatus,
} from '../../generated/prisma/client';

/**
 * The wire words of the prize-claim flow (2026-10-24), shared by the
 * customer routes, the admin routes, the ticket wire and the admin winners
 * table so every surface spells a status the same way. Pure — no Nest.
 */

/** A claim row's status as the apps read it. */
export const CLAIM_STATUS_WIRE = ['requested', 'paid', 'rejected'] as const;
export type ClaimStatusWire = (typeof CLAIM_STATUS_WIRE)[number];

/**
 * A PRIZE's claim status as a ticket, a winner row or the draw's claim
 * view carries it: the claim's status once one exists, else whether the
 * prize is still waiting to be requested or has expired.
 */
export const PRIZE_CLAIM_STATUS_WIRE = [
  'not_requested',
  'requested',
  'paid',
  'rejected',
  'expired',
] as const;
export type PrizeClaimStatusWire = (typeof PRIZE_CLAIM_STATUS_WIRE)[number];

/** The customer's DrawClaimView status: the prize statuses plus "none" (no winning ticket). */
export type DrawClaimStatusWire = PrizeClaimStatusWire | 'none';

/** The admin list's `status` filter: one tab, or everything. */
export const CLAIM_LIST_STATUS_WIRE = [
  'requested',
  'paid',
  'rejected',
  'not_requested',
  'all',
] as const;
export type ClaimListStatusWire = (typeof CLAIM_LIST_STATUS_WIRE)[number];

export const CLAIM_REJECT_REASON_WIRE = [
  'suspicious_account',
  'duplicate_request',
  'ticket_under_review',
  'other',
] as const;
export type ClaimRejectReasonWire = (typeof CLAIM_REJECT_REASON_WIRE)[number];

const CLAIM_STATUS_TO_WIRE: Record<LotteryClaimStatus, ClaimStatusWire> = {
  [LotteryClaimStatus.REQUESTED]: 'requested',
  [LotteryClaimStatus.PAID]: 'paid',
  [LotteryClaimStatus.REJECTED]: 'rejected',
};

/**
 * The payout statuses mirror the claim's (request → REQUESTED, confirm →
 * PAID, reject → REJECTED, reopen → REQUESTED), so a payout's own status
 * says it all: UNCLAIMED is a prize nobody asked for yet, EXPIRED one
 * whose deadline passed first.
 */
const PAYOUT_STATUS_TO_WIRE: Record<LotteryPayoutStatus, PrizeClaimStatusWire> =
  {
    [LotteryPayoutStatus.UNCLAIMED]: 'not_requested',
    [LotteryPayoutStatus.REQUESTED]: 'requested',
    [LotteryPayoutStatus.PAID]: 'paid',
    [LotteryPayoutStatus.REJECTED]: 'rejected',
    [LotteryPayoutStatus.EXPIRED]: 'expired',
  };

const REJECT_REASON_TO_WIRE: Record<
  LotteryClaimRejectReason,
  ClaimRejectReasonWire
> = {
  [LotteryClaimRejectReason.SUSPICIOUS_ACCOUNT]: 'suspicious_account',
  [LotteryClaimRejectReason.DUPLICATE_REQUEST]: 'duplicate_request',
  [LotteryClaimRejectReason.TICKET_UNDER_REVIEW]: 'ticket_under_review',
  [LotteryClaimRejectReason.OTHER]: 'other',
};

const REJECT_REASON_FROM_WIRE: Record<
  ClaimRejectReasonWire,
  LotteryClaimRejectReason
> = {
  suspicious_account: LotteryClaimRejectReason.SUSPICIOUS_ACCOUNT,
  duplicate_request: LotteryClaimRejectReason.DUPLICATE_REQUEST,
  ticket_under_review: LotteryClaimRejectReason.TICKET_UNDER_REVIEW,
  other: LotteryClaimRejectReason.OTHER,
};

export const claimStatusToWire = (
  status: LotteryClaimStatus,
): ClaimStatusWire => CLAIM_STATUS_TO_WIRE[status];

export const payoutClaimStatus = (
  status: LotteryPayoutStatus,
): PrizeClaimStatusWire => PAYOUT_STATUS_TO_WIRE[status];

export const rejectReasonToWire = (
  reason: LotteryClaimRejectReason | null,
): ClaimRejectReasonWire | null =>
  reason === null ? null : REJECT_REASON_TO_WIRE[reason];

export const rejectReasonFromWire = (
  reason: ClaimRejectReasonWire,
): LotteryClaimRejectReason => REJECT_REASON_FROM_WIRE[reason];
