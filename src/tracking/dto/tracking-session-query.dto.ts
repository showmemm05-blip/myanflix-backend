import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrackingPagedRangeDto } from './tracking-range.dto';

/**
 * The Phone/IP view's filters.
 *
 * `phone` and `ip` are separate from `search` deliberately: an operator
 * chasing "who else is on this address" wants an exact-ish IP filter that a
 * free-text box would also match against usernames.
 *
 * Filtering by `phone` or `ip` DOES require `TRACKING.PII_VIEW` — the
 * service answers 403 otherwise. The masked response (`09*****369`,
 * `203.0.113.***`) hides only a few characters, and a filter on the real
 * column — substring or exact — is a yes/no oracle that recovers them by
 * guessing: a few hundred requests for an IP's last octet, a few thousand
 * for a phone's hidden digits. The free-text `search` never matches on the
 * phone column for such a caller either (security audit 2026-10-06, M-4).
 */
export class TrackingSessionQueryDto extends TrackingPagedRangeDto {
  /** Username, display name — and phone, for a caller holding TRACKING.PII_VIEW. */
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
