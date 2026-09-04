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
 * No class-property initializers here on purpose. The global ValidationPipe
 * runs with `transform: true` and `UpdatePlanDto = PartialType(CreatePlanDto)`
 * inherits initializers, so a default like `isActive = true` or
 * `durationDays = 30` would be injected into every PUT body that omits the
 * field — silently re-enabling a disabled plan or resetting its duration on
 * an unrelated edit. Create-time defaults live in the schema (`@default`) and
 * in SubscriptionsService.createPlan instead.
 */
export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @Type(() => Number)
  @Min(0)
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
  @IsBoolean()
  isActive?: boolean;
}
