-- Books gain their own category taxonomy, and the CHAPTER becomes the unit of
-- content for both book types: a PDF chapter now carries its own file and its
-- own converted pages, and every chapter can carry a cover image.
--
-- Hand-written rather than taken from `prisma migrate diff`, because that diff
-- is destructive in three places: it DROPs _BookToCategory (every existing
-- book/category link), it adds book_pages.chapterId NOT NULL while dropping
-- editionId (orphaning every converted page), and it drops the editions' pdf
-- columns without moving them anywhere. Each step below backfills before it
-- drops.

-- 1. A chapter's own conversion lifecycle.
CREATE TYPE "ChapterStatus" AS ENUM ('DRAFT', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- 2. The chapter grows the columns a PDF release needs, and `content` becomes
--    optional because a PDF chapter's content is its pages.
ALTER TABLE "book_chapters"
    ADD COLUMN "imageUrl" TEXT,
    ADD COLUMN "status" "ChapterStatus" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "pdfKey" TEXT,
    ADD COLUMN "pdfFileSize" BIGINT,
    ADD COLUMN "pageCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "processedPages" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "processingError" TEXT,
    ALTER COLUMN "content" DROP NOT NULL;

-- 3. Every chapter that exists today is a written one with text in it, so it is
--    READY by definition — nothing about it is pending conversion.
UPDATE "book_chapters" SET "status" = 'READY' WHERE "content" IS NOT NULL;

-- 4. Each PDF edition's single upload becomes its first chapter, carrying the
--    file, the counters and the equivalent lifecycle. Runs BEFORE the edition
--    columns are dropped and before book_pages loses editionId.
INSERT INTO "book_chapters" (
    "id", "editionId", "title", "content", "order", "status",
    "createdAt", "updatedAt",
    "pdfKey", "pdfFileSize", "pageCount", "processedPages", "processingError"
)
SELECT
    gen_random_uuid(), e."id", 'Chapter 1', NULL, 1,
    CASE e."status"
        WHEN 'PUBLISHED'  THEN 'READY'::"ChapterStatus"
        WHEN 'READY'      THEN 'READY'::"ChapterStatus"
        WHEN 'PROCESSING' THEN 'PROCESSING'::"ChapterStatus"
        WHEN 'FAILED'     THEN 'FAILED'::"ChapterStatus"
        WHEN 'UPLOADING'  THEN 'UPLOADING'::"ChapterStatus"
        ELSE 'DRAFT'::"ChapterStatus"
    END,
    e."createdAt", e."updatedAt",
    e."pdfKey", e."pdfFileSize", e."pageCount", e."processedPages", e."processingError"
FROM "book_editions" e
JOIN "books" b ON b."id" = e."bookId"
WHERE b."type" = 'PDF'
  AND (e."pdfKey" IS NOT NULL
       OR EXISTS (SELECT 1 FROM "book_pages" p WHERE p."editionId" = e."id"));

-- 5. Pages move from the edition to that chapter. PDF editions never had
--    chapters before (the old service refused them), so the join is
--    unambiguous. No DELETE for unmatched rows on purpose: if any page failed
--    to find a chapter, SET NOT NULL aborts and the whole migration rolls back,
--    which is far better than quietly discarding artwork.
ALTER TABLE "book_pages" ADD COLUMN "chapterId" TEXT;

UPDATE "book_pages" p
   SET "chapterId" = c."id"
  FROM "book_chapters" c
 WHERE c."editionId" = p."editionId";

ALTER TABLE "book_pages" ALTER COLUMN "chapterId" SET NOT NULL;

DROP INDEX IF EXISTS "book_pages_editionId_pageNumber_key";
ALTER TABLE "book_pages" DROP CONSTRAINT IF EXISTS "book_pages_editionId_fkey";
ALTER TABLE "book_pages" DROP COLUMN "editionId";

CREATE UNIQUE INDEX "book_pages_chapterId_pageNumber_key" ON "book_pages"("chapterId", "pageNumber");
ALTER TABLE "book_pages" ADD CONSTRAINT "book_pages_chapterId_fkey"
    FOREIGN KEY ("chapterId") REFERENCES "book_chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. A PDF bookmark pointed at an edition and a page number; now that the page
--    belongs to a chapter, point it there too so nobody loses their place.
UPDATE "book_reading_progress" r
   SET "chapterId" = c."id"
  FROM "book_chapters" c
 WHERE c."editionId" = r."editionId"
   AND r."chapterId" IS NULL
   AND c."pdfKey" IS NOT NULL;

-- 7. The edition keeps only what is language-level; conversion is per chapter.
ALTER TABLE "book_editions"
    DROP COLUMN "pdfKey",
    DROP COLUMN "pdfFileSize",
    DROP COLUMN "pageCount",
    DROP COLUMN "processedPages",
    DROP COLUMN "processingError";

-- 8. The books' own taxonomy.
CREATE TABLE "book_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "book_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "_BookToBookCategory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BookToBookCategory_AB_pkey" PRIMARY KEY ("A","B")
);

CREATE UNIQUE INDEX "book_categories_name_key" ON "book_categories"("name");
CREATE INDEX "_BookToBookCategory_B_index" ON "_BookToBookCategory"("B");

-- Carry across every shared category a book was actually filed under, so the
-- split starts with the work already done rather than with an empty shelf.
-- Movie/series categories the books never used are deliberately NOT copied.
INSERT INTO "book_categories" ("id", "name", "description")
SELECT gen_random_uuid(), c."name", c."description"
FROM "categories" c
WHERE EXISTS (SELECT 1 FROM "_BookToCategory" bc WHERE bc."B" = c."id");

INSERT INTO "_BookToBookCategory" ("A", "B")
SELECT bc."A", nc."id"
FROM "_BookToCategory" bc
JOIN "categories" c ON c."id" = bc."B"
JOIN "book_categories" nc ON nc."name" = c."name";

ALTER TABLE "_BookToCategory" DROP CONSTRAINT IF EXISTS "_BookToCategory_A_fkey";
ALTER TABLE "_BookToCategory" DROP CONSTRAINT IF EXISTS "_BookToCategory_B_fkey";
DROP TABLE "_BookToCategory";

ALTER TABLE "_BookToBookCategory" ADD CONSTRAINT "_BookToBookCategory_A_fkey"
    FOREIGN KEY ("A") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_BookToBookCategory" ADD CONSTRAINT "_BookToBookCategory_B_fkey"
    FOREIGN KEY ("B") REFERENCES "book_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
