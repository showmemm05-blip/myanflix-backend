-- Withdrawal code (owner-approved 2026-10-05): every POST /withdrawals must
-- carry the account's 6-digit withdrawal code.
--  * users.withdrawalCodeHash: bcrypt hash of the code (never the code).
--    NULL = no code yet; the account's next withdrawal creates one first.
--  * users.withdrawalCodeSetAt: when the code was created/changed/reset.
--  * users.withdrawalCodeFailedCount / withdrawalCodeLockedUntil: wrong
--    codes in a row, and the 15-minute lock the 5th one sets.
--  * OtpPurpose gains WITHDRAWAL_CODE_RESET: the SMS code of the signed-in
--    "forgot withdrawal code" flow. It never signs anyone in or resets a
--    password, and LOGIN / PASSWORD_RESET codes never reset this code.
-- Existing accounts get NULL / 0 / NULL: nobody has a code yet, so everyone
-- (including people who withdrew before) creates one on their next
-- withdrawal. No backfill.
-- Pre-flight: none needed. ADD VALUE only appends to the enum (the value is
-- not used in this migration, so it is safe inside the migration's
-- transaction); the new columns are nullable or have a constant default.

-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'WITHDRAWAL_CODE_RESET';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "withdrawalCodeFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "withdrawalCodeHash" TEXT,
ADD COLUMN     "withdrawalCodeLockedUntil" TIMESTAMP(3),
ADD COLUMN     "withdrawalCodeSetAt" TIMESTAMP(3);
