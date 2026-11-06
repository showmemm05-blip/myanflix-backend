-- Advertisements: the playback rules row (2026-11-04). One table holding the
-- single global row the admin "Advertisements" page edits — today one rule,
-- how many minutes must pass before the same title shows an ad again for a
-- viewer (owner: "I want to adjust from the admin dashboard"). Hand-written
-- from `prisma migrate diff` against a database holding every earlier
-- migration. No permission changes: ADS.VIEW reads it, ADS.MANAGE saves it.

-- CreateTable
CREATE TABLE "ad_settings" (
    "id" TEXT NOT NULL,
    "sameTitleReplayMinutes" INTEGER NOT NULL DEFAULT 30,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_settings_pkey" PRIMARY KEY ("id"),
    -- 0 = an ad every time; at most a day.
    CONSTRAINT "ad_settings_replay_chk" CHECK ("sameTitleReplayMinutes" BETWEEN 0 AND 1440)
);

-- CreateIndex
CREATE INDEX "ad_settings_updatedByUserId_idx" ON "ad_settings"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "ad_settings" ADD CONSTRAINT "ad_settings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
