import { IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { PaymentAccountTransactionType } from '../../generated/prisma/client';

/**
 * Backs the manual Add/Remove Money dialog. `DEPOSIT_IN`/`WITHDRAWAL_OUT` are
 * deliberately excluded — those are system-generated only, by
 * PaymentAccountLedgerService.syncDepositLink/syncWithdrawalLink.
 */
const MANUAL_TYPES = [
  PaymentAccountTransactionType.OPENING_BALANCE,
  PaymentAccountTransactionType.MANUAL_CREDIT,
  PaymentAccountTransactionType.MANUAL_DEBIT,
  PaymentAccountTransactionType.ADJUSTMENT_CREDIT,
  PaymentAccountTransactionType.ADJUSTMENT_DEBIT,
] as const;

export class CreateManualPaymentAccountTransactionDto {
  @IsIn(MANUAL_TYPES)
  type!: (typeof MANUAL_TYPES)[number];

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  referenceCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
