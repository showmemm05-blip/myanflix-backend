-- Membership levels: the user's level is derived at read time from
-- SUM(amount) of APPROVED deposits vs these thresholds. Additive only.
CREATE TABLE "user_levels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_levels_pkey" PRIMARY KEY ("id")
);

-- Seed the six example levels (thresholds are admin-editable from day one).
INSERT INTO "user_levels" ("id", "name", "threshold", "icon", "color", "order", "enabled", "createdAt", "updatedAt") VALUES
('a0000000-0000-4000-8000-000000000001', 'Starter',  0.00,     'shield',          '#8B909A', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('a0000000-0000-4000-8000-000000000002', 'Bronze',   100.00,   'shield-chevron',  '#CD7F32', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('a0000000-0000-4000-8000-000000000003', 'Silver',   500.00,   'shield-facet',    '#C0C4CE', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('a0000000-0000-4000-8000-000000000004', 'Gold',     1000.00,  'crest-crown',     '#F0B90B', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('a0000000-0000-4000-8000-000000000005', 'Platinum', 5000.00,  'wings-crystal',   '#8B5CF6', 5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('a0000000-0000-4000-8000-000000000006', 'Diamond',  10000.00, 'radiant-crystal', '#38BDF8', 6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
