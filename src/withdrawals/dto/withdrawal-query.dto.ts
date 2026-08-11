import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { WithdrawalStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class WithdrawalQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;

  /** Admin-only filter — ignored on the self-service /withdrawals/me route. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;
}
