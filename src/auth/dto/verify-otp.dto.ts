import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizePhone } from '../../common/utils/phone.util';

export class VerifyOtpDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePhone(value) : value,
  )
  @IsString()
  @Matches(/^\+95\d{7,10}$/, { message: 'Enter a valid Myanmar phone number' })
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  /** Required only when this phone has no account yet — the password chosen at signup. Ignored for an existing account (already checked in the password step). */
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  /**
   * H-6: required when this phone already has an account — the `stepToken`
   * POST /auth/phone/verify-password returned. Proves the password step
   * passed; without it the code alone never opens the account.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  stepToken?: string;
}
