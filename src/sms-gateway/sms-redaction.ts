import { type Prisma, SmsMessageStatus } from '../generated/prisma/client';
import { SMS_REDACTED } from '../sms/sms.config';

/**
 * Statuses no device will ever be handed again. SENT and UNKNOWN still
 * accept a late result (sms-transitions.ts), but the body is no longer
 * needed for that: nothing is ever re-sent.
 */
export const FINAL_SMS_STATUSES: readonly SmsMessageStatus[] = [
  SmsMessageStatus.SENT,
  SmsMessageStatus.DELIVERED,
  SmsMessageStatus.FAILED,
  SmsMessageStatus.DELIVERY_FAILED,
  SmsMessageStatus.EXPIRED,
  SmsMessageStatus.UNKNOWN,
  SmsMessageStatus.CANCELLED,
];

/**
 * The sweeper's privacy pass: replaces the body of every final row that
 * still holds one with SMS_REDACTED, at the next sweep (a privacy extra of
 * the 2026-10-06 fix round — no audit finding asked for it; M-28 is the
 * canSend / throttle denial-of-service finding: a code that was sent,
 * failed or expired has no business sitting in the database — it used to
 * stay readable for an hour). The result report and
 * the sweeper's own EXPIRED/UNKNOWN moves blank the body as they happen;
 * this pass catches the rest (a CANCELLED resend, rows from before the
 * rule). The phone number stays (the staff card and the per-phone cap read
 * it) until the account is closed. Only rows not yet redacted are visited
 * (partial index on createdAt WHERE redactedAt IS NULL).
 */
export function redactFinalSmsBodies(
  client: Prisma.TransactionClient,
  now: Date,
): Promise<Prisma.BatchPayload> {
  return client.smsMessage.updateMany({
    where: {
      redactedAt: null,
      status: { in: [...FINAL_SMS_STATUSES] },
    },
    data: { body: SMS_REDACTED, redactedAt: now },
  });
}

/**
 * Account close (H-16, DELETE /users/me), inside its transaction: every SMS
 * row for the closed account's phone loses the number and the body at
 * once, whatever its age. A QUEUED one is CANCELLED first — its code was
 * just deleted and the phone must never send it (to a number now reading
 * "[redacted]"). A LEASED one keeps its status: the phone already holds the
 * job, and its result still lands.
 */
export async function redactSmsForClosedAccount(
  tx: Prisma.TransactionClient,
  phone: string,
  now = new Date(),
): Promise<{ cancelled: number; redacted: number }> {
  const cancelled = await tx.smsMessage.updateMany({
    where: { phone, status: SmsMessageStatus.QUEUED },
    data: { status: SmsMessageStatus.CANCELLED },
  });
  const redacted = await tx.smsMessage.updateMany({
    where: { phone },
    data: { phone: SMS_REDACTED, body: SMS_REDACTED, redactedAt: now },
  });
  return { cancelled: cancelled.count, redacted: redacted.count };
}
