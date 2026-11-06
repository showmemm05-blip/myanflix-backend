-- Pre-roll video advertisements: the admin "Advertisements" page and the
-- player's ad-before-the-movie (2026-11-04). Three new tables
-- (advertisements, advertisement_movies, advertisement_playbacks), their two
-- enums, the CHECKs the DTOs also enforce, and the ADS.VIEW / ADS.MANAGE
-- grants for the seeded ADMIN role. Hand-written from `prisma migrate diff`
-- against a database holding every earlier migration, so the DDL below is
-- exactly what the schema expects.
--
-- Pre-flight: none. Nothing existing is touched; every FK points at rows
-- that already exist (users, movies).

-- CreateEnum
CREATE TYPE "AdvertisementTargetType" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "AdvertisementPlaybackStatus" AS ENUM ('PENDING', 'STARTED', 'COMPLETED', 'SKIPPED', 'FAILED', 'ABANDONED');

-- CreateTable
CREATE TABLE "advertisements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "videoKey" TEXT,
    "videoBytes" INTEGER,
    "videoEtag" TEXT,
    "durationSeconds" INTEGER,
    "videoAttachedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "dailyStartMinutes" INTEGER,
    "dailyEndMinutes" INTEGER,
    "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 390,
    "targetType" "AdvertisementTargetType" NOT NULL DEFAULT 'ALL',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isSkippable" BOOLEAN NOT NULL DEFAULT false,
    "skipAfterSeconds" INTEGER,
    "frequencyLimitMinutes" INTEGER,
    "maxImpressionsPerUserPerDay" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisements_pkey" PRIMARY KEY ("id"),
    -- The same rules the service enforces, so a stray write can never leave
    -- a row the preroll decision cannot reason about.
    CONSTRAINT "advertisements_schedule_chk" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt"),
    CONSTRAINT "advertisements_daily_window_chk" CHECK (
        ("dailyStartMinutes" IS NULL) = ("dailyEndMinutes" IS NULL)
        AND ("dailyStartMinutes" IS NULL OR (
            "dailyStartMinutes" BETWEEN 0 AND 1439
            AND "dailyEndMinutes" BETWEEN 0 AND 1439
            AND "dailyStartMinutes" <> "dailyEndMinutes"))),
    CONSTRAINT "advertisements_tz_chk" CHECK ("tzOffsetMinutes" BETWEEN -720 AND 840),
    CONSTRAINT "advertisements_skip_chk" CHECK (
        ("isSkippable" = false AND "skipAfterSeconds" IS NULL)
        OR ("isSkippable" = true AND "skipAfterSeconds" >= 1)),
    CONSTRAINT "advertisements_limits_chk" CHECK (
        "priority" >= 0
        AND ("frequencyLimitMinutes" IS NULL OR "frequencyLimitMinutes" >= 1)
        AND ("maxImpressionsPerUserPerDay" IS NULL OR "maxImpressionsPerUserPerDay" >= 1)
        AND ("durationSeconds" IS NULL OR "durationSeconds" >= 1))
);

-- CreateTable
CREATE TABLE "advertisement_movies" (
    "id" TEXT NOT NULL,
    "advertisementId" TEXT NOT NULL,
    "movieId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advertisement_movies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advertisement_playbacks" (
    "id" TEXT NOT NULL,
    "advertisementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "movieId" TEXT NOT NULL,
    "platform" "ClientPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "status" "AdvertisementPlaybackStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "positionSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advertisement_playbacks_pkey" PRIMARY KEY ("id"),
    -- A status always carries the instant it was reached.
    CONSTRAINT "advertisement_playbacks_started_chk" CHECK ("status" NOT IN ('STARTED', 'COMPLETED', 'SKIPPED') OR "startedAt" IS NOT NULL),
    CONSTRAINT "advertisement_playbacks_completed_chk" CHECK ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL),
    CONSTRAINT "advertisement_playbacks_skipped_chk" CHECK ("status" <> 'SKIPPED' OR "skippedAt" IS NOT NULL),
    CONSTRAINT "advertisement_playbacks_failed_chk" CHECK ("status" <> 'FAILED' OR "failedAt" IS NOT NULL)
);

-- CreateIndex
CREATE INDEX "advertisements_isActive_priority_idx" ON "advertisements"("isActive", "priority" DESC);

-- CreateIndex
CREATE INDEX "advertisements_createdById_idx" ON "advertisements"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "advertisement_movies_advertisementId_movieId_key" ON "advertisement_movies"("advertisementId", "movieId");

-- CreateIndex
CREATE INDEX "advertisement_movies_movieId_idx" ON "advertisement_movies"("movieId");

-- CreateIndex
CREATE INDEX "advertisement_playbacks_userId_advertisementId_startedAt_idx" ON "advertisement_playbacks"("userId", "advertisementId", "startedAt");

-- CreateIndex
CREATE INDEX "advertisement_playbacks_advertisementId_startedAt_idx" ON "advertisement_playbacks"("advertisementId", "startedAt");

-- CreateIndex
CREATE INDEX "advertisement_playbacks_startedAt_idx" ON "advertisement_playbacks"("startedAt");

-- CreateIndex
CREATE INDEX "advertisement_playbacks_movieId_idx" ON "advertisement_playbacks"("movieId");

-- CreateIndex
CREATE INDEX "advertisement_playbacks_pending_idx" ON "advertisement_playbacks"("userId", "movieId") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "advertisements" ADD CONSTRAINT "advertisements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisement_movies" ADD CONSTRAINT "advertisement_movies_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisement_movies" ADD CONSTRAINT "advertisement_movies_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisement_playbacks" ADD CONSTRAINT "advertisement_playbacks_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "advertisements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisement_playbacks" ADD CONSTRAINT "advertisement_playbacks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advertisement_playbacks" ADD CONSTRAINT "advertisement_playbacks_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Grant the new ADS permissions to the already-seeded ADMIN role, the same
-- way home_promos granted HOME.* — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: ads are marketing, not ingestion. The
-- viewer routes (POST /ads/preroll, the playback events) need no permission.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'ADS.VIEW'),
  ('ADMIN', 'ADS.MANAGE')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
