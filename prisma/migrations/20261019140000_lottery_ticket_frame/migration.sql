-- Lottery ticket frame (owner request 2026-10-19: "upload the frame alone,
-- and the picture inside it — two uploads; the layout stays the same").
--  * lottery_settings.frameUrl: the frame artwork every NEW draw is created
--    with — one of our own uploads under images/lottery_frame/, stored
--    canonical. NULL = the app's built-in frame.
--  * lottery_draws.frameUrl: the frame copied into the draw at creation
--    (like ticketPrice), so a ticket already sold never changes its look
--    when the setting changes. NULL = the built-in frame. Changeable only
--    while the draw has sold nothing (the same lock as pictureUrl).
-- Existing rows get NULL: every draw made so far keeps the built-in frame.
-- DDL hand-written to match prisma/schema.prisma like the lottery_draws
-- migration. No backfill.
-- Pre-flight: none needed (two nullable columns, no default, no index).

-- AlterTable
ALTER TABLE "lottery_settings" ADD COLUMN     "frameUrl" TEXT;

-- AlterTable
ALTER TABLE "lottery_draws" ADD COLUMN     "frameUrl" TEXT;
