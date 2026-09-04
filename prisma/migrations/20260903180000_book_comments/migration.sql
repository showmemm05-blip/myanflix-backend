-- Comments on books. ADDITIVE ONLY: one nullable column, one index, one
-- foreign key on `comments`. No existing row changes; every movie/series
-- comment reads exactly as before (bookId is NULL for all of them).
-- Hand-written so the names match what Prisma generates for
-- Comment.bookId / @@index([bookId]) / book relation in schema.prisma
-- (a later `migrate diff` is a no-op).

ALTER TABLE "comments" ADD COLUMN "bookId" TEXT;

CREATE INDEX "comments_bookId_idx" ON "comments"("bookId");

ALTER TABLE "comments" ADD CONSTRAINT "comments_bookId_fkey"
    FOREIGN KEY ("bookId") REFERENCES "books"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
