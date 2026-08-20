-- AlterTable
ALTER TABLE "users" ADD COLUMN     "appRoleId" TEXT;

-- CreateTable
CREATE TABLE "app_roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_role_permissions" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_roles_key_key" ON "app_roles"("key");

-- CreateIndex
CREATE INDEX "app_role_permissions_roleId_idx" ON "app_role_permissions"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "app_role_permissions_roleId_permission_key" ON "app_role_permissions"("roleId", "permission");

-- CreateIndex
CREATE INDEX "users_appRoleId_idx" ON "users"("appRoleId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_appRoleId_fkey" FOREIGN KEY ("appRoleId") REFERENCES "app_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_role_permissions" ADD CONSTRAINT "app_role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "app_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Seed the four built-in roles + backfill every existing user onto them.
--
-- Each permission set is the granular expansion of what the old static
-- ROLE_PERMISSIONS map granted that role, so effective access after this
-- migration is identical to before it (proved route-by-route in
-- src/roles/system-roles.seed.spec.ts). Counts: SUPER_ADMIN=61, ADMIN=32, CONTENT_UPLOADER=16, USER=0.
-- ---------------------------------------------------------------------------

INSERT INTO "app_roles" ("id", "key", "name", "description", "isSystem", "isProtected", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'SUPER_ADMIN', 'Super Admin', 'Full access to every module. Protected: its permissions cannot be edited and it cannot be deleted.', true, true, now(), now()),
  (gen_random_uuid(), 'ADMIN', 'Admin', 'Content, categories and day-to-day finance operations (deposits, withdrawals, subscription plans).', true, false, now(), now()),
  (gen_random_uuid(), 'CONTENT_UPLOADER', 'Content Uploader', 'Content ingestion only — movies, series and their media. No finance, users or staff.', true, false, now(), now()),
  (gen_random_uuid(), 'USER', 'User', 'End-user accounts (website and mobile). No admin permissions at all.', true, false, now(), now());

INSERT INTO "app_role_permissions" ("id", "roleId", "permission", "createdAt")
SELECT gen_random_uuid(), r."id", seed.permission, now()
FROM "app_roles" r
JOIN (
  VALUES
  ('SUPER_ADMIN', 'DASHBOARD.VIEW'),
  ('SUPER_ADMIN', 'MOVIES.VIEW'),
  ('SUPER_ADMIN', 'MOVIES.CREATE'),
  ('SUPER_ADMIN', 'MOVIES.EDIT'),
  ('SUPER_ADMIN', 'MOVIES.DELETE'),
  ('SUPER_ADMIN', 'MOVIES.PUBLISH'),
  ('SUPER_ADMIN', 'MOVIES.UNPUBLISH'),
  ('SUPER_ADMIN', 'SERIES.VIEW'),
  ('SUPER_ADMIN', 'SERIES.CREATE'),
  ('SUPER_ADMIN', 'SERIES.EDIT'),
  ('SUPER_ADMIN', 'SERIES.DELETE'),
  ('SUPER_ADMIN', 'SERIES.PUBLISH'),
  ('SUPER_ADMIN', 'SERIES.UNPUBLISH'),
  ('SUPER_ADMIN', 'MEDIA.VIEW'),
  ('SUPER_ADMIN', 'MEDIA.UPLOAD'),
  ('SUPER_ADMIN', 'MEDIA.DELETE'),
  ('SUPER_ADMIN', 'CATEGORIES.VIEW'),
  ('SUPER_ADMIN', 'CATEGORIES.CREATE'),
  ('SUPER_ADMIN', 'CATEGORIES.EDIT'),
  ('SUPER_ADMIN', 'CATEGORIES.DELETE'),
  ('SUPER_ADMIN', 'USERS.VIEW'),
  ('SUPER_ADMIN', 'USERS.EDIT'),
  ('SUPER_ADMIN', 'USERS.SUSPEND'),
  ('SUPER_ADMIN', 'USERS.WALLET_ADJUST'),
  ('SUPER_ADMIN', 'STAFF.VIEW'),
  ('SUPER_ADMIN', 'STAFF.CREATE'),
  ('SUPER_ADMIN', 'STAFF.EDIT'),
  ('SUPER_ADMIN', 'STAFF.DELETE'),
  ('SUPER_ADMIN', 'ROLES.VIEW'),
  ('SUPER_ADMIN', 'ROLES.CREATE'),
  ('SUPER_ADMIN', 'ROLES.EDIT'),
  ('SUPER_ADMIN', 'ROLES.DELETE'),
  ('SUPER_ADMIN', 'DEPOSITS.VIEW'),
  ('SUPER_ADMIN', 'DEPOSITS.APPROVE'),
  ('SUPER_ADMIN', 'DEPOSITS.REJECT'),
  ('SUPER_ADMIN', 'DEPOSITS.CREATE'),
  ('SUPER_ADMIN', 'DEPOSITS.EDIT'),
  ('SUPER_ADMIN', 'WITHDRAWALS.VIEW'),
  ('SUPER_ADMIN', 'WITHDRAWALS.APPROVE'),
  ('SUPER_ADMIN', 'WITHDRAWALS.REJECT'),
  ('SUPER_ADMIN', 'WITHDRAWALS.EDIT'),
  ('SUPER_ADMIN', 'PAYMENT_METHODS.VIEW'),
  ('SUPER_ADMIN', 'PAYMENT_METHODS.CREATE'),
  ('SUPER_ADMIN', 'PAYMENT_METHODS.EDIT'),
  ('SUPER_ADMIN', 'PAYMENT_METHODS.DELETE'),
  ('SUPER_ADMIN', 'PAYMENT_ACCOUNTS.VIEW'),
  ('SUPER_ADMIN', 'PAYMENT_ACCOUNTS.CREATE'),
  ('SUPER_ADMIN', 'PAYMENT_ACCOUNTS.EDIT'),
  ('SUPER_ADMIN', 'PAYMENT_ACCOUNTS.DELETE'),
  ('SUPER_ADMIN', 'PAYMENT_ACCOUNTS.LEDGER_MANAGE'),
  ('SUPER_ADMIN', 'FINANCE.VIEW'),
  ('SUPER_ADMIN', 'FINANCE.EXPORT'),
  ('SUPER_ADMIN', 'FINANCE.SETTINGS_MANAGE'),
  ('SUPER_ADMIN', 'SUBSCRIPTIONS.VIEW'),
  ('SUPER_ADMIN', 'SUBSCRIPTIONS.CREATE'),
  ('SUPER_ADMIN', 'SUBSCRIPTIONS.EDIT'),
  ('SUPER_ADMIN', 'SUBSCRIPTIONS.DELETE'),
  ('SUPER_ADMIN', 'PEAK_USERS.VIEW'),
  ('SUPER_ADMIN', 'PEAK_USERS.MANAGE'),
  ('SUPER_ADMIN', 'SETTINGS.VIEW'),
  ('SUPER_ADMIN', 'SETTINGS.MANAGE'),
  ('ADMIN', 'DASHBOARD.VIEW'),
  ('ADMIN', 'MOVIES.VIEW'),
  ('ADMIN', 'MOVIES.CREATE'),
  ('ADMIN', 'MOVIES.EDIT'),
  ('ADMIN', 'MOVIES.DELETE'),
  ('ADMIN', 'MOVIES.PUBLISH'),
  ('ADMIN', 'MOVIES.UNPUBLISH'),
  ('ADMIN', 'SERIES.VIEW'),
  ('ADMIN', 'SERIES.CREATE'),
  ('ADMIN', 'SERIES.EDIT'),
  ('ADMIN', 'SERIES.DELETE'),
  ('ADMIN', 'SERIES.PUBLISH'),
  ('ADMIN', 'SERIES.UNPUBLISH'),
  ('ADMIN', 'MEDIA.VIEW'),
  ('ADMIN', 'MEDIA.UPLOAD'),
  ('ADMIN', 'MEDIA.DELETE'),
  ('ADMIN', 'CATEGORIES.VIEW'),
  ('ADMIN', 'CATEGORIES.CREATE'),
  ('ADMIN', 'CATEGORIES.EDIT'),
  ('ADMIN', 'CATEGORIES.DELETE'),
  ('ADMIN', 'DEPOSITS.VIEW'),
  ('ADMIN', 'DEPOSITS.APPROVE'),
  ('ADMIN', 'DEPOSITS.REJECT'),
  ('ADMIN', 'DEPOSITS.CREATE'),
  ('ADMIN', 'DEPOSITS.EDIT'),
  ('ADMIN', 'WITHDRAWALS.VIEW'),
  ('ADMIN', 'WITHDRAWALS.APPROVE'),
  ('ADMIN', 'WITHDRAWALS.REJECT'),
  ('ADMIN', 'WITHDRAWALS.EDIT'),
  ('ADMIN', 'SUBSCRIPTIONS.VIEW'),
  ('ADMIN', 'SUBSCRIPTIONS.CREATE'),
  ('ADMIN', 'SUBSCRIPTIONS.EDIT'),
  ('CONTENT_UPLOADER', 'MOVIES.VIEW'),
  ('CONTENT_UPLOADER', 'MOVIES.CREATE'),
  ('CONTENT_UPLOADER', 'MOVIES.EDIT'),
  ('CONTENT_UPLOADER', 'MOVIES.PUBLISH'),
  ('CONTENT_UPLOADER', 'MOVIES.UNPUBLISH'),
  ('CONTENT_UPLOADER', 'SERIES.VIEW'),
  ('CONTENT_UPLOADER', 'SERIES.CREATE'),
  ('CONTENT_UPLOADER', 'SERIES.EDIT'),
  ('CONTENT_UPLOADER', 'SERIES.DELETE'),
  ('CONTENT_UPLOADER', 'SERIES.PUBLISH'),
  ('CONTENT_UPLOADER', 'SERIES.UNPUBLISH'),
  ('CONTENT_UPLOADER', 'MEDIA.VIEW'),
  ('CONTENT_UPLOADER', 'MEDIA.UPLOAD'),
  ('CONTENT_UPLOADER', 'MEDIA.DELETE'),
  ('CONTENT_UPLOADER', 'CATEGORIES.CREATE'),
  ('CONTENT_UPLOADER', 'CATEGORIES.EDIT')
) AS seed(role_key, permission) ON seed.role_key = r."key";

-- Existing accounts keep their access: point each one at the system role
-- matching the enum value it already carries.
UPDATE "users" u
SET "appRoleId" = r."id"
FROM "app_roles" r
WHERE r."key" = u."role"::text;

