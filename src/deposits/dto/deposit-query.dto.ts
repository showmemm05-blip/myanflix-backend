import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { DepositStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  VERIFICATION_FILTERS,
  type VerificationFilter,
} from '../../common/dto/verification-filter';

export class DepositQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(DepositStatus)
  status?: DepositStatus;

  /** Admin-only filter — ignored on the self-service /deposits/me route. */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /** Admin-only bank-verification tab — ignored on /deposits/me. */
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
