import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { normalizePhone } from '../../common/utils/phone.util';

export class VerifyOtpDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizePhone(value) : value))
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
}
