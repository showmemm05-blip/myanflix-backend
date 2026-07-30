-- CreateEnum
CREATE TYPE "SubtitleFormat" AS ENUM ('SRT', 'VTT', 'ASS');

-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "thumbnailUrl" TEXT;

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN     "relativePath" TEXT;

-- CreateTable
CREATE TABLE "subtitles" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "format" "SubtitleFormat" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subtitles_videoId_idx" ON "subtitles"("videoId");

-- AddForeignKey
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
