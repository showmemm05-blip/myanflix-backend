import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { LOTTERY_NUMBER_PATTERN } from '../lottery-numbers';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  DRAW_TICKETS_PAGE_SIZE_MAX,
  DrawPageQueryDto,
} from './lottery-draw.dto';
import { LOTTERY_SETTINGS_LIMITS } from './lottery-settings.dto';

/** The purchase status as the apps read it. */
export const PURCHASE_STATUS_WIRE = ['paid'] as const;

export type PurchaseStatusWire = (typeof PURCHASE_STATUS_WIRE)[number];

/** How many different numbers one checkout may hold (a basket's worth). */
export const PURCHASE_MAX_LINES = 50;

/** One number of a checkout and how many tickets of it. */
export class PurchaseLineDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(LOTTERY_NUMBER_PATTERN, {
    message: 'number must be exactly 6 digits',
  })
  number!: string;

  /** Capped at the largest per-number limit a draw can have; the draw's own limit is checked by the service. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LOTTERY_SETTINGS_LIMITS.maxPerNumberMax)
  quantity!: number;
}

/**
 * POST /lottery/purchases. The idempotency key is a uuid the app makes
 * once per checkout and resends on a retry; the same key never charges
 * twice. Numbers must differ between lines (one line per number).
 */
export class CreateLotteryPurchaseDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  drawNo!: number;

  @IsUUID()
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PURCHASE_MAX_LINES)
  @ArrayUnique((line: PurchaseLineDto) => line?.number, {
    message: 'each number may appear only once',
  })
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];
}

/** GET /lottery/purchases?page&pageSize — the same paging as the draw lists. */
export class PurchasePageQueryDto extends DrawPageQueryDto {}

/** GET /lottery/tickets?drawNo&page&pageSize — one draw or all, up to 200 a page. */
export class TicketPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  drawNo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DRAW_TICKETS_PAGE_SIZE_MAX)
  pageSize?: number = DRAW_PAGE_SIZE_DEFAULT;
}
