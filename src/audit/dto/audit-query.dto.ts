import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AuditCategory } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditTargetType,
} from '../audit-actions';

/**
 * Filters for GET /audit. `action` and `targetType` must come from the
 * catalogue — an unknown value is a 400, not an empty page, so a stale
 * admin build cannot silently filter everything out.
 */
export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsEnum(AuditCategory)
  category?: AuditCategory;

  @IsOptional()
  @IsString()
  @IsIn(AUDIT_ACTION_KEYS)
  action?: AuditAction;

  @IsOptional()
  @IsString()
  @IsIn(AUDIT_TARGET_TYPES)
  targetType?: AuditTargetType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** ILIKE on targetLabel, actorUsername and action. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
