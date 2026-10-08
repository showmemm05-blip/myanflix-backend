-- SMS gateway hardening (follows 20260930120000_sms_gateway, which is left
-- untouched).
--  * SmsMessageStatus gains CANCELLED: a QUEUED SMS whose code a newer code
--    for the same phone and purpose replaced (or whose account was closed)
--    is cancelled, so the phone never sends the stale code.
--  * sms_messages.redactedAt: when the body (and, on account close, the
--    phone) was replaced with "[redacted]". The sweeper redacts final rows
--    an hour old; the partial index keeps that pass to the rows still
--    holding a body.
--  * sms_messages (phone, createdAt): the per-phone daily cap, the resend
--    cancel and the account-close redaction look rows up by phone.
--  * sms_gateway_devices.canSend / notReadyReason: the phone's own "I can
--    send" verdict from its heartbeat. Existing rows default to true (an app
--    that does not report it keeps working as before).
-- Pre-flight: none needed. ADD VALUE only appends to the enum (the value is
-- not used in this migration, so it is safe inside the migration's
-- transaction); the new columns are nullable or have a constant default,
-- so existing rows need no backfill.

-- AlterEnum
ALTER TYPE "SmsMessageStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "sms_messages" ADD COLUMN     "redactedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sms_gateway_devices" ADD COLUMN     "canSend" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notReadyReason" TEXT;

-- CreateIndex
CREATE INDEX "sms_messages_phone_createdAt_idx" ON "sms_messages"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "sms_messages_unredacted_createdAt_idx" ON "sms_messages"("createdAt") WHERE ("redactedAt" IS NULL);
