import {
  IsBoolean,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @Type(() => Number)
  @Min(0)
  price!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;
}
