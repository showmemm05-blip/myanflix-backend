import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';

/** A Thai lottery number: exactly six digits, leading zeros included. */
export const LOTTERY_NUMBER_DIGITS = 6;
export const LOTTERY_NUMBER_PATTERN = /^\d{6}$/;

export function isLotteryNumber(value: unknown): value is string {
  return typeof value === 'string' && LOTTERY_NUMBER_PATTERN.test(value);
}

/** Trims every string of a list; anything else is left for the validators. */
const trimEach = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

/**
 * A body field holding a list of lottery numbers: 1..`max` six-digit
 * strings, each one only once. Shared by the availability check, the
 * off-sale list and (engineer B) the purchase lines' numbers.
 */
export function LotteryNumberList(max: number) {
  return applyDecorators(
    Transform(trimEach),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(max),
    ArrayUnique(),
    IsString({ each: true }),
    Matches(LOTTERY_NUMBER_PATTERN, {
      each: true,
      message: `each number must be exactly ${LOTTERY_NUMBER_DIGITS} digits`,
    }),
  );
}
