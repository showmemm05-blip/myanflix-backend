import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AccessType,
  AgeRating,
  MovieStatus,
} from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ToStringArray } from '../../common/decorators/to-string-array.decorator';

/**
 * The canonical sort vocabulary — every option maps to an HONEST data
 * source (see MoviesService.findAll):
 *
 *  - relevance:     two-tier deterministic ranking (title matches before
 *                   description-only matches) over the real search predicate.
 *                   Only meaningful with a search term; without one the
 *                   service falls back to recentlyAdded.
 *  - recentlyAdded: createdAt desc — the historical default, now named.
 *  - newest/oldest: releaseYear.
 *  - rating:        the admin-set Movie.rating float.
 *  - title:         alphabetical.
 *  - mostViewed:    unique viewers per movie from watch_history (one row per
 *                   user+movie that actually started watching).
 *  - mostPurchased: the FROZEN pre-subscription purchases table — clients
 *                   label it "Most Purchased" with an era hint, never
 *                   "Most Popular".
 */
export enum MovieSort {
  RELEVANCE = 'relevance',
  RECENTLY_ADDED = 'recentlyAdded',
  NEWEST = 'newest',
  OLDEST = 'oldest',
  RATING = 'rating',
  TITLE = 'title',
  MOST_VIEWED = 'mostViewed',
  MOST_PURCHASED = 'mostPurchased',
}

/**
 * Catalog query. Multi-value facets (genres/languages/actorIds/directors/
 * countries/ageRatings) are OR within the facet and AND across facets:
 * `?genres=Action,Drama&languages=Burmese` means (Action OR Drama) AND
 * Burmese. Arrays travel as CSV canonically, but repeated/bracketed params
 * are accepted too (see ToStringArray).
 */
export class MovieQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MovieStatus)
  status?: MovieStatus;

  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;

  /** Staff-only filter: episodes of one series. Ignored for regular users, whose catalog never contains episodes at all. */
  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  /**
   * LEGACY single-genre param — the ?genre= deep-link contract predates
   * `genres` and must survive. The service merges it into `genres`.
   */
  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  /** OR within the facet — values come from GET /movies/facets. */
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

  /** OR within the facet: "any of the selected cast" — actors.some.id.in. */
  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  actorIds?: string[];

  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  directors?: string[];

  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  countries?: string[];

  @IsOptional()
  @ToStringArray()
  @IsArray()
  @ArrayMaxSize(5)
  @IsEnum(AgeRating, { each: true })
  ageRatings?: AgeRating[];

  /** releaseYear >= (a single year is yearFrom === yearTo). Swapped bounds are normalized, not rejected. */
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

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  ratingMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  ratingMax?: number;

  /** Minutes. The short/medium/long buckets are pure client presets over these two raw bounds. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6000)
  durationMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6000)
  durationMax?: number;

  /** Default (applied in the service, not here): recentlyAdded. */
  @IsOptional()
  @IsEnum(MovieSort)
  sort?: MovieSort;
}
