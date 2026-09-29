import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MovieStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** Filters for the admin's cross-series episode listing (Series > Ready to Publish). */
export class EpisodeQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  seasonNumber?: number;

  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  /** Episode title or show title, over the whole queue (H-24). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
