import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrackingPagedRangeDto } from './tracking-range.dto';

/**
 * Filters for both search reports — the grouped top-terms table and the raw
 * recent-searches log.
 *
 * `search` here means "find terms containing this", i.e. it filters the
 * SEARCHED TEXT. It is normalised the same way the stored terms are before
 * being matched, so looking for "Avengers " finds the rows filed under
 * "avengers".
 */
export class TrackingSearchQueryDto extends TrackingPagedRangeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
