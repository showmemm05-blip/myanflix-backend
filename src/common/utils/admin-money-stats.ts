import { Prisma } from '../../generated/prisma/client';
import type { VerificationFilter } from '../dto/verification-filter';
import { decimalToNumber } from './decimal.util';

/** DepositStatus and WithdrawalStatus share these three members. */
const MONEY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
type MoneyStatus = (typeof MONEY_STATUSES)[number];

export interface CountAndAmount {
  count: number;
  amount: number;
}

/**
 * GET /deposits/stats and GET /withdrawals/stats (H-24): the admin queue's
 * stat cards and tab counts, computed by the database over every matching
 * row instead of summed from the one page the browser loaded.
 */
export interface AdminMoneyStats {
  /** Per money status, under the selected verification tab. */
  byStatus: Record<MoneyStatus, CountAndAmount>;
  /** Sum of byStatus. */
  total: CountAndAmount;
  /** Rows per verification tab, under the selected status filter. */
  verification: Record<VerificationFilter, number>;
}

/** Shapes a `groupBy(['status'])` result and the five tab counts. */
export function toAdminMoneyStats(
  grouped: readonly {
    status: MoneyStatus;
    _count: { _all: number };
    _sum: { amount: Prisma.Decimal | null };
  }[],
  verification: Record<VerificationFilter, number>,
): AdminMoneyStats {
  const byStatus = Object.fromEntries(
    MONEY_STATUSES.map((status) => {
      const row = grouped.find((g) => g.status === status);
      return [
        status,
        {
          count: row?._count._all ?? 0,
          amount: decimalToNumber(row?._sum.amount),
        },
      ];
    }),
  ) as Record<MoneyStatus, CountAndAmount>;

  // Summed as Decimals so the grand total carries no float drift.
  const total = {
    count: grouped.reduce((sum, g) => sum + g._count._all, 0),
    amount: decimalToNumber(
      grouped.reduce(
        (sum, g) => sum.plus(g._sum.amount ?? 0),
        new Prisma.Decimal(0),
      ),
    ),
  };

  return { byStatus, total, verification };
}
