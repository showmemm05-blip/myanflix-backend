import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_POLL_WAIT_SECONDS = 25;
export const MAX_POLL_WAIT_SECONDS = 30;

/** GET /sms-gateway/device/jobs?wait= — how long to hold an empty poll. */
export class PollJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_POLL_WAIT_SECONDS)
  wait?: number;
}
