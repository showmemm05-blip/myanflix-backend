-- Advertisements inside the movie (2026-11-04): mid-roll breaks every N
-- minutes of movie position, and a small corner picture shown while the movie
-- plays (owner's spec of 4 Nov). Hand-written from `prisma migrate diff`
-- against a database holding every earlier migration, plus the CHECKs.
--
-- Every ad that exists today is a pre-roll video: the defaults keep it one
-- (format VIDEO, plays before the movie, not at breaks). Breaks stay off until
-- the admin sets an interval. No permission changes: ADS.VIEW / ADS.MANAGE.

-- CreateEnum
CREATE TYPE "AdvertisementFormat" AS ENUM ('VIDEO', 'CORNER');

-- CreateEnum
CREATE TYPE "AdvertisementPlacement" AS ENUM ('PREROLL', 'MIDROLL', 'CORNER');

-- CreateEnum
CREATE TYPE "AdvertisementAudience" AS ENUM ('ALL', 'NON_PREMIUM');

-- AlterTable
ALTER TABLE "advertisements"
    ADD COLUMN "format" "AdvertisementFormat" NOT NULL DEFAULT 'VIDEO',
    ADD COLUMN "playsBeforeMovie" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "playsAtBreaks" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "imageKey" TEXT,
    ADD COLUMN "imageBytes" INTEGER,
    ADD COLUMN "imageWidth" INTEGER,
    ADD COLUMN "imageHeight" INTEGER,
    ADD COLUMN "imageAttachedAt" TIMESTAMP(3),
    ADD COLUMN "linkUrl" TEXT,
    ADD COLUMN "cornerShowSeconds" INTEGER,
    ADD COLUMN "cornerRepeatMinutes" INTEGER,
    ADD COLUMN "cornerClosable" BOOLEAN NOT NULL DEFAULT true,
    -- A VIDEO ad plays somewhere and carries no picture / corner fields; a
    -- CORNER ad has no slot, no video and no skip fields.
    ADD CONSTRAINT "advertisements_format_chk" CHECK (
        ("format" = 'VIDEO'
            AND ("playsBeforeMovie" OR "playsAtBreaks")
            AND "imageKey" IS NULL AND "imageBytes" IS NULL AND "imageWidth" IS NULL
            AND "imageHeight" IS NULL AND "imageAttachedAt" IS NULL AND "linkUrl" IS NULL
            AND "cornerShowSeconds" IS NULL AND "cornerRepeatMinutes" IS NULL)
        OR ("format" = 'CORNER'
            AND NOT "playsBeforeMovie" AND NOT "playsAtBreaks"
            AND "videoKey" IS NULL AND "videoBytes" IS NULL AND "videoEtag" IS NULL
            AND "durationSeconds" IS NULL AND "videoAttachedAt" IS NULL
            AND "isSkippable" = false AND "skipAfterSeconds" IS NULL)
    ),
    -- "Until closed" needs the close button and never comes back; a timed
    -- showing is 3–600 s and comes back (if at all) only after it has left.
    -- Every branch tests IS NULL / IS NOT NULL first: a NULL inside a CHECK
    -- would otherwise let the row through.
    ADD CONSTRAINT "advertisements_corner_timing_chk" CHECK (
        "format" <> 'CORNER' OR (
            ("cornerShowSeconds" IS NULL AND "cornerRepeatMinutes" IS NULL AND "cornerClosable")
            OR ("cornerShowSeconds" IS NOT NULL AND "cornerShowSeconds" BETWEEN 3 AND 600
                AND ("cornerRepeatMinutes" IS NULL
                     OR ("cornerRepeatMinutes" BETWEEN 1 AND 240
                         AND "cornerRepeatMinutes" * 60 > "cornerShowSeconds")))
        )
    ),
    -- The picture's facts arrive together, from the upload route.
    ADD CONSTRAINT "advertisements_image_chk" CHECK (
        ("imageKey" IS NULL) = ("imageBytes" IS NULL)
        AND ("imageKey" IS NULL) = ("imageWidth" IS NULL)
        AND ("imageKey" IS NULL) = ("imageHeight" IS NULL)
        AND ("imageKey" IS NULL) = ("imageAttachedAt" IS NULL)
        AND ("imageBytes" IS NULL OR "imageBytes" >= 1)
        AND ("imageWidth" IS NULL OR "imageWidth" >= 16)
        AND ("imageHeight" IS NULL OR "imageHeight" >= 16)
    );

-- AlterTable
ALTER TABLE "advertisement_playbacks"
    ADD COLUMN "placement" "AdvertisementPlacement" NOT NULL DEFAULT 'PREROLL',
    ADD COLUMN "breakAtSeconds" INTEGER,
    ADD COLUMN "repeatCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "clickCount" INTEGER NOT NULL DEFAULT 0,
    -- A break row says where the break sits (whole minutes of movie time).
    ADD CONSTRAINT "advertisement_playbacks_break_chk" CHECK (
        (("placement" = 'MIDROLL') = ("breakAtSeconds" IS NOT NULL))
        AND ("breakAtSeconds" IS NULL
             OR ("breakAtSeconds" BETWEEN 60 AND 86400 AND "breakAtSeconds" % 60 = 0))
    ),
    -- Repeats and taps are a corner picture's counters only.
    ADD CONSTRAINT "advertisement_playbacks_corner_counts_chk" CHECK (
        "repeatCount" >= 0 AND "clickCount" >= 0
        AND ("placement" = 'CORNER' OR ("repeatCount" = 0 AND "clickCount" = 0))
    );

-- DropIndex (its job moves to the index below, which every placement shares)
DROP INDEX "advertisement_playbacks_pending_idx";

-- CreateIndex
CREATE INDEX "advertisement_playbacks_userId_movieId_createdAt_idx" ON "advertisement_playbacks"("userId", "movieId", "createdAt");

-- AlterTable
ALTER TABLE "ad_settings"
    ADD COLUMN "adsEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "midrollIntervalMinutes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "duringMovieAudience" "AdvertisementAudience" NOT NULL DEFAULT 'ALL',
    -- 0 = no breaks; otherwise every 1–240 minutes of movie time.
    ADD CONSTRAINT "ad_settings_midroll_chk" CHECK ("midrollIntervalMinutes" BETWEEN 0 AND 240);
