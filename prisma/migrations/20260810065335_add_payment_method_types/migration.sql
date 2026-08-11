-- CreateTable
CREATE TABLE "payment_method_types" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requiresBankName" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_types_label_key" ON "payment_method_types"("label");

-- Seed the two built-in methods.
INSERT INTO "payment_method_types" ("id", "label", "requiresBankName", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'KBZPay', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Bank Account', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("label") DO NOTHING;

-- Backfill any type already in use on an existing payment_accounts row
-- (e.g. a custom method created before this table existed) so it becomes
-- a manageable catalog entry instead of an orphaned free-text value.
INSERT INTO "payment_method_types" ("id", "label", "requiresBankName", "createdAt", "updatedAt")
SELECT gen_random_uuid(), pa."type", false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "type" FROM "payment_accounts") pa
ON CONFLICT ("label") DO NOTHING;
