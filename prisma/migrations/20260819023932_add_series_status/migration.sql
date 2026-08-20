-- CreateEnum
CREATE TYPE "SeriesStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- AlterTable
ALTER TABLE "series" ADD COLUMN     "status" "SeriesStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "series_status_idx" ON "series"("status");

-- Backfill: every series that existed before this migration is already live
-- on the user website — defaulting them to DRAFT would silently wipe the
-- public catalogue, so they are all marked PUBLISHED. Only series created
-- after this migration start as DRAFT.
UPDATE "series" SET "status" = 'PUBLISHED';
