-- One LIVE (PENDING/APPROVED) deposit per reference; REJECTED rows are excluded so a reference can be resubmitted after a mistaken rejection.
-- Pre-flight: SELECT reference, count(*) FROM deposits WHERE status IN ('PENDING','APPROVED') GROUP BY reference HAVING count(*) > 1 must return 0 rows.
-- CreateIndex
CREATE UNIQUE INDEX "deposits_reference_active_key" ON "deposits"("reference") WHERE (status = ANY (ARRAY['PENDING'::"DepositStatus", 'APPROVED'::"DepositStatus"]));
