-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "walletBalanceAfter" DECIMAL(12,2),
ADD COLUMN     "walletBalanceBefore" DECIMAL(12,2);
