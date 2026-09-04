-- Books gain an author entity. Additive only: books.author (the display
-- string every client reads) is KEPT and becomes a denormalised copy of
-- book_authors.name, maintained by the service. Hand-written so the backfill
-- can run in the same step as the column.

-- 1. The author row, shaped like actors.
CREATE TABLE "book_authors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "bio" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_authors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "book_authors_name_key" ON "book_authors"("name");

-- 2. The link. Nullable so existing rows survive the ADD; RESTRICT because an
--    author with books is refused by the service (409), never cascaded or
--    nulled out from under a book.
ALTER TABLE "books" ADD COLUMN "authorId" TEXT;

CREATE INDEX "books_authorId_idx" ON "books"("authorId");

ALTER TABLE "books" ADD CONSTRAINT "books_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "book_authors"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Backfill: one author per distinct trimmed, case-folded name. Where two
--    books spell the same name with different casing, the spelling on the
--    earliest-created book wins. Empty/blank authors get no row.
INSERT INTO "book_authors" ("id", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid(), canonical."name", now(), now()
FROM (
    SELECT DISTINCT ON (lower(btrim("author"))) btrim("author") AS "name"
    FROM "books"
    WHERE btrim("author") <> ''
    ORDER BY lower(btrim("author")), "createdAt" ASC, "id" ASC
) AS canonical
ON CONFLICT ("name") DO NOTHING;

-- 4. Link every book to its author and normalise the display string to the
--    canonical spelling, so the service's invariant (author = authorRef.name)
--    holds from the first request.
UPDATE "books" b
SET "authorId" = a."id",
    "author"   = a."name"
FROM "book_authors" a
WHERE b."authorId" IS NULL
  AND lower(btrim(b."author")) = lower(a."name");
