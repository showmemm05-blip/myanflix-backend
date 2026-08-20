-- DropForeignKey
ALTER TABLE "movies" DROP CONSTRAINT "movies_seriesId_fkey";

-- AddForeignKey
ALTER TABLE "movies" ADD CONSTRAINT "movies_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
