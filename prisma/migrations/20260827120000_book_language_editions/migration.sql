-- Books become multi-language: the content, its publish state and (for a PDF
-- book) its conversion state move from `books` onto a new `book_editions`
-- row, one per language. Chapters, pages and reading positions repoint from
-- the book to the edition.
--
-- This is written by hand rather than taken from `prisma migrate dev`'s
-- generated diff, because that diff drops the moved columns and the
-- bookId links — i.e. it would delete every existing chapter, page and
-- bookmark. Each step below backfills before it drops.

-- 1. The new table.
CREATE TABLE "book_editions" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" "BookStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pdfKey" TEXT,
    "pdfFileSize" BIGINT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "processedPages" INTEGER NOT NULL DEFAULT 0,
    "processingError" TEXT,

    CONSTRAINT "book_editions_pkey" PRIMARY KEY ("id")
);

-- 2. Every existing book becomes a single edition carrying its current
--    lifecycle verbatim, so nothing published goes dark and no half-finished
--    conversion loses its place. 'my' (Burmese) is the platform's primary
--    language; an admin can change it on any edition afterwards.
INSERT INTO "book_editions" (
    "id", "bookId", "language", "status", "publishedAt",
    "createdAt", "updatedAt",
    "pdfKey", "pdfFileSize", "pageCount", "processedPages", "processingError"
)
SELECT
    gen_random_uuid(), b."id", 'my', b."status", b."publishedAt",
    b."createdAt", b."updatedAt",
    b."pdfKey", b."pdfFileSize", b."pageCount", b."processedPages", b."processingError"
FROM "books" b;

-- 3. Chapters: add the link, backfill through the book, then drop the old one.
ALTER TABLE "book_chapters" ADD COLUMN "editionId" TEXT;
UPDATE "book_chapters" c
   SET "editionId" = e."id"
  FROM "book_editions" e
 WHERE e."bookId" = c."bookId";
ALTER TABLE "book_chapters" ALTER COLUMN "editionId" SET NOT NULL;

DROP INDEX IF EXISTS "book_chapters_bookId_order_idx";
ALTER TABLE "book_chapters" DROP CONSTRAINT IF EXISTS "book_chapters_bookId_fkey";
ALTER TABLE "book_chapters" DROP COLUMN "bookId";

-- 4. Pages: same shape.
ALTER TABLE "book_pages" ADD COLUMN "editionId" TEXT;
UPDATE "book_pages" p
   SET "editionId" = e."id"
  FROM "book_editions" e
 WHERE e."bookId" = p."bookId";
ALTER TABLE "book_pages" ALTER COLUMN "editionId" SET NOT NULL;

DROP INDEX IF EXISTS "book_pages_bookId_pageNumber_key";
ALTER TABLE "book_pages" DROP CONSTRAINT IF EXISTS "book_pages_bookId_fkey";
ALTER TABLE "book_pages" DROP COLUMN "bookId";

-- 5. Reading positions: same shape. The uniqueness moves with it, from one
--    bookmark per book to one per edition.
ALTER TABLE "book_reading_progress" ADD COLUMN "editionId" TEXT;
UPDATE "book_reading_progress" r
   SET "editionId" = e."id"
  FROM "book_editions" e
 WHERE e."bookId" = r."bookId";
ALTER TABLE "book_reading_progress" ALTER COLUMN "editionId" SET NOT NULL;

DROP INDEX IF EXISTS "book_reading_progress_userId_bookId_key";
DROP INDEX IF EXISTS "book_reading_progress_bookId_idx";
ALTER TABLE "book_reading_progress" DROP CONSTRAINT IF EXISTS "book_reading_progress_bookId_fkey";
ALTER TABLE "book_reading_progress" DROP COLUMN "bookId";

-- 6. The book keeps only what is language-neutral.
DROP INDEX IF EXISTS "books_status_idx";
ALTER TABLE "books"
    DROP COLUMN "status",
    DROP COLUMN "publishedAt",
    DROP COLUMN "pdfKey",
    DROP COLUMN "pdfFileSize",
    DROP COLUMN "pageCount",
    DROP COLUMN "processedPages",
    DROP COLUMN "processingError";

-- 7. Indexes and foreign keys for the new shape.
CREATE UNIQUE INDEX "book_editions_bookId_language_key" ON "book_editions"("bookId", "language");
CREATE INDEX "book_editions_status_idx" ON "book_editions"("status");
CREATE INDEX "book_chapters_editionId_order_idx" ON "book_chapters"("editionId", "order");
CREATE UNIQUE INDEX "book_pages_editionId_pageNumber_key" ON "book_pages"("editionId", "pageNumber");
CREATE UNIQUE INDEX "book_reading_progress_userId_editionId_key" ON "book_reading_progress"("userId", "editionId");
CREATE INDEX "book_reading_progress_editionId_idx" ON "book_reading_progress"("editionId");

ALTER TABLE "book_editions" ADD CONSTRAINT "book_editions_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "book_editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "book_pages" ADD CONSTRAINT "book_pages_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "book_editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "book_reading_progress" ADD CONSTRAINT "book_reading_progress_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "book_editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
