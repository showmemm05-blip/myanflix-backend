import { Transform, type TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

/**
 * Body of PATCH /users/me — the caller editing their OWN profile.
 *
 * Only `displayName` is here on purpose: `username` and `phone` are the login
 * identities (staff sign in with the username, end users with the phone), so
 * they are read-only on the profile screen and are not accepted here. The
 * global ValidationPipe runs with `forbidNonWhitelisted`, so sending either
 * one is a 400 rather than a silent no-op.
 */
export class UpdateProfileDto {
  /**
   * Trimmed before validation, so "   " is a 400 rather than a stored blank.
   * Omit the field to leave the name untouched; send an explicit `null` to
   * clear it back to unset (`@IsOptional` skips validation for null).
   */
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @IsString()
  @Length(1, 40, {
    message: 'Display name must be between 1 and 40 characters',
  })
  displayName?: string | null;
}
