-- CreateEnum
CREATE TYPE "PaymentAccountTransactionType" AS ENUM ('OPENING_BALANCE', 'MANUAL_CREDIT', 'MANUAL_DEBIT', 'DEPOSIT_IN', 'WITHDRAWAL_OUT', 'ADJUSTMENT_CREDIT', 'ADJUSTMENT_DEBIT');

-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "receivingPaymentAccountId" TEXT;

-- AlterTable
ALTER TABLE "payment_accounts" ADD COLUMN     "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalIn" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalOut" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "withdrawals" ADD COLUMN     "transferPaymentAccountId" TEXT;

-- CreateTable
CREATE TABLE "payment_account_transactions" (
    "id" TEXT NOT NULL,
    "paymentAccountId" TEXT NOT NULL,
    "type" "PaymentAccountTransactionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceBefore" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "referenceCode" TEXT,
    "note" TEXT,
    "relatedDepositId" TEXT,
    "relatedWithdrawalId" TEXT,
    "performedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_account_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_account_transactions_paymentAccountId_idx" ON "payment_account_transactions"("paymentAccountId");

-- CreateIndex
CREATE INDEX "payment_account_transactions_type_idx" ON "payment_account_transactions"("type");

-- CreateIndex
CREATE INDEX "payment_account_transactions_createdAt_idx" ON "payment_account_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "payment_account_transactions_relatedDepositId_idx" ON "payment_account_transactions"("relatedDepositId");

-- CreateIndex
CREATE INDEX "payment_account_transactions_relatedWithdrawalId_idx" ON "payment_account_transactions"("relatedWithdrawalId");

-- CreateIndex
CREATE INDEX "deposits_receivingPaymentAccountId_idx" ON "deposits"("receivingPaymentAccountId");

-- CreateIndex
CREATE INDEX "withdrawals_transferPaymentAccountId_idx" ON "withdrawals"("transferPaymentAccountId");

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_receivingPaymentAccountId_fkey" FOREIGN KEY ("receivingPaymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_transferPaymentAccountId_fkey" FOREIGN KEY ("transferPaymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_account_transactions" ADD CONSTRAINT "payment_account_transactions_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_account_transactions" ADD CONSTRAINT "payment_account_transactions_relatedDepositId_fkey" FOREIGN KEY ("relatedDepositId") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_account_transactions" ADD CONSTRAINT "payment_account_transactions_relatedWithdrawalId_fkey" FOREIGN KEY ("relatedWithdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_account_transactions" ADD CONSTRAINT "payment_account_transactions_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
