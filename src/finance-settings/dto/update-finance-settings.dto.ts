import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * The two maximums must be at least 1 (L-34): the admin form sends 0 for a
 * cleared field, and a maximum of 0 would silently refuse every deposit or
 * withdrawal for everyone. Minimums may still be 0 ("no floor"); the
 * service rejects min > max, so min = max = 0 can no longer be saved.
 *
 * Every limit is capped at the Decimal(12,2) column ceiling (DB-007): a
 * larger value used to reach Postgres, overflow there and come back as a
 * bare 500 instead of a 400.
 */
export class UpdateFinanceSettingsDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  minDepositAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(9_999_999_999.99)
  maxDepositAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  minWithdrawalAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(9_999_999_999.99)
  maxWithdrawalAmount!: number;
}
