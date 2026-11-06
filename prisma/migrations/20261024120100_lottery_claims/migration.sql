-- Prize payment by request, part B (2026-10-24). Publishing a draw now only
-- AWARDS the prizes (payouts UNCLAIMED, no money moves); the customer asks
-- for payment in the app — one claim per customer per draw — and a staff
-- member with the new LOTTERY.CLAIMS_CONFIRM confirms (one wallet credit,
-- one LOTTERY_PRIZE transaction) or rejects it. Two claim enums, the
-- lottery_claims table, the claim link on lottery_payouts, the prize total
-- and claim deadline on lottery_draws, the deadline setting, the backfill
-- of the draws already paid at publish, and the ADMIN grant. DDL
-- hand-written to match prisma/schema.prisma like the lottery_results
-- migration (the enum values themselves are in 20261024120000).
-- Pre-flight: none needed. Rows already PAID at publish stay PAID; the
-- backfill only ADDS one PAID claim per (draw, customer) over them and
-- links the payouts to it — nothing is re-paid.

-- CreateEnum
CREATE TYPE "LotteryClaimStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "LotteryClaimRejectReason" AS ENUM ('SUSPICIOUS_ACCOUNT', 'DUPLICATE_REQUEST', 'TICKET_UNDER_REVIEW', 'OTHER');

-- AlterTable
ALTER TABLE "lottery_settings" ADD COLUMN     "claimDeadlineDays" INTEGER NOT NULL DEFAULT 90;

-- AlterTable
ALTER TABLE "lottery_draws" ADD COLUMN     "prizeTotalKs" DECIMAL(12,2),
ADD COLUMN     "claimDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "lottery_payouts" ADD COLUMN     "claimId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'UNCLAIMED';

-- CreateTable
CREATE TABLE "lottery_claims" (
    "id" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "LotteryClaimStatus" NOT NULL DEFAULT 'REQUESTED',
    "ticketsCount" INTEGER NOT NULL,
    "baht" DECIMAL(12,2) NOT NULL,
    "ks" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "rejectReason" "LotteryClaimRejectReason",
    "rejectNote" VARCHAR(300),
    "transactionId" TEXT,
    "paidAtPublish" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lottery_claims_transactionId_key" ON "lottery_claims"("transactionId");

-- CreateIndex
CREATE INDEX "lottery_claims_status_requestedAt_idx" ON "lottery_claims"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "lottery_claims_userId_requestedAt_idx" ON "lottery_claims"("userId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "lottery_claims_decidedByUserId_idx" ON "lottery_claims"("decidedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_claims_drawId_userId_key" ON "lottery_claims"("drawId", "userId");

-- CreateIndex
CREATE INDEX "lottery_payouts_claimId_idx" ON "lottery_payouts"("claimId");

-- CreateIndex
CREATE INDEX "lottery_payouts_drawId_status_idx" ON "lottery_payouts"("drawId", "status");

-- AddForeignKey
ALTER TABLE "lottery_payouts" ADD CONSTRAINT "lottery_payouts_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "lottery_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_claims" ADD CONSTRAINT "lottery_claims_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_claims" ADD CONSTRAINT "lottery_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_claims" ADD CONSTRAINT "lottery_claims_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_claims" ADD CONSTRAINT "lottery_claims_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Guard rails in the style of money_check_constraints: a claim is never
-- empty or negative, and the deadline setting stays within the admin
-- form's 1..730 days whatever writes it.

-- AddCheckConstraint
ALTER TABLE "lottery_claims" ADD CONSTRAINT "lottery_claims_values_check" CHECK ("ticketsCount" >= 1 AND "ks" >= 0 AND "baht" >= 0);

-- AddCheckConstraint
ALTER TABLE "lottery_settings" ADD CONSTRAINT "lottery_settings_claim_deadline_check" CHECK ("claimDeadlineDays" >= 1 AND "claimDeadlineDays" <= 730);

-- Backfill 1/3: every draw already published was paid in full at publish,
-- so its prize total IS what it paid, and its claim deadline is the
-- default 90 days after publishing (nothing is left to request anyway).
UPDATE "lottery_draws"
SET "prizeTotalKs" = "prizesPaidKs",
    "claimDeadlineAt" = "publishedAt" + interval '90 days'
WHERE "status" = 'PUBLISHED' AND "publishedAt" IS NOT NULL;

-- Backfill 2/3: one PAID claim per (draw, customer) over the payouts paid
-- at publish, flagged paidAtPublish so the admin page can say so. Its
-- figures are the payouts' sums, its times the first payout's createdAt,
-- its decider the staff member who published. No transaction is linked:
-- each of those payouts carries its own LOTTERY_PRIZE row already.
INSERT INTO "lottery_claims" (
  "id", "drawId", "userId", "status", "ticketsCount", "baht", "ks", "rate",
  "requestedAt", "decidedAt", "decidedByUserId", "paidAtPublish",
  "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), p."drawId", p."userId", 'PAID',
       COUNT(*)::int, SUM(p."baht"), SUM(p."ks"), MAX(p."rate"),
       MIN(p."createdAt"), MIN(p."createdAt"), d."publishedByUserId", true,
       now(), now()
FROM "lottery_payouts" p
JOIN "lottery_draws" d ON d."id" = p."drawId"
WHERE p."status" = 'PAID'
GROUP BY p."drawId", p."userId", d."publishedByUserId";

-- Backfill 3/3: link those payouts to their claim.
UPDATE "lottery_payouts" p
SET "claimId" = c."id"
FROM "lottery_claims" c
WHERE p."drawId" = c."drawId" AND p."userId" = c."userId" AND p."status" = 'PAID';

-- Grant the new LOTTERY permission to the already-seeded ADMIN role, the
-- same way lottery_results granted RESULTS_PUBLISH — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: paying prizes is operations.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'LOTTERY.CLAIMS_CONFIRM')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
