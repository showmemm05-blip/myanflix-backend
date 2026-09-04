import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LEVEL_BADGE_ICONS } from '../level-icons';

export class CreateLevelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  /** Qualifying lifetime subscription spend (Ks); Max mirrors DECIMAL(12,2). */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9999999999.99)
  threshold!: number;

  @IsIn(LEVEL_BADGE_ICONS)
  icon!: string;

  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color!: string;

  /** Omitted on create = append to the end of the ladder. */
  @IsOptional()
  @IsInt()
  @Min(1)
  order?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateLevelDto extends PartialType(CreateLevelDto) {}

export class ReorderLevelItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(1)
  order!: number;
}

/**
 * Object wrapper rather than a bare array so the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) applies cleanly to the body.
 */
export class ReorderLevelsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReorderLevelItemDto)
  items!: ReorderLevelItemDto[];
}
