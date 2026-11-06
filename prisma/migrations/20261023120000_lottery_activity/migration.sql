-- Lottery activity (2026-10-23): one row per signed-in user per client
-- platform per MYANMAR hour while they are inside the Lottery (the app pings
-- POST /lottery/activity; the write is throttled to one per user per
-- minute). "hourStart" is the start of the MMT (UTC+6:30) hour stored as the
-- UTC instant, i.e. :30 past the UTC hour, so the analytics' +390-minute
-- shift lands on an exact Myanmar hour (unlike watch_activity's UTC buckets).
-- Feeds the admin "active users" series of Lottery > Analytics;
-- purchases and tickets are observed from their own tables. Guests never
-- ping, so they are not counted. Plus the two createdAt indexes the
-- period scans of the analytics need (every report is "between two
-- instants"; the existing indexes all lead with userId or drawId).
-- DDL hand-written to match prisma/schema.prisma like the lottery_draws
-- migration (same users FK style: ON DELETE CASCADE like user_sessions /
-- watch_activity — presence rows are not money and go with the account).
-- No new permission: LOTTERY.VIEW gates the reads, the ping is any
-- signed-in user. No backfill.
-- Pre-flight: none needed (one new table, two plain indexes).

-- CreateTable
CREATE TABLE "lottery_activity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "ClientPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "hourStart" TIMESTAMP(3) NOT NULL,
    "pings" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lottery_activity_userId_platform_hourStart_key" ON "lottery_activity"("userId", "platform", "hourStart");

-- CreateIndex
CREATE INDEX "lottery_activity_hourStart_idx" ON "lottery_activity"("hourStart");

-- CreateIndex
CREATE INDEX "lottery_activity_userId_idx" ON "lottery_activity"("userId");

-- AddForeignKey
ALTER TABLE "lottery_activity" ADD CONSTRAINT "lottery_activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Period scans for the analytics (tickets sold / purchases between two instants).

-- CreateIndex
CREATE INDEX "lottery_tickets_createdAt_idx" ON "lottery_tickets"("createdAt");

-- CreateIndex
CREATE INDEX "lottery_purchases_createdAt_idx" ON "lottery_purchases"("createdAt");

-- AddCheckConstraint (guard rail in the style of the other lottery tables).
-- Only the pings half: "firstAt" <= "lastAt" would reject a legitimate ping
-- after a backwards clock step or from a second instance a few ms behind
-- (lastAt is the request's own now), and the write is fire-and-forget, so
-- that user's presence for the minute would simply be lost.
ALTER TABLE "lottery_activity" ADD CONSTRAINT "lottery_activity_values_check" CHECK ("pings" >= 1);
