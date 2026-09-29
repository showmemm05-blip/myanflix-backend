import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * The state tabs of the admin "Bank transactions" page. `unmatched` is the
 * WAITING band (UNMATCHED, younger than 48 h by bank time) and `unclaimed`
 * the rest of it — the computed-never-swept rule as a WHERE clause, like
 * the deposits page's no_bank_transaction tab.
 */
export const BANK_TRANSACTION_STATE_FILTERS = [
  'all',
  'unmatched',
  'matched',
  'ambiguous',
  'unclaimed',
] as const;
export type BankTransactionStateFilter =
  (typeof BANK_TRANSACTION_STATE_FILTERS)[number];

export const BANK_TRANSACTION_DIRECTIONS = ['RECEIVED', 'SENT'] as const;
export type BankTransactionDirectionFilter =
  (typeof BANK_TRANSACTION_DIRECTIONS)[number];

/** GET /bank-transactions — every filter lands on an index (see BankTransactionsService.findAll). */
export class BankTransactionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  deviceSerial?: string;

  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string;

  @IsOptional()
  @IsIn(BANK_TRANSACTION_DIRECTIONS)
  direction?: BankTransactionDirectionFilter;

  @IsOptional()
  @IsIn(BANK_TRANSACTION_STATE_FILTERS)
  state?: BankTransactionStateFilter;

  /** Range on occurredAt (the bank's time). The admin page always sends one (default: today). */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
