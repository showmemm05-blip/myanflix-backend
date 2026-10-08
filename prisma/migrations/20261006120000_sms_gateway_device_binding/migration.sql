-- SMS gateway device binding (security audit 2026-10-06, H-5 / H-7 / M-28).
-- The shared SMS_GATEWAY_TOKEN alone used to open the device routes for ANY
-- X-Device-Id, so whoever held the token could run a second "phone" and
-- take every login code. sms_gateway_binding is a single row (id 1): the
-- first device uuid that presents the right token is pinned in deviceId,
-- every other uuid is refused (401) and noted in lastRejected*, and a super
-- admin clears the pin (DELETE /sms-gateway/binding) after a phone
-- reinstall. No row = nothing pinned yet: the real phone pins itself on its
-- next poll or heartbeat after this deploys (no backfill needed).
-- Pre-flight: none needed (one new, empty table; no existing table changes).

-- CreateTable
CREATE TABLE "sms_gateway_binding" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "deviceId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "lastRejectedDeviceId" TEXT,
    "lastRejectedAt" TIMESTAMP(3),
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3),
    "resetById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_gateway_binding_pkey" PRIMARY KEY ("id")
);
