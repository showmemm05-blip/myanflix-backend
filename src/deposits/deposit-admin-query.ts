import {
  BankMatchStatus,
  DepositStatus,
  type Prisma,
} from '../generated/prisma/client';
import { NO_BANK_TRANSACTION_AFTER_MS } from '../bank-events/risk-rules';
import type { VerificationFilter } from '../common/dto/verification-filter';

/**
 * The admin search box (H-24), matched over the whole table: the 6-digit
 * reference, the payer name the user typed, and the depositing account by
 * username, display name or phone — the same three UsersService.findAll
 * searches, so a user is findable here by whatever the admin has in hand.
 * Blank = no filter.
 */
export function depositSearchWhere(
  search: string | undefined,
): Prisma.DepositWhereInput | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  return {
    OR: [
      { reference: { contains: term } },
      { accountName: { contains: term, mode: 'insensitive' } },
      { user: { username: { contains: term, mode: 'insensitive' } } },
      { user: { displayName: { contains: term, mode: 'insensitive' } } },
      { user: { phone: { contains: term } } },
    ],
  };
}

/**
 * One bank-verification tab as a Prisma filter. The same predicates
 * DepositsService.findAllAdmin applies (the two open-set tabs are spelled
 * as literal SQL there, for the partial index; this is their Prisma form,
 * used by the stats counts and by a searched open tab).
 */
export function depositVerificationWhere(
  verification: VerificationFilter,
  now: Date,
): Prisma.DepositWhereInput {
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
      const cutoff = new Date(now.getTime() - NO_BANK_TRANSACTION_AFTER_MS);
      return {
        status: DepositStatus.PENDING,
        bankCheckedAt: null,
        createdAt:
          verification === 'awaiting_bank' ? { gte: cutoff } : { lt: cutoff },
      };
    }
    default:
      return {};
  }
}
