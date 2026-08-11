-- CreateTable
CREATE TABLE "finance_settings" (
    "id" TEXT NOT NULL,
    "minDepositAmount" DECIMAL(12,2) NOT NULL,
    "maxDepositAmount" DECIMAL(12,2) NOT NULL,
    "minWithdrawalAmount" DECIMAL(12,2) NOT NULL,
    "maxWithdrawalAmount" DECIMAL(12,2) NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
