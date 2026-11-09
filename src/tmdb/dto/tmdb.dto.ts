import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import { ToStringArray } from '../../common/decorators/to-string-array.decorator';
import {
  TMDB_MOVIE_FIELDS,
  TMDB_SERIES_FIELDS,
  type TmdbField,
} from '../tmdb.types';

/** The most movies one GET /tmdb/movies/state asks about — a page of Ready to publish. */
export const TMDB_STATE_IDS_MAX = 50;

/** GET /tmdb/status. */
export class TmdbStatusQueryDto {
  /** `?fresh=1` ("Check again") asks TMDB now instead of reusing the last minute's answer. */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  fresh?: boolean;
}

/** GET /tmdb/search/movie and /tmdb/search/tv. */
export class TmdbSearchQueryDto {
  /** The name to look for, 1 to 200 characters once the outer blanks are gone. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  query!: string;

  /** Narrows the search to one year. Left out = any year. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2100)
  year?: number;
}

/** GET /tmdb/movies/state — `?ids=` 1 to 50 movie ids, comma separated. */
export class TmdbMovieStatesQueryDto {
  @ToStringArray()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TMDB_STATE_IDS_MAX)
  @IsUUID('4', { each: true })
  ids!: string[];
}

/** The TMDB entry a preview is asked for, or a series is created from. */
export class TmdbEntryDto {
  /**
   * TMDB's own id of the film or the show — never a picture address or any
   * other text. Capped at what the tmdbId columns (32-bit) can hold, so a
   * larger number is refused here instead of failing in the database.
   */
  @IsInt()
  @Min(1)
  @Max(2147483647)
  tmdbId!: number;
}

/** POST /tmdb/movies/:id/apply — the entry and exactly the details staff left switched on. */
export class ApplyMovieTmdbDto extends TmdbEntryDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(TMDB_MOVIE_FIELDS, { each: true })
  fields!: TmdbField[];
}

/** POST /tmdb/series/:id/apply — a series has no runtime, director or age rating to name. */
export class ApplySeriesTmdbDto extends TmdbEntryDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(TMDB_SERIES_FIELDS, { each: true })
  fields!: TmdbField[];
}
