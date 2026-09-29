-- C-4: a withdrawal HOLDS its money from the moment it is requested. The
-- request's insert, the wallet debit and a PENDING WITHDRAWAL ledger row now
-- commit together; holdTransactionId points at that ledger row. Approve turns
-- it COMPLETED (no second debit); reject credits the wallet back, turns it
-- FAILED and writes a REFUND row.
-- Existing rows keep NULL: they were created before holds existed, so approve
-- still debits them exactly as before and reject moves no money. No backfill.
-- Pre-flight: none needed (nullable column, unique over NULLs is free).

-- AlterTable
ALTER TABLE "withdrawals" ADD COLUMN     "holdTransactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_holdTransactionId_key" ON "withdrawals"("holdTransactionId");

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_holdTransactionId_fkey" FOREIGN KEY ("holdTransactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
