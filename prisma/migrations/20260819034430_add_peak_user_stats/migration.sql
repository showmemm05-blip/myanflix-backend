-- CreateTable
CREATE TABLE "peak_user_stats" (
    "id" TEXT NOT NULL,
    "actualPeak" INTEGER NOT NULL DEFAULT 0,
    "actualPeakAt" TIMESTAMP(3),
    "additionalPeak" INTEGER NOT NULL DEFAULT 0,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "peak_user_stats_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "peak_user_stats" ADD CONSTRAINT "peak_user_stats_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
