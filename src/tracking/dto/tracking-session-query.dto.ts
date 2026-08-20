import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrackingPagedRangeDto } from './tracking-range.dto';

/**
 * The Phone/IP view's filters.
 *
 * `phone` and `ip` are separate from `search` deliberately: an operator
 * chasing "who else is on this address" wants an exact-ish IP filter that a
 * free-text box would also match against usernames.
 *
 * Filtering by phone or IP does NOT require `TRACKING.PII_VIEW` — the
 * permission governs whether the value is READ BACK in full, and a caller
 * who already knows the number they are looking for learns nothing new by
 * filtering on it.
 */
export class TrackingSessionQueryDto extends TrackingPagedRangeDto {
  /** Username, display name or phone. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;
}
