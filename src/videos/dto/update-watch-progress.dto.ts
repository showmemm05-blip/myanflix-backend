import { Type } from 'class-transformer';
import { IsInt, IsNumber, Max, Min } from 'class-validator';

export class UpdateWatchProgressDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  progress!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  lastPosition!: number;
}
