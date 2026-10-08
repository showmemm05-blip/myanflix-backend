-- Performance indexes (perf audit 2026-10-07). Index-only: no table,
-- column, enum or relation changes. Every dropped index is a strict prefix
-- of an index kept or created here, so no query loses its index.
-- DropIndex
DROP INDEX "app_role_permissions_roleId_idx";

-- DropIndex
DROP INDEX "series_status_idx";

-- DropIndex
DROP INDEX "transactions_userId_idx";

-- DropIndex
DROP INDEX "wallet_adjustments_userId_idx";

-- DropIndex
DROP INDEX "deposits_userId_idx";

-- DropIndex
DROP INDEX "withdrawals_userId_idx";

-- DropIndex
DROP INDEX "withdrawals_status_idx";

-- DropIndex
DROP INDEX "payment_account_transactions_paymentAccountId_idx";

-- DropIndex
DROP INDEX "notifications_userId_idx";

-- DropIndex
DROP INDEX "comments_movieId_idx";

-- DropIndex
DROP INDEX "comments_seriesId_idx";

-- DropIndex
DROP INDEX "comments_bookId_idx";

-- DropIndex
DROP INDEX "user_sessions_userId_idx";

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "users_role_createdAt_idx" ON "users"("role", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "movies_standalone_recent_idx" ON "movies"("status", "createdAt" DESC, "id" DESC) WHERE ("seriesId" IS NULL);

-- CreateIndex
CREATE INDEX "series_status_createdAt_id_idx" ON "series"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "book_reading_progress_chapterId_idx" ON "book_reading_progress"("chapterId");

-- CreateIndex
CREATE INDEX "book_reading_progress_sectionId_idx" ON "book_reading_progress"("sectionId");

-- CreateIndex
CREATE INDEX "upload_sessions_status_updatedAt_idx" ON "upload_sessions"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "multipart_upload_sessions_status_updatedAt_idx" ON "multipart_upload_sessions"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "multipart_upload_sessions_minioUploadId_idx" ON "multipart_upload_sessions"("minioUploadId");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wallet_adjustments_userId_createdAt_idx" ON "wallet_adjustments"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wallet_adjustments_performedByUserId_idx" ON "wallet_adjustments"("performedByUserId");

-- CreateIndex
CREATE INDEX "deposits_approvedByUserId_idx" ON "deposits"("approvedByUserId");

-- CreateIndex
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "withdrawals_accountNumber_idx" ON "withdrawals"("accountNumber");

-- CreateIndex
CREATE INDEX "withdrawals_approvedByUserId_idx" ON "withdrawals"("approvedByUserId");

-- CreateIndex
CREATE INDEX "payment_account_transactions_paymentAccountId_createdAt_idx" ON "payment_account_transactions"("paymentAccountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "payment_account_transactions_performedByUserId_idx" ON "payment_account_transactions"("performedByUserId");

-- CreateIndex
CREATE INDEX "watch_history_userId_updatedAt_idx" ON "watch_history"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "comments_movieId_parentId_status_createdAt_idx" ON "comments"("movieId", "parentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "comments_seriesId_parentId_status_createdAt_idx" ON "comments"("seriesId", "parentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "comments_bookId_parentId_status_createdAt_idx" ON "comments"("bookId", "parentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "user_sessions_userId_lastSeenAt_idx" ON "user_sessions"("userId", "lastSeenAt" DESC);

