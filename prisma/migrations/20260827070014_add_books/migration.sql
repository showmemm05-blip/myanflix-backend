-- CreateEnum
CREATE TYPE "BookType" AS ENUM ('EDITOR', 'PDF');

-- CreateEnum
CREATE TYPE "BookStatus" AS ENUM ('DRAFT', 'UPLOADING', 'PROCESSING', 'READY', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "books" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "coverUrl" TEXT,
    "type" "BookType" NOT NULL,
    "status" "BookStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pdfKey" TEXT,
    "pdfFileSize" BIGINT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "processedPages" INTEGER NOT NULL DEFAULT 0,
    "processingError" TEXT,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_chapters" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_pages" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "imageKey" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fileSize" INTEGER NOT NULL,

    CONSTRAINT "book_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_reading_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "chapterId" TEXT,
    "pageNumber" INTEGER,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_reading_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_BookToCategory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BookToCategory_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "books_status_idx" ON "books"("status");

-- CreateIndex
CREATE INDEX "books_type_idx" ON "books"("type");

-- CreateIndex
CREATE INDEX "book_chapters_bookId_order_idx" ON "book_chapters"("bookId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "book_pages_bookId_pageNumber_key" ON "book_pages"("bookId", "pageNumber");

-- CreateIndex
CREATE INDEX "book_reading_progress_bookId_idx" ON "book_reading_progress"("bookId");

-- CreateIndex
CREATE UNIQUE INDEX "book_reading_progress_userId_bookId_key" ON "book_reading_progress"("userId", "bookId");

-- CreateIndex
CREATE INDEX "_BookToCategory_B_index" ON "_BookToCategory"("B");

-- AddForeignKey
ALTER TABLE "book_chapters" ADD CONSTRAINT "book_chapters_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_pages" ADD CONSTRAINT "book_pages_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_reading_progress" ADD CONSTRAINT "book_reading_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_reading_progress" ADD CONSTRAINT "book_reading_progress_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_reading_progress" ADD CONSTRAINT "book_reading_progress_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "book_chapters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BookToCategory" ADD CONSTRAINT "_BookToCategory_A_fkey" FOREIGN KEY ("A") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BookToCategory" ADD CONSTRAINT "_BookToCategory_B_fkey" FOREIGN KEY ("B") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant the new BOOKS permissions to the already-seeded system roles, the
-- same way the add_tracking migration granted TRACKING.* — the seed arrays
-- in src/roles/system-roles.seed.ts only describe fresh databases; existing
-- app_role_permissions rows are data and must be migrated here.
-- SUPER_ADMIN needs no rows: the resolver short-circuits it to everything.
INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('ADMIN', 'BOOKS.VIEW'),
  ('ADMIN', 'BOOKS.CREATE'),
  ('ADMIN', 'BOOKS.EDIT'),
  ('ADMIN', 'BOOKS.DELETE'),
  ('ADMIN', 'BOOKS.PUBLISH'),
  ('ADMIN', 'BOOKS.UNPUBLISH'),
  ('CONTENT_UPLOADER', 'BOOKS.VIEW'),
  ('CONTENT_UPLOADER', 'BOOKS.CREATE'),
  ('CONTENT_UPLOADER', 'BOOKS.EDIT'),
  ('CONTENT_UPLOADER', 'BOOKS.PUBLISH'),
  ('CONTENT_UPLOADER', 'BOOKS.UNPUBLISH')
) AS seed(role_key, permission) ON seed.role_key = r."key"
ON CONFLICT ("roleId", "permission") DO NOTHING;
