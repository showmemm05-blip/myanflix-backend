-- Movie & series type (owner, 2026-10-27): a series gets the same optional
-- TYPE word movies keep in movies.country ("Korean", "English"…), shown as
-- "Korean series". Nullable, no default: every existing series simply has
-- no type yet. Pre-flight: none needed.

-- AlterTable
ALTER TABLE "series" ADD COLUMN "country" TEXT;
