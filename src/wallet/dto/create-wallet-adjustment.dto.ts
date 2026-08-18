import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { WalletAdjustmentDirection } from '../../generated/prisma/client';

export class CreateWalletAdjustmentDto {
  @IsEnum(WalletAdjustmentDirection)
  direction!: WalletAdjustmentDirection;

  /**
   * Always a positive magnitude — `direction` carries the sign. Capped at 2
   * decimal places to match every Decimal(12,2) money column: a sub-cent
   * amount would round differently at each write and leave an audit row
   * where balanceBefore + amount ≠ balanceAfter.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  /**
   * Internal audit note — stored on the adjustment row and shown to admins
   * only, never included in the user-facing notification message.
   */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  /**
   * Client-generated per dialog-open (not per click) — the unique constraint
   * on WalletAdjustment.idempotencyKey makes a double-submitted dialog replay
   * the first write instead of adjusting the balance twice.
   */
  @IsUUID('4')
  idempotencyKey!: string;
}
