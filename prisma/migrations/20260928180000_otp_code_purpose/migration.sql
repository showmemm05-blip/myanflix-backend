-- B1 (H-8 / H-6 review minor): every OTP code is bound to the flow it was
-- requested for. A code requested for sign-in (LOGIN) no longer resets a
-- password, and a PASSWORD_RESET code no longer signs anyone in.
-- Existing rows become LOGIN (the column default). A code requested for a
-- reset before this change is therefore a sign-in code: the person simply
-- asks for a new reset code (codes live 5 minutes anyway).
-- Pre-flight: none needed (a new enum type and a column with a default).

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "otp_codes" ADD COLUMN     "purpose" "OtpPurpose" NOT NULL DEFAULT 'LOGIN';
