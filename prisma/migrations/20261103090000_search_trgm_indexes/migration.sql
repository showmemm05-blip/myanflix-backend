-- Trigram indexes for the catalog search boxes.
--
-- Every search is a Prisma `contains` with mode: 'insensitive', i.e.
-- ILIKE '%term%', which no btree can serve: without these the database reads
-- every row of the table on each keystroke. A GIN index over pg_trgm's
-- 3-character pieces answers the same ILIKE straight from the index (the
-- planner rechecks the candidate rows, so results are identical).
--
-- One index per searched column: movies/series search title OR description,
-- books title OR author OR description, actors and book authors their name —
-- an OR only uses indexes when every branch has one.
--
-- pg_trgm is a "trusted" extension (PostgreSQL 13+), so the application role
-- can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "movies_title_trgm_idx" ON "movies" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "movies_description_trgm_idx" ON "movies" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "series_title_trgm_idx" ON "series" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "series_description_trgm_idx" ON "series" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "books_title_trgm_idx" ON "books" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "books_author_trgm_idx" ON "books" USING GIN ("author" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "books_description_trgm_idx" ON "books" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "actors_name_trgm_idx" ON "actors" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "book_authors_name_trgm_idx" ON "book_authors" USING GIN ("name" gin_trgm_ops);
