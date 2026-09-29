-- Order-independent payout matching (owner decision 2026-09-28): when a
-- "You sent …" record arrives, the withdrawal matcher first looks for an
-- approved, not-yet-bank-checked withdrawal whose code staff typed by hand
-- and which equals the record's last 6 (ignoring case), approved within
-- 24 h either side of the bank time. Before this, every such lookup would
-- have walked withdrawals_status_idx (every APPROVED row ever). This
-- partial index holds only the coded, unconfirmed payouts, keyed by
-- approvedAt, so the lookup is one bounded range scan. Its predicate is
-- two IS [NOT] NULL tests, which Prisma's own query renders literally, so
-- the planner can prove it (status stays a filter: only APPROVED rows can
-- carry a code). One index build on a small table, like the earlier
-- withdrawals_open_* indexes. The SQL is what `prisma migrate diff` prints
-- for the schema.prisma @@index, so there is no drift.

-- CreateIndex
CREATE INDEX "withdrawals_coded_payout_idx" ON "withdrawals"("approvedAt") WHERE ("bankCheckedAt" IS NULL AND "transferTransactionCode" IS NOT NULL);
