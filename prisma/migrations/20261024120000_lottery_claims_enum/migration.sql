-- Prize payment by request, part A (2026-10-24): the new payout statuses.
-- ONLY the enum values live here, in their own migration, because Postgres
-- refuses to USE a value added to an enum inside the same transaction that
-- added it — and the next migration (20261024120100_lottery_claims) sets
-- 'UNCLAIMED' as the column default and the publish service writes it.
-- Pre-flight: none needed (adding enum values never touches a row).

-- AlterEnum
ALTER TYPE "LotteryPayoutStatus" ADD VALUE 'UNCLAIMED';
ALTER TYPE "LotteryPayoutStatus" ADD VALUE 'REQUESTED';
ALTER TYPE "LotteryPayoutStatus" ADD VALUE 'REJECTED';
ALTER TYPE "LotteryPayoutStatus" ADD VALUE 'EXPIRED';
