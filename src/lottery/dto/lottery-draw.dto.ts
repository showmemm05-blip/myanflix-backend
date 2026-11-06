import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { LOTTERY_NUMBER_PATTERN, LotteryNumberList } from '../lottery-numbers';
import { isCalendarDate } from '../lottery-time';
import { LOTTERY_SETTINGS_LIMITS } from './lottery-settings.dto';
import {
  IsOwnUploadedImageUrl,
  LOTTERY_DREAM_LIMITS,
  trimmedOrNull,
} from './lottery-dream.dto';
import { OptionalOwnFrameUrl } from './lottery-frame.dto';

/** The draw status as the apps read it. */
export const DRAW_STATUS_WIRE = [
  'scheduled',
  'open',
  'paused',
  'closed',
  'published',
] as const;

export type DrawStatusWire = (typeof DRAW_STATUS_WIRE)[number];

/** The ticket status as the apps read it (NOT_WON is "notwon" on the wire). */
export const TICKET_STATUS_WIRE = ['waiting', 'won', 'notwon'] as const;

export type TicketStatusWire = (typeof TICKET_STATUS_WIRE)[number];

export const DRAW_PAGE_SIZE_DEFAULT = 20;
export const DRAW_PAGE_SIZE_MAX = 100;
/** The admin ticket list may page wider: a draw's tickets are scanned, not read one by one. */
export const DRAW_TICKETS_PAGE_SIZE_MAX = 200;
/** How many numbers one availability check may ask about (a number window's worth). */
export const AVAILABILITY_MAX_NUMBERS = 50;
/** How many numbers staff may take off sale for one draw. */
export const OFF_SALE_MAX_NUMBERS = 1000;

const SEARCH_MAX = 100;

/** A YYYY-MM-DD string naming a real day — the Thai draw date. */
function IsCalendarDate(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return isCalendarDate(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a calendar date written YYYY-MM-DD`;
        },
      },
    });
}

function OptionalTrimmed() {
  return Transform(({ value }: { value: unknown }) => trimmedOrNull(value));
}

/** An optional picture: absent = keep, null or '' = clear, else one of our own uploads. */
function OptionalOwnImageUrl() {
  return applyDecorators(
    OptionalTrimmed(),
    IsOptional(),
    IsString(),
    MaxLength(LOTTERY_DREAM_LIMITS.pictureUrl),
    IsOwnUploadedImageUrl(),
  );
}

/** An optional ISO-8601 instant; '' reads as absent. */
function OptionalInstant() {
  return applyDecorators(
    Transform(
      ({ value }: { value: unknown }) => trimmedOrNull(value) ?? undefined,
    ),
    IsOptional(),
    IsISO8601({ strict: true }),
  );
}

/** An optional YYYY-MM-DD calendar day; '' reads as absent. Shared with the analytics DTOs. */
export function OptionalCalendarDate() {
  return applyDecorators(
    Transform(
      ({ value }: { value: unknown }) => trimmedOrNull(value) ?? undefined,
    ),
    IsOptional(),
    IsCalendarDate(),
  );
}

/** The draw-level copies of the two settings a draw is created with. */
function OptionalTicketPrice() {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsNumber({ maxDecimalPlaces: 2 }),
    Min(1),
    Max(LOTTERY_SETTINGS_LIMITS.ticketPriceMax),
  );
}

function OptionalMaxPerNumber() {
  return applyDecorators(
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(1),
    Max(LOTTERY_SETTINGS_LIMITS.maxPerNumberMax),
  );
}

/**
 * `page` / `pageSize` for the draw lists. Defaults are deliberate on a GET
 * (nothing PartialTypes these classes).
 */
export class DrawPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DRAW_PAGE_SIZE_MAX)
  pageSize?: number = DRAW_PAGE_SIZE_DEFAULT;
}

/** POST /lottery/draws/:drawNo/availability { numbers } — up to 50 six-digit numbers. */
export class DrawAvailabilityDto {
  @LotteryNumberList(AVAILABILITY_MAX_NUMBERS)
  numbers!: string[];
}

/** GET /lottery/admin/draws?status= — one status or every draw. */
export class AdminDrawQueryDto extends DrawPageQueryDto {
  @IsOptional()
  @IsIn(DRAW_STATUS_WIRE)
  status?: DrawStatusWire;
}

/**
 * POST /lottery/admin/draws. The draw number defaults to the next one, the
 * sales close time to the setting's gap before the Thai draw; price and
 * per-number limit are never sent — they are copied from the settings. The
 * ticket frame is copied from the settings too unless the body names one
 * (`frameUrl`: a frame upload of ours, or null for the built-in frame).
 */
export class CreateLotteryDrawDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  drawNo?: number;

  @OptionalTrimmed()
  @IsCalendarDate()
  thaiDrawDate!: string;

  @OptionalInstant()
  salesCloseAt?: string;

  @OptionalOwnImageUrl()
  pictureUrl?: string | null;

  @OptionalOwnFrameUrl()
  frameUrl?: string | null;
}

/**
 * PATCH /lottery/admin/draws/:id — every field optional, absent = keep.
 * Which fields may still change depends on the draw (tickets sold, status);
 * the service decides and answers 409 LOTTERY_DRAW_LOCKED.
 */
export class UpdateLotteryDrawDto {
  @OptionalCalendarDate()
  thaiDrawDate?: string;

  @OptionalInstant()
  salesCloseAt?: string;

  @OptionalOwnImageUrl()
  pictureUrl?: string | null;

  @OptionalOwnFrameUrl()
  frameUrl?: string | null;

  @OptionalTicketPrice()
  ticketPrice?: number;

  @OptionalMaxPerNumber()
  maxPerNumber?: number;
}

/** PUT /lottery/admin/draws/:id/off-sale { numbers } — the whole list; [] puts everything back on sale. */
export class OffSaleNumbersDto {
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) =>
          typeof item === 'string' ? item.trim() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(OFF_SALE_MAX_NUMBERS)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(LOTTERY_NUMBER_PATTERN, {
    each: true,
    message: 'each number must be exactly 6 digits',
  })
  numbers!: string[];
}

/** GET /lottery/admin/draws/:id/tickets?q= — a ticket number, a number prefix, a purchase ref or a customer. */
export class AdminDrawTicketsQueryDto {
  @OptionalTrimmed()
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
