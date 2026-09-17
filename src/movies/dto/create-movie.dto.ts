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
import { AccessType, AgeRating } from '../../generated/prisma/client';

export class CreateMovieDto {
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

  @IsOptional()
  @IsUrl({ require_tld: false })
  thumbnailUrl?: string;

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

  @Type(() => Number)
  @IsInt()
  @Min(1)
  duration!: number;

  /**
   * Create-time default is Prisma `@default(SUBSCRIPTION)` (prisma/schema.prisma
   * Movie.accessType). No class initializer on purpose: UpdateMovieDto =
   * PartialType(CreateMovieDto) inherits initializers (@nestjs/mapped-types
   * type-helpers.utils inheritPropertyInitializers) and the global transform
   * pipe (src/app.module.ts) would inject the value into every PUT that omits
   * the field — see the precedent in src/subscriptions/dto/create-plan.dto.ts.
   */
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /**
   * Optional filter metadata (2026-09). The service maps an empty string to
   * null on create/update so the admin can clear a value by blanking the
   * field; UpdateMovieDto inherits all three via PartialType.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  director?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  country?: string;

  /** Null clears it back to "Unrated" — @IsOptional lets null through untouched. */
  @IsOptional()
  @IsEnum(AgeRating)
  ageRating?: AgeRating | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  /** The cast — Actor ids, managed under /actors. Same shape as categoryIds. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  actorIds?: string[];
}
