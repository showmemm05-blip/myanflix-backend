import {
  BankMatchStatus,
  WithdrawalStatus,
  type Prisma,
} from '../generated/prisma/client';
import { WITHDRAWAL_PAYOUT_WINDOW_MS } from '../bank-events/risk-rules';
import type { VerificationFilter } from '../common/dto/verification-filter';

/**
 * The admin search box (H-24), matched over the whole table: the payout
 * account name and number the user entered, and the requesting account by
 * username, display name or phone — the same three UsersService.findAll
 * searches. Blank = no filter.
 */
export function withdrawalSearchWhere(
  search: string | undefined,
): Prisma.WithdrawalWhereInput | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  return {
    OR: [
      { accountName: { contains: term, mode: 'insensitive' } },
      { accountNumber: { contains: term } },
      { user: { username: { contains: term, mode: 'insensitive' } } },
      { user: { displayName: { contains: term, mode: 'insensitive' } } },
      { user: { phone: { contains: term } } },
    ],
  };
}

/**
 * One bank-verification tab as a Prisma filter. The same predicates
 * WithdrawalsService.findAllAdmin applies (the two open-payout tabs are
 * spelled as literal SQL there, for the partial index; this is their
 * Prisma form, used by the stats counts and by a searched open tab).
 */
export function withdrawalVerificationWhere(
  verification: VerificationFilter,
  now: Date,
): Prisma.WithdrawalWhereInput {
  switch (verification) {
    case 'verified':
      return { matchStatus: BankMatchStatus.MATCHED };
    case 'needs_review':
      return {
        matchStatus: {
          in: [BankMatchStatus.PENDING_REVIEW, BankMatchStatus.SUSPICIOUS],
        },
      };
    case 'awaiting_bank':
    case 'no_bank_transaction': {
      const cutoff = new Date(now.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS);
      return {
        status: WithdrawalStatus.APPROVED,
        bankCheckedAt: null,
        transferTransactionCode: null,
        approvedAt:
          verification === 'awaiting_bank' ? { gte: cutoff } : { lt: cutoff },
      };
    }
    default:
      return {};
  }
}
