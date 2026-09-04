-- "Continue with Google". ADDITIVE ONLY: two nullable columns and their
-- unique indexes on `users`. Every existing row keeps NULL in both (Postgres
-- unique indexes ignore NULLs, so any number of NULLs coexist) — phone and
-- staff accounts are untouched. Hand-written so the names match what Prisma
-- generates for User.email / User.googleId (`prisma migrate diff` afterwards
-- is a no-op). users_email_key existed once and was dropped in
-- 20260814081137_remove_user_email; recreating the name is safe because
-- that index no longer exists.

ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "googleId" TEXT;

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");
