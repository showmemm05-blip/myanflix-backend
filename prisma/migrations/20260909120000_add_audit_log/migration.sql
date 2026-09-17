-- Staff audit log: an append-only table of important staff actions (who,
-- what, which target, what changed, from where). ADDITIVE ONLY: a new enum,
-- a new table with its indexes, and one SetNull foreign key to `users` so a
-- deleted staff account leaves its history behind. Hand-written to match
-- what `prisma migrate diff` emits for the AuditLog model (a diff afterwards
-- is a no-op). Deliberately NO trigger and NO app_role_permissions INSERT:
-- immutability is enforced by the app (AuditService only ever creates), and
-- AUDIT.VIEW is meant for SUPER_ADMIN alone, which is a protected role and
-- so already resolves to every catalogue permission without a row.

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('CONTENT', 'USERS', 'FINANCE', 'STAFF', 'SYSTEM');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" "AuditCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorUsername" TEXT NOT NULL,
    "actorDisplayName" TEXT,
    "actorRole" "Role",
    "actorAppRoleId" TEXT,
    "actorAppRoleName" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "changes" JSONB,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "platform" "ClientPlatform" NOT NULL DEFAULT 'UNKNOWN',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_createdAt_idx" ON "audit_logs"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_category_createdAt_idx" ON "audit_logs"("category", "createdAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
