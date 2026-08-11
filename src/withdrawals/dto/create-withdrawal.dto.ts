import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
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
}
