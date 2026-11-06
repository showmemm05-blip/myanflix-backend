import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';

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

  /** Same rules as CreatePlanDto.price (DB-007). */
  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  price?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ValidateIf((_, value) => value !== undefined)
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}
