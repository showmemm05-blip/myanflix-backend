import { Prisma } from '../../generated/prisma/client';
import { toAdminMoneyStats } from './admin-money-stats';

describe('toAdminMoneyStats', () => {
  it('reports every status (zero when absent), the grand total and the five tab counts', () => {
    const stats = toAdminMoneyStats(
      [
        {
          status: 'PENDING',
          _count: { _all: 2 },
          _sum: { amount: new Prisma.Decimal('1500.50') },
        },
        {
          status: 'APPROVED',
          _count: { _all: 3 },
          _sum: { amount: new Prisma.Decimal(9000) },
        },
      ],
      {
        all: 7,
        awaiting_bank: 1,
        verified: 2,
        needs_review: 3,
        no_bank_transaction: 1,
      },
    );

    expect(stats).toEqual({
      byStatus: {
        PENDING: { count: 2, amount: 1500.5 },
        APPROVED: { count: 3, amount: 9000 },
        REJECTED: { count: 0, amount: 0 },
      },
      total: { count: 5, amount: 10500.5 },
      verification: {
        all: 7,
        awaiting_bank: 1,
        verified: 2,
        needs_review: 3,
        no_bank_transaction: 1,
      },
    });
  });

  it('turns a null sum (no rows) into 0, never null', () => {
    const stats = toAdminMoneyStats(
      [{ status: 'REJECTED', _count: { _all: 0 }, _sum: { amount: null } }],
      {
        all: 0,
        awaiting_bank: 0,
        verified: 0,
        needs_review: 0,
        no_bank_transaction: 0,
      },
    );
    expect(stats.byStatus.REJECTED).toEqual({ count: 0, amount: 0 });
    expect(stats.total).toEqual({ count: 0, amount: 0 });
  });
});
