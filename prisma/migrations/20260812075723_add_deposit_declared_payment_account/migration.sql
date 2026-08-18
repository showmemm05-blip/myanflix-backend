-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "declaredPaymentAccountId" TEXT;

-- CreateIndex
CREATE INDEX "deposits_declaredPaymentAccountId_idx" ON "deposits"("declaredPaymentAccountId");

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_declaredPaymentAccountId_fkey" FOREIGN KEY ("declaredPaymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
