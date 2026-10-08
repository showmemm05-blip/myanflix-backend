import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { normalizeCodeInput } from '../withdrawal-code.rules';

/**
 * A 6-digit code field (withdrawal code or SMS code). Only the input noise
 * is handled here — spaces stripped, Myanmar digits turned into 0-9 — and
 * the value must be a short string. Whether it is exactly 6 digits, too
 * easy, or right is the service's call, so every such refusal carries a
 * stable error code (see withdrawal-code.errors.ts) instead of a validator
 * message, and a malformed code never uses up a try.
 */
export function CodeField(options: { optional?: boolean } = {}) {
  return applyDecorators(
    ...(options.optional ? [IsOptional()] : []),
    Transform(({ value }: { value: unknown }) => normalizeCodeInput(value)),
    IsString(),
    MaxLength(32),
  );
}
