-- Money guard rails (audit 2026-10-09, DB-001 / action-plan step 1.8).
-- CHECK constraints only: no table, column, index or enum changes, and
-- schema.prisma is untouched because Prisma does not model CHECK
-- constraints (so `prisma migrate diff` stays empty by design — the CHECKs
-- are neither flagged as drift nor ever generated automatically).
--
-- PRE-FLIGHT (read-only): runbook Q14 (docs/audit/data/money-drift-runbook.sql)
-- must return 0 rows before applying. Every ADD CONSTRAINT below is
-- without NOT VALID, so Postgres scans the existing rows and the whole
-- migration fails and rolls back on the first row that breaks a rule —
-- nothing is left half-applied, and the rows Q14 lists are the ones to fix
-- first.
--
-- > versus >= — decided from every code path in backend/src that writes
-- the column (read 2026-10-09):
--
--   wallets.balance >= 0
--     Every wallet starts at 0; WalletService.creditWithinTransaction adds
--     a positive amount and debitWithinTransaction is one conditional UPDATE
--     guarded by `balance >= amount` (wallet.service.ts), which the
--     subscribe, withdrawal-hold and wallet-adjustment debits all go
--     through. Nothing writes a negative balance.
--
--   transactions.amount > 0, with ONE allowed zero: a SUBSCRIPTION row
--     DEPOSIT rows carry the credited amount (the typed amount, >= 0.01 by
--     DTO, or the bank's, >= 0.01 by BankEventDto); the WITHDRAWAL hold /
--     legacy-approve rows and the REFUND row carry the withdrawal's amount
--     (>= 0.01); ADJUSTMENT_CREDIT / ADJUSTMENT_DEBIT carry the positive
--     magnitude (IsPositive) — the sign lives in `type`, never in `amount`.
--     The one legitimate zero: SubscriptionsService.subscribe writes
--     `amount: plan.price` (subscriptions.service.ts) and a plan may cost 0
--     (CreatePlanDto/UpdatePlanDto @Min(0); the admin form sends 0 for a
--     cleared price field), so a free plan's ledger row is 0. Hence
--     `amount > 0 OR (amount = 0 AND type = 'SUBSCRIPTION')` rather than a
--     blanket >= 0, which would also let a zero deposit or payout through.
--
--   deposits.amount > 0
--     CreateDepositDto / CreateManualDepositDto @Min(0.01); approve may
--     overwrite it with the bank's amount (>= 0.01). No reversal or refund
--     row ever lives in this table.
--
--   withdrawals.amount > 0
--     CreateWithdrawalDto @Min(0.01); never rewritten afterwards.
--
--   wallet_adjustments.amount > 0
--     The positive magnitude; `direction` carries the sign
--     (CreateWalletAdjustmentDto IsPositive, wallet-adjustments.service.ts).
--
--   payment_account_transactions.amount > 0
--     applyMovement stores the positive magnitude for EVERY type, the
--     reversal rows included: the ADJUSTMENT_DEBIT / ADJUSTMENT_CREDIT rows
--     that syncDepositLink / syncWithdrawalLink post on a re-link carry
--     deposit.amount / withdrawal.amount, and only the balance increment is
--     signed (payment-account-ledger.service.ts applyMovement). Manual
--     entries are IsPositive.
--
--   user_subscriptions.amount >= 0
--     plan.price at purchase time; 0 for a free plan (see transactions).
--
--   subscription_plans.price >= 0
--     CreatePlanDto / UpdatePlanDto @Min(0).
--
--   finance_settings: min <= max AND max > 0, per side
--     FinanceSettingsService.update refuses min > max and the DTO requires
--     each maximum >= 1 (L-34); the defaults written on first read are
--     1000 / 5 000 000.
--
--   payment_accounts.balance — deliberately NOT constrained
--     applyMovement has no `gte` guard: the business ledger may go negative
--     by design (an approved payout before its credits were recorded).

-- AddCheckConstraint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_balance_check" CHECK ("balance" >= 0);

-- AddCheckConstraint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_check" CHECK ("amount" > 0 OR ("amount" = 0 AND "type" = 'SUBSCRIPTION'::"TransactionType"));

-- AddCheckConstraint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_amount_check" CHECK ("amount" > 0);

-- AddCheckConstraint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_amount_check" CHECK ("amount" > 0);

-- AddCheckConstraint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_amount_check" CHECK ("amount" > 0);

-- AddCheckConstraint
ALTER TABLE "payment_account_transactions" ADD CONSTRAINT "payment_account_transactions_amount_check" CHECK ("amount" > 0);

-- AddCheckConstraint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_amount_check" CHECK ("amount" >= 0);

-- AddCheckConstraint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_price_check" CHECK ("price" >= 0);

-- AddCheckConstraint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_deposit_limits_check" CHECK ("minDepositAmount" <= "maxDepositAmount" AND "maxDepositAmount" > 0);

-- AddCheckConstraint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_withdrawal_limits_check" CHECK ("minWithdrawalAmount" <= "maxWithdrawalAmount" AND "maxWithdrawalAmount" > 0);
