-- Movie and series details from TMDB (owner, 2026-11-06): each movie and
-- series remembers which TMDB entry it is linked to, when that data was
-- fetched (TMDB's terms forbid keeping it over 6 months) and which values
-- were filled automatically, so a refill never overwrites what staff typed;
-- a movie also keeps the raw folder name it was uploaded from and where its
-- background lookup stands; each actor remembers its TMDB person. One enum,
-- six columns on movies, three on series, one on actors. Hand-written to
-- match prisma/schema.prisma. No permission changes.
-- Pre-flight: none needed. Every column is nullable or has a constant
-- default (ADD COLUMN ... DEFAULT 'NONE' does not rewrite the table), so
-- existing rows are simply "not linked, never looked up"; actors.tmdbPersonId
-- is all NULL, and NULLs never collide, so the unique index cannot fail.

-- CreateEnum
CREATE TYPE "TmdbLookupStatus" AS ENUM ('NONE', 'PENDING', 'MATCHED', 'NEEDS_PICK', 'NOT_FOUND', 'FAILED');

-- AlterTable
ALTER TABLE "movies"
    ADD COLUMN "sourceName" TEXT,
    ADD COLUMN "tmdbId" INTEGER,
    ADD COLUMN "tmdbStatus" "TmdbLookupStatus" NOT NULL DEFAULT 'NONE',
    ADD COLUMN "tmdbError" TEXT,
    ADD COLUMN "tmdbFetchedAt" TIMESTAMP(3),
    ADD COLUMN "tmdbAuto" JSONB;

-- AlterTable
ALTER TABLE "series"
    ADD COLUMN "tmdbId" INTEGER,
    ADD COLUMN "tmdbFetchedAt" TIMESTAMP(3),
    ADD COLUMN "tmdbAuto" JSONB;

-- AlterTable
ALTER TABLE "actors" ADD COLUMN "tmdbPersonId" INTEGER;

-- CreateIndex
CREATE INDEX "movies_tmdbId_idx" ON "movies"("tmdbId");

-- CreateIndex
CREATE INDEX "series_tmdbId_idx" ON "series"("tmdbId");

-- CreateIndex
CREATE UNIQUE INDEX "actors_tmdbPersonId_key" ON "actors"("tmdbPersonId");
