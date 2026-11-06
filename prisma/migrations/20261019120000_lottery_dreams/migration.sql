-- Lottery dreams (lottery backend phase 1, 2026-10-19).
-- One new table (lottery_dreams) and its enum, the 1,100 rows every dream
-- book holds (numbers only — staff fill the names in later), and the
-- LOTTERY.VIEW / LOTTERY.DREAMS_MANAGE grants for the seeded ADMIN role.
-- DDL hand-written to match prisma/schema.prisma like the home_promos
-- migration; the row seed and the grants are plain SQL, idempotent.
-- Pre-flight: none needed (one new table; no existing table changes).

-- CreateEnum
CREATE TYPE "LotteryDreamBook" AS ENUM ('DREAM_1000', 'DREAM_100');

-- CreateTable
CREATE TABLE "lottery_dreams" (
    "id" TEXT NOT NULL,
    "book" "LotteryDreamBook" NOT NULL,
    "number" VARCHAR(3) NOT NULL,
    "nameEn" TEXT,
    "nameMy" TEXT,
    "pictureUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lottery_dreams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lottery_dreams_book_number_key" ON "lottery_dreams"("book", "number");

-- The dream books are fixed-size: exactly one row per number. Dream 1000 is
-- 000-999, Dream 100 is 00-99. Numbers are zero-padded strings (leading
-- zeros are part of a lottery number). ON CONFLICT keeps a re-run harmless.
INSERT INTO "lottery_dreams" ("id", "book", "number", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'DREAM_1000', lpad(n::text, 3, '0'), now(), now()
FROM generate_series(0, 999) AS n
ON CONFLICT ("book", "number") DO NOTHING;

INSERT INTO "lottery_dreams" ("id", "book", "number", "createdAt", "updatedAt")
SELECT gen_random_uuid(), 'DREAM_100', lpad(n::text, 2, '0'), now(), now()
FROM generate_series(0, 99) AS n
ON CONFLICT ("book", "number") DO NOTHING;

-- Grant the new LOTTERY permissions to the already-seeded ADMIN role, the
-- same way home_promos granted HOME.VIEW / HOME.MANAGE — the seed arrays in
-- src/roles/system-roles.seed.ts only describe a fresh database; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
-- CONTENT_UPLOADER gets nothing: the dream books are operations, not ingestion.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'LOTTERY.VIEW'),
  ('ADMIN', 'LOTTERY.DREAMS_MANAGE')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
