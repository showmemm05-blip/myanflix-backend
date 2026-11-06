import {
  LotteryClaimRejectReason,
  LotteryClaimStatus,
  LotteryPayoutStatus,
} from '../../generated/prisma/client';
import {
  CLAIM_LIST_STATUS_WIRE,
  CLAIM_REJECT_REASON_WIRE,
  CLAIM_STATUS_WIRE,
  claimStatusToWire,
  payoutClaimStatus,
  PRIZE_CLAIM_STATUS_WIRE,
  rejectReasonFromWire,
  rejectReasonToWire,
} from './claim-status';

describe('claim-status', () => {
  it('spells a claim status the way the apps read it', () => {
    expect(claimStatusToWire(LotteryClaimStatus.REQUESTED)).toBe('requested');
    expect(claimStatusToWire(LotteryClaimStatus.PAID)).toBe('paid');
    expect(claimStatusToWire(LotteryClaimStatus.REJECTED)).toBe('rejected');
    expect(CLAIM_STATUS_WIRE).toEqual(['requested', 'paid', 'rejected']);
  });

  it('reads a prize’s place in the claim flow from its payout status alone', () => {
    expect(payoutClaimStatus(LotteryPayoutStatus.UNCLAIMED)).toBe(
      'not_requested',
    );
    expect(payoutClaimStatus(LotteryPayoutStatus.REQUESTED)).toBe('requested');
    expect(payoutClaimStatus(LotteryPayoutStatus.PAID)).toBe('paid');
    expect(payoutClaimStatus(LotteryPayoutStatus.REJECTED)).toBe('rejected');
    expect(payoutClaimStatus(LotteryPayoutStatus.EXPIRED)).toBe('expired');
    // Every payout status has a word, and every word is one the lists filter on.
    for (const status of Object.values(LotteryPayoutStatus)) {
      expect(PRIZE_CLAIM_STATUS_WIRE).toContain(payoutClaimStatus(status));
    }
    expect(CLAIM_LIST_STATUS_WIRE).toEqual([
      'requested',
      'paid',
      'rejected',
      'not_requested',
      'all',
    ]);
  });

  it('maps the rejection reasons both ways, and null stays null', () => {
    for (const reason of CLAIM_REJECT_REASON_WIRE) {
      expect(rejectReasonToWire(rejectReasonFromWire(reason))).toBe(reason);
    }
    expect(rejectReasonFromWire('other')).toBe(LotteryClaimRejectReason.OTHER);
    expect(
      rejectReasonToWire(LotteryClaimRejectReason.TICKET_UNDER_REVIEW),
    ).toBe('ticket_under_review');
    expect(rejectReasonToWire(null)).toBeNull();
  });
});
