-- Bank transactions: every bank notification a phone captured, stored BEFORE
-- matching (store-first, owner decision 2026-09-22 — the one new table the
-- payment-verification feature is allowed). deposits/withdrawals unchanged;
-- they only gain a back-relation in schema.prisma, which is not a column.
-- The two unique link indexes and the open-set partial index keep every
-- lookup proportional to transfers, never to rows. Every CREATE here is
-- metadata-only on an empty table (Postgres 17). The SQL is what
-- `prisma migrate diff` prints for the model (same rendering of the partial
-- predicate as deposits_open_match_idx, so there is no drift).

-- CreateEnum
CREATE TYPE "BankTransactionDirection" AS ENUM ('RECEIVED', 'SENT');

-- CreateEnum
CREATE TYPE "BankTransactionState" AS ENUM ('UNMATCHED', 'MATCHED', 'AMBIGUOUS');

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "paymentAccountId" TEXT NOT NULL,
    "direction" "BankTransactionDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MMK',
    "txCode" TEXT NOT NULL,
    "txCodeLast6" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "counterparty" TEXT,
    "screenshotKey" TEXT,
    "detailStatus" TEXT,
    "state" "BankTransactionState" NOT NULL DEFAULT 'UNMATCHED',
    "linkedDepositId" TEXT,
    "linkedWithdrawalId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one stored row per phone event key; a re-post can never duplicate.
CREATE UNIQUE INDEX "bank_transactions_idempotencyKey_key" ON "bank_transactions"("idempotencyKey");

-- CreateIndex — one transaction per deposit / per withdrawal (NULLs are free in Postgres unique indexes).
CREATE UNIQUE INDEX "bank_transactions_linkedDepositId_key" ON "bank_transactions"("linkedDepositId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_linkedWithdrawalId_key" ON "bank_transactions"("linkedWithdrawalId");

-- CreateIndex — THE OPEN SET: "You received …" rows nobody has claimed. Deposit
-- creation and ingestion look up (account, last-6) here with the predicate as
-- literal SQL, so Postgres can prove the query implies it (a bound `state = $n`
-- cannot). Holds today's unclaimed transfers, never history.
CREATE INDEX "bank_transactions_open_received_idx" ON "bank_transactions"("paymentAccountId", "txCodeLast6") WHERE (state = 'UNMATCHED'::"BankTransactionState" AND direction = 'RECEIVED'::"BankTransactionDirection");

-- CreateIndex — the admin list by phone / by account / everything, newest bank time first.
CREATE INDEX "bank_transactions_deviceSerial_occurredAt_idx" ON "bank_transactions"("deviceSerial", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "bank_transactions_paymentAccountId_occurredAt_idx" ON "bank_transactions"("paymentAccountId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "bank_transactions_occurredAt_idx" ON "bank_transactions"("occurredAt" DESC);

-- CreateIndex — the unmatched / ambiguous / unclaimed filters (unclaimed = UNMATCHED AND occurredAt < now - 48 h, computed at read time).
CREATE INDEX "bank_transactions_state_occurredAt_idx" ON "bank_transactions"("state", "occurredAt" DESC);

-- CreateIndex — the direction filter (Received / Sent) on its own. Two values,
-- but with occurredAt DESC behind it the index is a band in time order, exactly
-- what the list and its capped count need; without it a "Sent" filter with no
-- phone selected was the one combination the planner served with a sequential
-- scan at 200k rows (EXPLAIN, 2026-09-23).
CREATE INDEX "bank_transactions_direction_occurredAt_idx" ON "bank_transactions"("direction", "occurredAt" DESC);

-- AddForeignKey — RESTRICT: a business account with bank evidence cannot be deleted (PaymentAccountsService.remove guards it with a 409, like its ledger guard).
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — a deleted deposit/withdrawal (user cascade) leaves the transaction UNLINKED, never deleted: it is evidence.
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_linkedDepositId_fkey" FOREIGN KEY ("linkedDepositId") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_linkedWithdrawalId_fkey" FOREIGN KEY ("linkedWithdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
