import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * The account WE sent the money FROM — entirely separate from the user's own
 * withdrawal destination (accountType/accountName/accountNumber on the
 * Withdrawal model), which this never touches.
 */
export class UpdateTransferAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  transferAccountType!: string;

  /**
   * Copied from the picked PaymentAccount's `subname` (see admin
   * TransferAccountCell) — optional, since the admin can also type the
   * transfer account in manually without picking from the catalog.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  transferAccountSubname?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  transferAccountName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  transferAccountNumber!: string;

  /**
   * Last 6 characters of the transaction code only — alphanumeric, not
   * digits-only, since providers commonly mix letters into these codes.
   */
  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/, {
    message: 'Transaction code must be exactly 6 characters',
  })
  transferTransactionCode!: string;

  /**
   * The time of day the transfer happened (no date) — admins can type
   * either `.` or `:` as the separator for faster entry (e.g. "06.56.28"),
   * normalized here to "HH:MM:SS" so the stored value always sorts
   * correctly as plain text.
   */
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\./g, ':') : value))
  @Matches(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, {
    message: 'Transaction time must be in HH:MM:SS (or HH.MM.SS) format, e.g. 06:56:28',
  })
  transferTransactionTime!: string;

  /**
   * The catalog PaymentAccount this withdrawal's money actually went out of
   * — set when the admin picks one (rather than typing the transfer account
   * in free text), and explicitly sent as `null` when cleared/hand-typed so
   * a previous pick doesn't linger. Drives PaymentAccountLedgerService's
   * WITHDRAWAL_OUT ledger entry (see WithdrawalsService.updateTransferAccount).
   */
  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string | null;
}
