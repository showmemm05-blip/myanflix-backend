import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * The account WE received the money INTO — entirely separate from the
 * user's own deposit information (paymentMethod/accountName on the Deposit
 * model), which this never touches. Mirrors Withdrawal's
 * UpdateTransferAccountDto.
 *
 * PATCH semantics throughout: every field is optional. An omitted
 * (undefined) field leaves the stored value untouched; nullable fields
 * (subname, transaction code, paymentAccountId) can be cleared with an
 * explicit null. This is what lets the admin's ReceivingAccountCell link a
 * catalog account with a `{ paymentAccountId }`-only body while
 * UserDepositAccountCell manages the free-text record independently —
 * neither cell can clobber the other's fields.
 */
export class UpdateReceivingAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  receivingAccountType?: string;

  /**
   * Copied from the picked PaymentAccount's `subname` (see admin
   * ReceivingAccountCell) — optional, since the admin can also type the
   * receiving account in manually without picking from the catalog.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  receivingAccountSubname?: string | null;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  receivingAccountName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  receivingAccountNumber?: string;

  /**
   * Last 6 characters of the transaction code only — alphanumeric, not
   * digits-only, since providers commonly mix letters into these codes.
   * Optional: the admin-facing form no longer collects this.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/, {
    message: 'Transaction code must be exactly 6 characters',
  })
  receivingTransactionCode?: string | null;

  /**
   * The time of day the transfer happened (no date) — admins can type
   * either `.` or `:` as the separator for faster entry (e.g. "06.56.28"),
   * normalized here to "HH:MM:SS" so the stored value always sorts
   * correctly as plain text.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\./g, ':') : value))
  @Matches(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, {
    message: 'Transaction time must be in HH:MM:SS (or HH.MM.SS) format, e.g. 06:56:28',
  })
  receivingTransactionTime?: string;

  /**
   * The catalog PaymentAccount this deposit's money actually landed in — set
   * when the admin picks one (rather than typing the receiving account in
   * free text), and explicitly sent as `null` when cleared/hand-typed so a
   * previous pick doesn't linger. Drives PaymentAccountLedgerService's
   * DEPOSIT_IN ledger entry (see DepositsService.updateReceivingAccount).
   */
  @IsOptional()
  @IsUUID('4')
  paymentAccountId?: string | null;
}
