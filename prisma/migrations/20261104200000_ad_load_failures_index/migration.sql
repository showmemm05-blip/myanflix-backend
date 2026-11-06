-- Advertisements: the analytics' "failed to load" figure (2026-11-04) counts
-- rows that FAILED before their first frame, by failedAt. Those rows are now
-- kept for a year (they used to be swept after a week), so the figure gets
-- its own small partial index instead of scanning every play.

-- CreateIndex
CREATE INDEX "advertisement_playbacks_load_failed_idx" ON "advertisement_playbacks"("failedAt") WHERE "startedAt" IS NULL AND "status" = 'FAILED';
