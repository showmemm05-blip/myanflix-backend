-- SMS gateway (company Android phone + company SIM, SMS_PROVIDER=phone-gateway).
-- sms_messages is the outgoing queue the gateway phone long-polls: one row
-- per SMS, leased atomically, reported back as SENT/FAILED/DELIVERED/
-- DELIVERY_FAILED, swept to EXPIRED (never leased in time) or UNKNOWN
-- (leased, no result before the lease ran out). Nothing is ever re-queued.
-- otpCodeId is UNIQUE so one OTP code is queued at most once; the FK is
-- ON DELETE SET NULL so removing a code never removes its send record.
-- sms_gateway_devices holds the last heartbeat of each gateway phone.
-- Pre-flight: none needed (a new enum type and two new, empty tables; no
-- existing table changes).

-- CreateEnum
CREATE TYPE "SmsMessageStatus" AS ENUM ('QUEUED', 'LEASED', 'SENT', 'DELIVERED', 'FAILED', 'DELIVERY_FAILED', 'EXPIRED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" UUID NOT NULL,
    "otpCodeId" TEXT,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SmsMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "deviceId" TEXT,
    "leasedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_gateway_devices" (
    "id" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "appVersion" TEXT NOT NULL,
    "battery" INTEGER NOT NULL,
    "charging" BOOLEAN NOT NULL,
    "signalLevel" INTEGER,
    "networkType" TEXT,
    "simOperator" TEXT,
    "pendingResults" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_gateway_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_messages_otpCodeId_key" ON "sms_messages"("otpCodeId");

-- CreateIndex
CREATE INDEX "sms_messages_status_createdAt_idx" ON "sms_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "sms_messages_expiresAt_idx" ON "sms_messages"("expiresAt");

-- CreateIndex
CREATE INDEX "sms_messages_createdAt_idx" ON "sms_messages"("createdAt");

-- AddForeignKey
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_otpCodeId_fkey" FOREIGN KEY ("otpCodeId") REFERENCES "otp_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

