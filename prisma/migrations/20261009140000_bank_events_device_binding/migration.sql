-- Bank-events device binding (audit 2026-10-09, SEC-004 / DB-015, step 1.1).
-- The shared BANK_EVENTS_TOKEN alone used to open the phone-monitor routes
-- for ANY caller, so whoever held it could post a forged "You received …"
-- event that made a never-paid deposit look bank-verified. bank_events_binding
-- is a single row (id 1), the exact twin of sms_gateway_binding: the first
-- X-Device-Serial that presents the right token is pinned in deviceSerial,
-- every other serial is refused (401 DEVICE_SERIAL_REJECTED), noted in
-- lastRejected* and written to the audit log, and a super admin clears the
-- pin (DELETE /bank-events/binding) after the monitor is reinstalled or moved
-- to another PC. No row = nothing pinned yet: the owner's phone-monitor pins
-- itself on its next post or socket handshake after this deploys (no backfill
-- needed; a monitor build that sends no serial is refused with 401
-- DEVICE_SERIAL_REQUIRED until it is updated).
-- Pre-flight: none needed (one new, empty table; no existing table changes).

-- CreateTable
CREATE TABLE "bank_events_binding" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "deviceSerial" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "lastRejectedDeviceSerial" TEXT,
    "lastRejectedAt" TIMESTAMP(3),
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3),
    "resetById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_events_binding_pkey" PRIMARY KEY ("id")
);
