import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateWithdrawalDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
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
}
