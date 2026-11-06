import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { normalizeCodeInput } from '../../withdrawal-code/withdrawal-code.rules';

export class CreateWithdrawalDto {
  /** @Max is the Decimal(12,2) column ceiling — past it Postgres overflows (DB-007). */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9_999_999_999.99)
  amount!: number;

  /** e.g. "KBZPay", "Bank Account" — free string, not validated against a fixed catalog (see Withdrawal.accountType doc in schema.prisma). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  accountType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  accountName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  accountNumber!: string;

  /**
   * Only meaningful for bank-transfer account types, so optional rather than
   * required — a KBZPay withdrawal has no bank to name. Stored verbatim as
   * part of this request's snapshot; never defaulted from the user's profile.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankName?: string;

  /**
   * The account's 6-digit withdrawal code — required on every request
   * (2026-10-05). Optional at the validator only so that a missing or
   * malformed code gets a coded answer from WithdrawalCodeService
   * (WITHDRAWAL_CODE_NOT_SET 409 when the account has none yet, else
   * WITHDRAWAL_CODE_REQUIRED / _INVALID_FORMAT 400) instead of a bare
   * validator message. Never stored, logged or echoed.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeCodeInput(value))
  @IsString()
  @MaxLength(32)
  withdrawalCode?: string;
}
