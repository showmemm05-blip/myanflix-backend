import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { WithdrawalStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  VERIFICATION_FILTERS,
  type VerificationFilter,
} from '../../common/dto/verification-filter';

export class WithdrawalQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;

  /** Admin-only filter — ignored on the self-service /withdrawals/me route. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /** Admin-only bank-verification tab — ignored on /withdrawals/me. */
  @IsOptional()
  @IsIn(VERIFICATION_FILTERS)
  verification?: VerificationFilter;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
