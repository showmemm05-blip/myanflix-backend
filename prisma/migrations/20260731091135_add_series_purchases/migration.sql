-- AlterTable
ALTER TABLE "series" ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "price" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "series_purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "series_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "series_purchases_seriesId_idx" ON "series_purchases"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "series_purchases_userId_seriesId_key" ON "series_purchases"("userId", "seriesId");

-- AddForeignKey
ALTER TABLE "series_purchases" ADD CONSTRAINT "series_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series_purchases" ADD CONSTRAINT "series_purchases_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
