-- Advertisements: the "Same movie again" rule is removed (owner, 4 Nov 2026:
-- "remove same movie again, I don't want it"). The ad before the movie now
-- plays on every open of a title; breaks and corner pictures keep their own
-- rules. The column and its CHECK go with it.

-- AlterTable
ALTER TABLE "ad_settings" DROP CONSTRAINT "ad_settings_replay_chk";
ALTER TABLE "ad_settings" DROP COLUMN "sameTitleReplayMinutes";
