import { Type } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';

/**
 * The two maximums must be at least 1 (L-34): the admin form sends 0 for a
 * cleared field, and a maximum of 0 would silently refuse every deposit or
 * withdrawal for everyone. Minimums may still be 0 ("no floor"); the
 * service rejects min > max, so min = max = 0 can no longer be saved.
 */
export class UpdateFinanceSettingsDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minDepositAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  maxDepositAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minWithdrawalAmount!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  maxWithdrawalAmount!: number;
}
