import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AdvertisementPlacement } from '../../generated/prisma/client';
import { OptionalCalendarDate } from '../../lottery/dto/lottery-draw.dto';

/**
 * GET /ads/admin/analytics/* — an inclusive range of MMT calendar days.
 * Both absent = the last 7 full MMT days; one without the other, a date
 * that is not a calendar day, `from` after `to`, or a span over 366 days
 * → 400 (AdAnalyticsService.resolvePeriod). `adId` narrows the overview
 * and the by-date series to one ad; the per-ad table ignores it.
 * `placement` narrows all three to before the movie / breaks / corner.
 */
export class AdAnalyticsQueryDto {
  @OptionalCalendarDate()
  from?: string;

  @OptionalCalendarDate()
  to?: string;

  @IsOptional()
  @IsUUID('all')
  adId?: string;

  @IsOptional()
  @IsEnum(AdvertisementPlacement)
  placement?: AdvertisementPlacement;
}
