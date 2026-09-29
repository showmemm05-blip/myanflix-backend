import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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

  /**
   * Admin-only search (H-24) — reference, payer name, and the user's
   * username / display name / phone. Ignored on /deposits/me.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
