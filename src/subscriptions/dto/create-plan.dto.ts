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
 * No class-property initializers here on purpose. The global ValidationPipe
 * runs with `transform: true` and a `PartialType(CreatePlanDto)` would inherit
 * initializers (UpdatePlanDto is written out by hand for that reason, but the
 * trap stays disarmed here too), so a default like `isActive = true` or
 * `durationDays = 30` would be injected into every PUT body that omits the
 * field — silently re-enabling a disabled plan or resetting its duration on
 * an unrelated edit. Create-time defaults live in the schema (`@default`) and
 * in SubscriptionsService.createPlan instead.
 */
export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  name!: string;

  /**
   * A real number with at most two decimals, like every other money field
   * (DB-007): without @IsNumber a "1e400" coerced to Infinity passed @Min(0)
   * and failed only at the database. 0 stays allowed (a free plan); @Max is
   * the Decimal(12,2) column ceiling.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  price!: number;

  /**
   * Days one purchase unlocks; defaults to 30 in the service when omitted.
   * ValidateIf rather than IsOptional: IsOptional also waves `null` through,
   * which Prisma then rejects on a non-nullable Int as a 500. Only an absent
   * field is optional — an explicit null is a 400 like any other bad value.
   */
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
