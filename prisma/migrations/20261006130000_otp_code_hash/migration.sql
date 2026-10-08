-- M-1 (security audit 2026-10-06): one-time SMS codes are no longer stored
-- in plain text. otp_codes.code (the 6 digits) becomes otp_codes.codeHash,
-- an HMAC-SHA256 of the code under a server secret (OTP_CODE_PEPPER, or a
-- key derived from JWT_SECRET when that is unset) — see
-- src/otp/otp-code.hasher.ts. A database read alone no longer gives a
-- reset or sign-in code away.
--
-- Every row is deleted first: the plain codes in them are exactly what this
-- migration removes, they can no longer be checked once the column holds
-- hashes, and a code only lives 5 minutes anyway — whoever was mid sign-in
-- when the backend restarts simply asks for a new code. sms_messages rows
-- that pointed at them keep working (otpCodeId is ON DELETE SET NULL).
-- Pre-flight: none needed.

-- Clear the plain-text codes.
DELETE FROM "otp_codes";

-- AlterTable
ALTER TABLE "otp_codes" DROP COLUMN "code",
ADD COLUMN     "codeHash" TEXT NOT NULL;
