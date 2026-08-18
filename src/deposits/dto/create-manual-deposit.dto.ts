import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Admin-recorded deposit (POST /deposits/manual) — the money already landed
 * in one of OUR accounts, so the deposit is created directly in APPROVED
 * state and both the user's wallet and the destination account's ledger are
 * credited in one transaction (see DepositsService.createManual).
 *
 * Validators are deliberately copied from the existing DTOs so a manual
 * deposit can never store values a user-submitted-then-approved deposit
 * couldn't: amount/accountName/reference mirror CreateDepositDto, and the
 * transaction code/time mirror UpdateReceivingAccountDto.
 */
export class CreateManualDepositDto {
  /** The customer this deposit belongs to. */
  @IsUUID('4')
  userId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  paymentMethod!: string;

  /** The customer's own account name they sent FROM — same semantics as user-submitted deposits. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountName?: string;

  /**
   * Deliberately @IsString() with no @Type(() => Number) — the reference
   * must round-trip values like "000123" with the leading zeros intact
   * (see the full rationale on CreateDepositDto.reference, copied verbatim
   * here).
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'reference must be exactly 6 digits' })
  reference!: string;

  /**
   * The catalog PaymentAccount the money actually landed in — REQUIRED for
   * a manual deposit (the admin is recording a transfer they can see), and
   * hidden/inactive accounts are allowed. Stored via
   * PaymentAccountLedgerService.syncDepositLink, never as a direct write.
   */
  @IsUUID('4')
  destinationPaymentAccountId!: string;

  /**
   * Last 6 characters of the transaction code only — alphanumeric, not
   * digits-only, since providers commonly mix letters into these codes.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/, {
    message: 'Transaction code must be exactly 6 characters',
  })
  receivingTransactionCode?: string;

  /**
   * The time of day the transfer happened (no date) — admins can type
   * either `.` or `:` as the separator for faster entry (e.g. "06.56.28"),
   * normalized here to "HH:MM:SS" so the stored value always sorts
   * correctly as plain text.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\./g, ':') : value,
  )
  @Matches(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, {
    message:
      'Transaction time must be in HH:MM:SS (or HH.MM.SS) format, e.g. 06:56:28',
  })
  receivingTransactionTime?: string;
}
