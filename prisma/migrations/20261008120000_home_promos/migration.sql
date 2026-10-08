-- Home showcase: the "Home promos" admin page (2026-10-08).
-- Two new tables (home_promos, home_settings), their three enums, and the
-- HOME.VIEW / HOME.MANAGE grants for the seeded ADMIN role. Hand-written
-- from `prisma migrate diff` against a database holding every earlier
-- migration, so the DDL below is exactly what the schema expects.

-- CreateEnum
CREATE TYPE "HomePromoKind" AS ENUM ('HERO', 'SPOTLIGHT', 'COMING_SOON');

-- CreateEnum
CREATE TYPE "HomePromoCtaTarget" AS ENUM ('SUBSCRIBE', 'ADD_MONEY', 'MOVIE', 'SERIES', 'BOOK', 'URL', 'NONE');

-- CreateEnum
CREATE TYPE "HomePromoArtPreset" AS ENUM ('PREMIUM', 'PAYMENT', 'GAMES', 'GENERIC');

-- CreateTable
CREATE TABLE "home_promos" (
    "id" TEXT NOT NULL,
    "kind" "HomePromoKind" NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleMm" TEXT NOT NULL,
    "kickerEn" TEXT,
    "kickerMm" TEXT,
    "bodyEn" TEXT,
    "bodyMm" TEXT,
    "ctaLabelEn" TEXT,
    "ctaLabelMm" TEXT,
    "ctaTarget" "HomePromoCtaTarget" NOT NULL DEFAULT 'NONE',
    "targetId" TEXT,
    "url" TEXT,
    "artPreset" "HomePromoArtPreset" NOT NULL DEFAULT 'GENERIC',
    "imageUrl" TEXT,
    "dateText" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_settings" (
    "id" TEXT NOT NULL,
    "webUrl" TEXT,
    "appStoreUrl" TEXT,
    "playStoreUrl" TEXT,
    "gamesTeaserEnabled" BOOLEAN NOT NULL DEFAULT true,
    "gamesTeaserDateText" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "home_promos_kind_isActive_sortOrder_idx" ON "home_promos"("kind", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "home_promos_createdById_idx" ON "home_promos"("createdById");

-- CreateIndex
CREATE INDEX "home_settings_updatedByUserId_idx" ON "home_settings"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "home_promos" ADD CONSTRAINT "home_promos_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "home_settings" ADD CONSTRAINT "home_settings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Grant the new HOME permissions to the already-seeded ADMIN role, the same
-- way add_actors / add_books granted theirs — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: the home page is marketing, not ingestion.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'HOME.VIEW'),
  ('ADMIN', 'HOME.MANAGE')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
