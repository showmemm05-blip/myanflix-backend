import {
  IsBoolean,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Written out rather than `PartialType(CreatePlanDto)` on purpose: PartialType
 * stamps `@IsOptional()` onto every field, and IsOptional also waves `null`
 * through — which Prisma then rejects on a non-nullable column as a 500.
 * `ValidateIf(value !== undefined)` makes only an ABSENT field optional; an
 * explicit null is validated and refused as a 400 like any other bad value.
 * Keep the field list in step with CreatePlanDto.
 */
export class UpdatePlanDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @Min(0)
  price?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
