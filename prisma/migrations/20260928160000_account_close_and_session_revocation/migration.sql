-- H-16: an account its owner deleted (DELETE /users/me) is kept, anonymised,
-- under the new terminal status CLOSED, so its money records stay intact.
-- H-21: users.sessionsRevokedAt is the moment every session of the account
-- was last revoked; access tokens issued in an earlier second are refused.
-- Existing rows keep NULL (never revoked). No backfill.
-- Pre-flight: none needed (a new enum value and a nullable column).

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "sessionsRevokedAt" TIMESTAMP(3);
