-- H-23: book_chapters."pagesSourceEtag" is the ETag of the source PDF the
-- chapter's stored book_pages rows were converted from. A conversion resumes
-- those pages only for that exact file; a re-uploaded PDF (same fixed key,
-- different ETag) clears them and converts from scratch.
-- Existing rows keep NULL ("source unknown"): their next conversion starts
-- from page 1 instead of trusting pages that may belong to an older file.
-- Pre-flight: none needed (a new nullable column, no backfill).

-- AlterTable
ALTER TABLE "book_chapters" ADD COLUMN     "pagesSourceEtag" TEXT;
