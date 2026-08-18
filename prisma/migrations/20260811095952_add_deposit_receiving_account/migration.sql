-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "receivingAccountName" TEXT,
ADD COLUMN     "receivingAccountNumber" TEXT,
ADD COLUMN     "receivingAccountSubname" TEXT,
ADD COLUMN     "receivingAccountType" TEXT,
ADD COLUMN     "receivingTransactionCode" TEXT,
ADD COLUMN     "receivingTransactionTime" TEXT;
