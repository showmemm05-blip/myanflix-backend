-- Description per language (owner, 2026-11-06): a Burmese description beside
-- the existing one, on movies (episodes included — an episode is a movies
-- row) and on series. `description` stays the English / default text and the
-- fallback; the clients show whichever exists for the app language. Nullable,
-- no default, no backfill: every existing title simply has no Burmese text
-- yet. The two trigram indexes keep the catalogue search (now title OR
-- description OR descriptionMm) answered from an index on every branch, the
-- same reason as 20261103090000. Hand-written to match prisma/schema.prisma.
-- Pre-flight: none needed (two nullable columns; pg_trgm exists since
-- 20261103090000; both indexes are built over columns that are all NULL).

-- AlterTable
ALTER TABLE "movies" ADD COLUMN "descriptionMm" TEXT;

-- AlterTable
ALTER TABLE "series" ADD COLUMN "descriptionMm" TEXT;

-- CreateIndex
CREATE INDEX "movies_description_mm_trgm_idx" ON "movies" USING GIN ("descriptionMm" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "series_description_mm_trgm_idx" ON "series" USING GIN ("descriptionMm" gin_trgm_ops);
