import { SmsMessageStatus } from '../generated/prisma/client';

/** What the gateway phone may report for a job it leased. */
export const REPORTABLE_SMS_STATUSES = [
  SmsMessageStatus.SENT,
  SmsMessageStatus.FAILED,
  SmsMessageStatus.DELIVERED,
  SmsMessageStatus.DELIVERY_FAILED,
] as const;
export type ReportableSmsStatus = (typeof REPORTABLE_SMS_STATUSES)[number];

/**
 * Every result a row in each status accepts. Anything missing here is a 409
 * (the phone treats 409 as "acknowledged" and stops retrying):
 *
 *  - LEASED -> SENT | FAILED            the normal send outcome;
 *  - SENT -> DELIVERED | DELIVERY_FAILED the carrier's delivery report;
 *  - UNKNOWN -> SENT | FAILED            a late report after the lease ran
 *                                        out (the sweeper had given up);
 *  - EXPIRED -> SENT | FAILED            a late report on an expired row.
 *
 * QUEUED, CANCELLED, DELIVERED, FAILED and DELIVERY_FAILED accept nothing:
 * a row the phone never leased (QUEUED, or CANCELLED by a newer code before
 * any device took it) cannot have a result, and the last three are final.
 */
const ALLOWED: Partial<
  Record<SmsMessageStatus, readonly ReportableSmsStatus[]>
> = {
  [SmsMessageStatus.LEASED]: [SmsMessageStatus.SENT, SmsMessageStatus.FAILED],
  [SmsMessageStatus.SENT]: [
    SmsMessageStatus.DELIVERED,
    SmsMessageStatus.DELIVERY_FAILED,
  ],
  [SmsMessageStatus.UNKNOWN]: [SmsMessageStatus.SENT, SmsMessageStatus.FAILED],
  [SmsMessageStatus.EXPIRED]: [SmsMessageStatus.SENT, SmsMessageStatus.FAILED],
};

export type TransitionDecision = 'apply' | 'repeat' | 'conflict';

/**
 * `repeat` when the row already holds exactly the reported status (the
 * phone's uploader retried after a lost 200 — answer 200 again, change
 * nothing), `apply` for an allowed move, `conflict` for everything else.
 */
export function decideTransition(
  current: SmsMessageStatus,
  reported: ReportableSmsStatus,
): TransitionDecision {
  if (current === reported) return 'repeat';
  return ALLOWED[current]?.includes(reported) ? 'apply' : 'conflict';
}
