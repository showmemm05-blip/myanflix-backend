import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BACKFILL_MAX_LIMIT } from '../../videos/video-duration.service';

/** Body of POST /movies/durations/backfill — how many unknown-runtime titles to repair in this call. */
export class BackfillDurationsDto {
  // The 100 cap is the project pagination law; the admin simply clicks again
  // while the response reports `remaining > 0`.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BACKFILL_MAX_LIMIT)
  limit?: number;
}
