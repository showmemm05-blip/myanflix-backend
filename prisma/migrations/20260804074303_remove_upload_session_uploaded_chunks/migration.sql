/*
  Warnings:

  - You are about to drop the column `uploadedChunks` on the `upload_sessions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "upload_sessions" DROP COLUMN "uploadedChunks";
