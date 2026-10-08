-- M-6 (security audit 2026-10-06): the per-account comment limit (10 per
-- minute, 100 per day) used to count the account's surviving comments, so
-- deleting your own comments handed the allowance straight back. Posting now
-- also writes one row here per comment; the limit counts THESE rows, and a
-- comment delete never touches them. Rows older than a day are pruned on the
-- account's next post. Pre-flight: none needed.

-- CreateTable
CREATE TABLE "comment_post_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_post_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_post_events_userId_createdAt_idx" ON "comment_post_events"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "comment_post_events" ADD CONSTRAINT "comment_post_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the last day from the comments that still exist, so the day
-- allowance does not reset to zero for everyone at the moment of deploy.
INSERT INTO "comment_post_events" ("id", "userId", "createdAt")
SELECT "id", "userId", "createdAt"
FROM "comments"
WHERE "createdAt" >= NOW() - INTERVAL '1 day';
