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

  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType = AccessType.SUBSCRIPTION;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}
