import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  DRAW_TICKETS_PAGE_SIZE_MAX,
} from './lottery-draw.dto';
import { trimmedOrNull } from './lottery-dream.dto';
import { LOTTERY_SETTINGS_LIMITS } from './lottery-settings.dto';

/** How many winning tickets the public list may show (Home's carousel asks for 20). */
export const PUBLIC_WINNERS_LIMIT_DEFAULT = 20;
export const PUBLIC_WINNERS_LIMIT_MAX = 50;

const SEARCH_MAX = 100;

/**
 * Ks per Baht for one publish: positive, at most 4 decimals, within the
 * Decimal(12,4) column — the same rule as the settings' exchangeRate.
 * Absent = the settings' rate.
 */
function OptionalExchangeRate() {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsNumber({ maxDecimalPlaces: 4 }),
    IsPositive(),
    Max(LOTTERY_SETTINGS_LIMITS.exchangeRateMax),
  );
}

/** POST /lottery/admin/draws/:id/publish { exchangeRate? } */
export class PublishDrawDto {
  @OptionalExchangeRate()
  exchangeRate?: number;
}

/** GET /lottery/admin/draws/:id/publish-preview?exchangeRate= — a what-if rate; absent = the draw's, else the settings'. */
export class PublishPreviewQueryDto {
  @OptionalExchangeRate()
  exchangeRate?: number;
}

/** GET /lottery/admin/draws/:id/winners?q&page&pageSize — a ticket number, a number prefix or a customer. */
export class AdminWinnersQueryDto {
  @Transform(({ value }: { value: unknown }) => trimmedOrNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  q?: string | null;

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

/** GET /lottery/draws/:drawNo/winners?limit= — up to 50 winning tickets, by number only. */
export class PublicWinnersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_WINNERS_LIMIT_MAX)
  limit?: number = PUBLIC_WINNERS_LIMIT_DEFAULT;
}
