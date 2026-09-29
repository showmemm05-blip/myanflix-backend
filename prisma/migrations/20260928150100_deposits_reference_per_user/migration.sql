-- H-11: the 6-digit reference is unique among LIVE (PENDING/APPROVED)
-- deposits PER USER instead of across everyone. A double submit by the same
-- user is still refused by the database; a second user with the same last-6
-- is stored and flagged (DUPLICATE_REFERENCE / SHARED_REFERENCE_ACROSS_USERS)
-- for staff review instead of being refused while the first submitter owns it.
-- Pre-flight: none needed — (userId, reference) is strictly weaker than the
-- old (reference) rule, so every existing row already satisfies it.
-- The new index is created before the old one is dropped, so there is never a
-- moment without a guard.

-- CreateIndex
CREATE UNIQUE INDEX "deposits_user_reference_active_key" ON "deposits"("userId", "reference") WHERE (status = ANY (ARRAY['PENDING'::"DepositStatus", 'APPROVED'::"DepositStatus"]));

-- DropIndex
DROP INDEX "deposits_reference_active_key";
