import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNumber, IsOptional } from 'class-validator';
import { PaymentAccountTransactionType } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** Backs GET /payment-accounts/:id/transactions (per-account history). */
export class PaymentAccountTransactionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(PaymentAccountTransactionType)
  type?: PaymentAccountTransactionType;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amountMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amountMax?: number;
}
