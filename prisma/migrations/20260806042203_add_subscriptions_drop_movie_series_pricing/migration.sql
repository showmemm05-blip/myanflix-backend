-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('FREE', 'SUBSCRIPTION');

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'SUBSCRIPTION';

-- AlterTable "movies": add accessType (backfilled via DEFAULT), then drop price/isPremium
ALTER TABLE "movies" ADD COLUMN "accessType" "AccessType" NOT NULL DEFAULT 'SUBSCRIPTION';
UPDATE "movies" SET "accessType" = 'FREE' WHERE "isPremium" = false;
ALTER TABLE "movies" DROP COLUMN "price";
ALTER TABLE "movies" DROP COLUMN "isPremium";

-- AlterTable "series": same pattern
ALTER TABLE "series" ADD COLUMN "accessType" "AccessType" NOT NULL DEFAULT 'SUBSCRIPTION';
UPDATE "series" SET "accessType" = 'FREE' WHERE "isPremium" = false;
ALTER TABLE "series" DROP COLUMN "price";
ALTER TABLE "series" DROP COLUMN "isPremium";

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_subscriptions_userId_idx" ON "user_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "user_subscriptions_expiresAt_idx" ON "user_subscriptions"("expiresAt");

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
