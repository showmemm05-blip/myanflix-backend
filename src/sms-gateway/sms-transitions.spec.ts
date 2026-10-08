import { SmsMessageStatus } from '../generated/prisma/client';
import {
  REPORTABLE_SMS_STATUSES,
  decideTransition,
  type ReportableSmsStatus,
} from './sms-transitions';

const {
  QUEUED,
  LEASED,
  SENT,
  DELIVERED,
  FAILED,
  DELIVERY_FAILED,
  EXPIRED,
  UNKNOWN,
  CANCELLED,
} = SmsMessageStatus;

describe('decideTransition', () => {
  const allowed: [SmsMessageStatus, ReportableSmsStatus][] = [
    [LEASED, SENT],
    [LEASED, FAILED],
    [SENT, DELIVERED],
    [SENT, DELIVERY_FAILED],
    [UNKNOWN, SENT],
    [UNKNOWN, FAILED],
    [EXPIRED, SENT],
    [EXPIRED, FAILED],
  ];

  it.each(allowed)('%s -> %s is applied', (from, to) => {
    expect(decideTransition(from, to)).toBe('apply');
  });

  it.each(REPORTABLE_SMS_STATUSES.map((s) => [s]))(
    'reporting %s again on a row already there is an idempotent repeat',
    (status) => {
      expect(decideTransition(status, status)).toBe('repeat');
    },
  );

  it('everything else is a conflict (409), including results for a row never leased', () => {
    const all = Object.values(SmsMessageStatus);
    for (const from of all) {
      for (const to of REPORTABLE_SMS_STATUSES) {
        if (from === to) continue;
        const isAllowed = allowed.some(([f, t]) => f === from && t === to);
        expect([from, to, decideTransition(from, to)]).toEqual([
          from,
          to,
          isAllowed ? 'apply' : 'conflict',
        ]);
      }
    }
    expect(decideTransition(QUEUED, SENT)).toBe('conflict');
    expect(decideTransition(DELIVERED, SENT)).toBe('conflict');
    expect(decideTransition(FAILED, SENT)).toBe('conflict');
    expect(decideTransition(LEASED, DELIVERED)).toBe('conflict');
    expect(decideTransition(UNKNOWN, DELIVERED)).toBe('conflict');
    // Cancelled before any device took it: nothing to report, ever.
    for (const to of REPORTABLE_SMS_STATUSES) {
      expect(decideTransition(CANCELLED, to)).toBe('conflict');
    }
  });
});
