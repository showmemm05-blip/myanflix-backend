import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDepositDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  paymentMethod!: string;

  /** The PaymentAccount.accountName the client's account picker selected — optional so older clients that haven't been updated still work. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountName?: string;

  /**
   * Deliberately @IsString() with no @Type(() => Number) — the reference
   * must round-trip values like "000123" with the leading zeros intact.
   * Verified empirically: with the global ValidationPipe's
   * enableImplicitConversion, a raw JSON number here still gets coerced to
   * a string before validation (e.g. 123456 -> "123456"), so this alone
   * doesn't reject a numeric payload. What actually catches the real bug is
   * that leading zeros are already gone by the time a client sends a
   * *number* — "000123" sent as a JS number arrives here as 123 -> "123",
   * which fails the 6-digit @Matches check below. The frontend is what
   * must never let this field be a number input in the first place (a
   * number input strips leading zeros locally before the request is even
   * built); this validator's job is just to enforce "exactly 6 digits" on
   * whatever string actually arrives.
   */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'reference must be exactly 6 digits' })
  reference!: string;
}
