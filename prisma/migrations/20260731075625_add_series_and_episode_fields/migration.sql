-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "episodeNumber" INTEGER,
ADD COLUMN     "seasonNumber" INTEGER,
ADD COLUMN     "seriesId" TEXT;

-- CreateTable
CREATE TABLE "series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "posterUrl" TEXT,
    "coverUrl" TEXT,
    "genre" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "releaseYear" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "movies_seriesId_seasonNumber_episodeNumber_idx" ON "movies"("seriesId", "seasonNumber", "episodeNumber");

-- AddForeignKey
ALTER TABLE "movies" ADD CONSTRAINT "movies_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;
