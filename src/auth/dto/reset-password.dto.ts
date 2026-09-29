import { Transform } from 'class-transformer';
import {
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizePhone } from '../../common/utils/phone.util';

/**
 * Body of POST /auth/password/reset (H-8, "forgot password"): the phone, the
 * code POST /auth/otp/request sent to it, and the new password — the same
 * length rules as signup.
 */
export class ResetPasswordDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePhone(value) : value,
  )
  @IsString()
  @Matches(/^\+95\d{7,10}$/, { message: 'Enter a valid Myanmar phone number' })
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  @MaxLength(72)
  newPassword!: string;
}
