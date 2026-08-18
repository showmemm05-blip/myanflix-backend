import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DepositStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class DepositQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(DepositStatus)
  status?: DepositStatus;

  /** Admin-only filter — ignored on the self-service /deposits/me route. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
