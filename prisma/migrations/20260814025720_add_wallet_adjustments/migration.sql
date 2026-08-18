-- CreateEnum
CREATE TYPE "WalletAdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BALANCE_ADJUSTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'ADJUSTMENT_CREDIT';
ALTER TYPE "TransactionType" ADD VALUE 'ADJUSTMENT_DEBIT';

-- CreateTable
CREATE TABLE "wallet_adjustments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "WalletAdjustmentDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceBefore" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_adjustments_idempotencyKey_key" ON "wallet_adjustments"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_adjustments_transactionId_key" ON "wallet_adjustments"("transactionId");

-- CreateIndex
CREATE INDEX "wallet_adjustments_userId_idx" ON "wallet_adjustments"("userId");

-- CreateIndex
CREATE INDEX "wallet_adjustments_createdAt_idx" ON "wallet_adjustments"("createdAt");

-- AddForeignKey
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
