-- Book hierarchy: optional Parts above chapters and optional Sections inside
-- them. ADDITIVE ONLY: two new tables and two nullable columns. No existing
-- row is touched, so every book, chapter, page and bookmark reads exactly as
-- it did before. Hand-written so the constraint names match what Prisma
-- expects for the models in schema.prisma (a later `migrate diff` is a no-op).

-- 1. Parts: a structural grouping of chapters inside one edition.
CREATE TABLE "book_parts" (
    "id" TEXT NOT NULL,
    "editionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_parts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "book_parts_editionId_order_idx" ON "book_parts"("editionId", "order");

ALTER TABLE "book_parts" ADD CONSTRAINT "book_parts_editionId_fkey"
    FOREIGN KEY ("editionId") REFERENCES "book_editions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. A chapter may belong to a part. SET NULL: deleting a part keeps its
--    chapters, which simply become unparted again.
ALTER TABLE "book_chapters" ADD COLUMN "partId" TEXT;

CREATE INDEX "book_chapters_partId_idx" ON "book_chapters"("partId");

ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_partId_fkey"
    FOREIGN KEY ("partId") REFERENCES "book_parts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Sections: subdivisions inside a chapter. `content` for written books,
--    `startPage` for PDF books; the service enforces which one applies.
CREATE TABLE "book_sections" (
    "id" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "content" JSONB,
    "startPage" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_sections_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "book_sections_chapterId_order_idx" ON "book_sections"("chapterId", "order");

ALTER TABLE "book_sections" ADD CONSTRAINT "book_sections_chapterId_fkey"
    FOREIGN KEY ("chapterId") REFERENCES "book_chapters"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. A bookmark may remember the section, the way it remembers the chapter.
ALTER TABLE "book_reading_progress" ADD COLUMN "sectionId" TEXT;

ALTER TABLE "book_reading_progress" ADD CONSTRAINT "book_reading_progress_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "book_sections"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
