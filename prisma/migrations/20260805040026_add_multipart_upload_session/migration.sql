-- CreateTable
CREATE TABLE "multipart_upload_sessions" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "minioUploadId" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multipart_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "multipart_upload_sessions_resourceType_resourceId_idx" ON "multipart_upload_sessions"("resourceType", "resourceId");
