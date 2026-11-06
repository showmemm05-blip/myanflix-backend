-- Lottery results, prizes and payouts (lottery backend phase 3,
-- 2026-10-19). Three enums, two tables, the publish columns on
-- lottery_draws, the results source on lottery_settings, money guard
-- rails in the style of money_check_constraints, and the
-- LOTTERY.RESULTS_PUBLISH grant for the seeded ADMIN role. DDL
-- hand-written to match prisma/schema.prisma like the lottery_draws
-- migration; the grant is plain SQL, idempotent.
-- Pre-flight: none needed (new tables and nullable / defaulted columns
-- only; no existing row changes).

-- CreateEnum
CREATE TYPE "LotteryResultStatus" AS ENUM ('PENDING', 'FETCHED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "LotteryResultSource" AS ENUM ('API', 'MANUAL');

-- CreateEnum
CREATE TYPE "LotteryPayoutStatus" AS ENUM ('PAID');

-- AlterTable
ALTER TABLE "lottery_settings" ADD COLUMN     "resultsUrl" TEXT,
ADD COLUMN     "resultsSourceKind" TEXT NOT NULL DEFAULT 'thai_lotto_json';

-- AlterTable
ALTER TABLE "lottery_draws" ADD COLUMN     "winnersCount" INTEGER,
ADD COLUMN     "prizesPaidKs" DECIMAL(12,2),
ADD COLUMN     "publishedByUserId" TEXT;

-- CreateTable
CREATE TABLE "lottery_results" (
    "id" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "status" "LotteryResultStatus" NOT NULL DEFAULT 'PENDING',
    "source" "LotteryResultSource",
    "fetchedAt" TIMESTAMP(3),
    "enteredByUserId" TEXT,
    "raw" JSONB,
    "groups" JSONB NOT NULL DEFAULT '[]',
    "sourceDate" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_payouts" (
    "id" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groups" JSONB NOT NULL,
    "baht" DECIMAL(12,2) NOT NULL,
    "ks" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "transactionId" TEXT,
    "status" "LotteryPayoutStatus" NOT NULL DEFAULT 'PAID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lottery_draws_publishedByUserId_idx" ON "lottery_draws"("publishedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_results_drawId_key" ON "lottery_results"("drawId");

-- CreateIndex
CREATE INDEX "lottery_results_enteredByUserId_idx" ON "lottery_results"("enteredByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_payouts_ticketId_key" ON "lottery_payouts"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_payouts_transactionId_key" ON "lottery_payouts"("transactionId");

-- CreateIndex
CREATE INDEX "lottery_payouts_drawId_idx" ON "lottery_payouts"("drawId");

-- CreateIndex
CREATE INDEX "lottery_payouts_userId_createdAt_idx" ON "lottery_payouts"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_results" ADD CONSTRAINT "lottery_results_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_results" ADD CONSTRAINT "lottery_results_enteredByUserId_fkey" FOREIGN KEY ("enteredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "lottery_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Guard rails in the style of money_check_constraints: a prize, a rate or
-- a count that the service already refuses can never land here from a
-- script either. A payout of 0 Ks is allowed on purpose (a group whose
-- Baht prize is 0 still marks the ticket as won).

-- AddCheckConstraint
ALTER TABLE "lottery_results" ADD CONSTRAINT "lottery_results_values_check" CHECK ("attempts" >= 0 AND jsonb_typeof("groups") = 'array');

-- AddCheckConstraint
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_money_check" CHECK ("baht" >= 0 AND "ks" >= 0 AND "rate" > 0 AND jsonb_typeof("groups") = 'array');

-- AddCheckConstraint
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_publish_check" CHECK (("winnersCount" IS NULL OR "winnersCount" >= 0) AND ("prizesPaidKs" IS NULL OR "prizesPaidKs" >= 0));

-- Grant the new LOTTERY permission to the already-seeded ADMIN role, the
-- same way lottery_draws granted DRAWS_MANAGE / SETTINGS_MANAGE — the seed
-- arrays in src/roles/system-roles.seed.ts only describe a fresh database;
-- existing app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: paying prizes is operations.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'LOTTERY.RESULTS_PUBLISH')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
