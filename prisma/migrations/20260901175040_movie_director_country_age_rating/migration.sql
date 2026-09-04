-- CreateEnum
CREATE TYPE "AgeRating" AS ENUM ('G', 'PG', 'PG13', 'R', 'NC17');

-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "ageRating" "AgeRating",
ADD COLUMN     "country" TEXT,
ADD COLUMN     "director" TEXT;
