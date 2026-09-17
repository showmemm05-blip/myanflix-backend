import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AccessType } from '../../generated/prisma/client';

export class CreateSeriesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  posterUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  coverUrl?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genre!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  language!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2100)
  releaseYear!: number;

  /**
   * One access type for the whole show — episodes are never gated individually.
   *
   * Create-time default is Prisma `@default(SUBSCRIPTION)` (prisma/schema.prisma
   * Series.accessType). No class initializer on purpose: UpdateSeriesDto =
   * PartialType(CreateSeriesDto) inherits initializers (@nestjs/mapped-types
   * type-helpers.utils inheritPropertyInitializers) and the global transform
   * pipe (src/app.module.ts) would inject the value into every PUT that omits
   * the field — see the precedent in src/subscriptions/dto/create-plan.dto.ts.
   */
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
