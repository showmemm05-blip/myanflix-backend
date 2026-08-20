import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class UpdateAdditionalPeakDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  additionalPeak!: number;
}
