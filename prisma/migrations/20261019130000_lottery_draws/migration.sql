-- Lottery draws, settings, purchases and tickets (lottery backend phase 2,
-- 2026-10-19). Three enums, two TransactionType values, six tables, the
-- purchase-reference sequence, money guard rails in the style of
-- money_check_constraints, and the LOTTERY.DRAWS_MANAGE /
-- LOTTERY.SETTINGS_MANAGE grants for the seeded ADMIN role. DDL
-- hand-written to match prisma/schema.prisma like the lottery_dreams
-- migration; the grants are plain SQL, idempotent.
-- Pre-flight: none needed (new tables only; no existing table changes
-- beyond the two enum values, which nothing here uses yet).

-- CreateEnum
CREATE TYPE "LotteryDrawStatus" AS ENUM ('SCHEDULED', 'OPEN', 'PAUSED', 'CLOSED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "LotteryTicketStatus" AS ENUM ('WAITING', 'WON', 'NOT_WON');

-- CreateEnum
CREATE TYPE "LotteryPurchaseStatus" AS ENUM ('PAID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'LOTTERY_PURCHASE';
ALTER TYPE "TransactionType" ADD VALUE 'LOTTERY_PRIZE';

-- CreateTable
CREATE TABLE "lottery_settings" (
    "id" TEXT NOT NULL,
    "ticketPrice" DECIMAL(12,2) NOT NULL DEFAULT 1000,
    "maxPerNumber" INTEGER NOT NULL DEFAULT 20,
    "exchangeRate" DECIMAL(12,4) NOT NULL DEFAULT 75,
    "salesCloseMinutesBefore" INTEGER NOT NULL DEFAULT 60,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_draws" (
    "id" TEXT NOT NULL,
    "drawNo" INTEGER NOT NULL,
    "thaiDrawDate" DATE NOT NULL,
    "drawAt" TIMESTAMP(3) NOT NULL,
    "salesCloseAt" TIMESTAMP(3) NOT NULL,
    "status" "LotteryDrawStatus" NOT NULL DEFAULT 'SCHEDULED',
    "ticketPrice" DECIMAL(12,2) NOT NULL,
    "maxPerNumber" INTEGER NOT NULL,
    "exchangeRate" DECIMAL(12,4),
    "pictureUrl" TEXT,
    "nextTicketSeq" INTEGER NOT NULL DEFAULT 1,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_draws_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_off_sale_numbers" (
    "id" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "number" VARCHAR(6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_off_sale_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_purchases" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "status" "LotteryPurchaseStatus" NOT NULL DEFAULT 'PAID',
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_purchase_lines" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "number" VARCHAR(6) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "lottery_purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lottery_tickets" (
    "id" TEXT NOT NULL,
    "ticketNo" TEXT NOT NULL,
    "drawId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "number" VARCHAR(6) NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "LotteryTicketStatus" NOT NULL DEFAULT 'WAITING',
    "prizeKs" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lottery_settings_updatedByUserId_idx" ON "lottery_settings"("updatedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_draws_drawNo_key" ON "lottery_draws"("drawNo");

-- CreateIndex
CREATE INDEX "lottery_draws_status_drawAt_idx" ON "lottery_draws"("status", "drawAt");

-- CreateIndex
CREATE INDEX "lottery_draws_createdByUserId_idx" ON "lottery_draws"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_off_sale_numbers_drawId_number_key" ON "lottery_off_sale_numbers"("drawId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_purchases_ref_key" ON "lottery_purchases"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_purchases_transactionId_key" ON "lottery_purchases"("transactionId");

-- CreateIndex
CREATE INDEX "lottery_purchases_userId_createdAt_idx" ON "lottery_purchases"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "lottery_purchases_drawId_idx" ON "lottery_purchases"("drawId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_purchases_userId_idempotencyKey_key" ON "lottery_purchases"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_purchase_lines_purchaseId_number_key" ON "lottery_purchase_lines"("purchaseId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_tickets_ticketNo_key" ON "lottery_tickets"("ticketNo");

-- CreateIndex
CREATE INDEX "lottery_tickets_drawId_number_idx" ON "lottery_tickets"("drawId", "number");

-- CreateIndex
CREATE INDEX "lottery_tickets_userId_createdAt_idx" ON "lottery_tickets"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "lottery_tickets_userId_drawId_idx" ON "lottery_tickets"("userId", "drawId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_tickets_drawId_seq_key" ON "lottery_tickets"("drawId", "seq");

-- AddForeignKey
ALTER TABLE "lottery_settings" ADD CONSTRAINT "lottery_settings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_off_sale_numbers" ADD CONSTRAINT "lottery_off_sale_numbers_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_purchases" ADD CONSTRAINT "lottery_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_purchases" ADD CONSTRAINT "lottery_purchases_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_purchases" ADD CONSTRAINT "lottery_purchases_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_purchase_lines" ADD CONSTRAINT "lottery_purchase_lines_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "lottery_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "lottery_draws"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "lottery_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The purchase reference's running number: "LP-" + the Myanmar date as
-- yymmdd + "-" + this value, zero-padded to at least 4 digits
-- (LotteryPurchasesService / lottery-refs.ts). Never reset — the date in
-- front is for people, the sequence is what keeps the ref unique.
CREATE SEQUENCE "lottery_purchase_ref_seq" AS INTEGER MINVALUE 1 START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Guard rails in the style of money_check_constraints: a price, a total
-- or a quantity that the DTOs already refuse can never land here from a
-- script either. Numbers are six digits by definition of the lottery.

-- AddCheckConstraint
ALTER TABLE "lottery_settings" ADD CONSTRAINT "lottery_settings_values_check" CHECK ("ticketPrice" > 0 AND "maxPerNumber" >= 1 AND "exchangeRate" > 0 AND "salesCloseMinutesBefore" >= 0);

-- AddCheckConstraint
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_values_check" CHECK ("ticketPrice" > 0 AND "maxPerNumber" >= 1 AND "nextTicketSeq" >= 1 AND ("exchangeRate" IS NULL OR "exchangeRate" > 0));

-- AddCheckConstraint
ALTER TABLE "lottery_draws" ADD CONSTRAINT "lottery_draws_sales_close_check" CHECK ("salesCloseAt" <= "drawAt");

-- AddCheckConstraint
ALTER TABLE "lottery_off_sale_numbers" ADD CONSTRAINT "lottery_off_sale_numbers_number_check" CHECK ("number" ~ '^[0-9]{6}$');

-- AddCheckConstraint
ALTER TABLE "lottery_purchases" ADD CONSTRAINT "lottery_purchases_money_check" CHECK ("total" > 0 AND "unitPrice" > 0);

-- AddCheckConstraint
ALTER TABLE "lottery_purchase_lines" ADD CONSTRAINT "lottery_purchase_lines_values_check" CHECK ("quantity" >= 1 AND "number" ~ '^[0-9]{6}$');

-- AddCheckConstraint
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_values_check" CHECK ("seq" >= 1 AND "number" ~ '^[0-9]{6}$' AND ("prizeKs" IS NULL OR "prizeKs" >= 0));

-- Grant the new LOTTERY permissions to the already-seeded ADMIN role, the
-- same way lottery_dreams granted VIEW / DREAMS_MANAGE — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: draws and prices are operations.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'LOTTERY.DRAWS_MANAGE'),
  ('ADMIN', 'LOTTERY.SETTINGS_MANAGE')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
