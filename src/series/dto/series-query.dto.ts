import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AccessType, SeriesStatus } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ToStringArray } from '../../common/decorators/to-string-array.decorator';

/**
 * The series subset of the canonical MovieSort vocabulary — no rating /
 * mostViewed / mostPurchased in v1: Series has no rating column and no
 * per-series watch aggregate (an episode roll-up would be needed), so the
 * UI simply doesn't offer them on the series tab.
 */
export enum SeriesSort {
  RELEVANCE = 'relevance',
  RECENTLY_ADDED = 'recentlyAdded',
  NEWEST = 'newest',
  OLDEST = 'oldest',
  TITLE = 'title',
}

/**
 * Same wire format as MovieQueryDto: multi-value facets are OR within the
 * facet, AND across facets; arrays travel as CSV (repeated/bracketed
 * accepted too — see ToStringArray).
 */
export class SeriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /** Staff-only filter — ignored for regular users, whose listing is always forced to PUBLISHED. */
  @IsOptional()
  @IsEnum(SeriesStatus)
  status?: SeriesStatus;

  @IsOptional()
  @IsString()
  search?: string;

  /** OR within the facet — values come from GET /series/facets. */
  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  genres?: string[];

  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  languages?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2100)
  yearFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2100)
  yearTo?: number;

  /** Default (applied in the service): recentlyAdded. */
  @IsOptional()
  @IsEnum(SeriesSort)
  sort?: SeriesSort;
}
