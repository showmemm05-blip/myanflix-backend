import { IntersectionType } from '@nestjs/mapped-types';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { ClientPlatform } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * The filter triple every Tracking report shares: a date window and a
 * client platform.
 *
 * Kept separate from the pagination half so the one un-paginated report
 * (watch-time, which always returns the full 24x7 grid) can extend the range
 * alone — with `forbidNonWhitelisted` on the global pipe, a `page` it never
 * reads would otherwise have to be silently accepted or explicitly rejected.
 */
export class TrackingRangeDto {
  /** Inclusive lower bound, ISO date or date-time. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /**
   * Inclusive upper bound. A date-only value (what the admin's native date
   * input sends) covers the WHOLE of that day — see `trackingDateRange`.
   */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsEnum(ClientPlatform)
  platform?: ClientPlatform;
}

/** Date window + platform + the house `page`/`limit` pair. */
export class TrackingPagedRangeDto extends IntersectionType(
  PaginationQueryDto,
  TrackingRangeDto,
) {}
