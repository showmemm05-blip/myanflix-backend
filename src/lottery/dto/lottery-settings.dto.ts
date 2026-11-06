import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
} from 'class-validator';
import { OptionalOwnFrameUrl } from './lottery-frame.dto';
import { OptionalResultsUrl } from './lottery-results.dto';

/**
 * Field limits, shared with the service and the specs. The money columns
 * are Decimal(12,2) / Decimal(12,4), whose ceilings a larger value would
 * overflow in Postgres and come back as a bare 500 (DB-007). The rate is
 * Ks per Baht (about 75 in 2026): 10,000 leaves room for any currency
 * swing, and anything past it is a typo, not a market. A prize that would
 * not fit a wallet at the rate given is refused by publish itself.
 */
export const LOTTERY_SETTINGS_LIMITS = {
  ticketPriceMax: 9_999_999_999.99,
  maxPerNumberMax: 100,
  exchangeRateMax: 10_000,
  /** A day: sales can close at most 24 hours before the Thai draw. */
  salesCloseMinutesMax: 1440,
  /** How long a prize may wait to be requested after publishing: a day up to two years. */
  claimDeadlineDaysMin: 1,
  claimDeadlineDaysMax: 730,
} as const;

/**
 * PATCH /lottery/admin/settings — every field optional, absent = keep.
 * A ticket price of 0 would sell tickets for nothing (the admin form sends
 * 0 for a cleared field, L-34), so the floor is 1 Ks; the exchange rate
 * must be positive for the same reason. `frameUrl` is the ticket frame new
 * draws are created with: absent = keep, null or '' = back to the built-in
 * frame, else one of our own images/lottery_frame/ uploads. `resultsUrl`
 * is where winning numbers are fetched from (phase 3): absent = keep,
 * null or '' = no fetching (results entered by hand), else an absolute
 * http/https URL, "{date}" in it standing for the draw date as YYYYMMDD.
 * `claimDeadlineDays` is how many days after publishing a prize may still
 * be requested (copied into the draw at publish; 1..730).
 * No class-property initializers (F-002).
 */
export class UpdateLotterySettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(LOTTERY_SETTINGS_LIMITS.ticketPriceMax)
  ticketPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LOTTERY_SETTINGS_LIMITS.maxPerNumberMax)
  maxPerNumber?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  @Max(LOTTERY_SETTINGS_LIMITS.exchangeRateMax)
  exchangeRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LOTTERY_SETTINGS_LIMITS.salesCloseMinutesMax)
  salesCloseMinutesBefore?: number;

  @OptionalOwnFrameUrl()
  frameUrl?: string | null;

  @OptionalResultsUrl()
  resultsUrl?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LOTTERY_SETTINGS_LIMITS.claimDeadlineDaysMin)
  @Max(LOTTERY_SETTINGS_LIMITS.claimDeadlineDaysMax)
  claimDeadlineDays?: number;
}
