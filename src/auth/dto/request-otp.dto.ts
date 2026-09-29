import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { normalizePhone } from '../../common/utils/phone.util';

/**
 * What the code is for (B1). `login` (the default, so a client that sends
 * only `{ phone }` keeps working) opens POST /auth/otp/verify;
 * `password_reset` opens POST /auth/password/reset. A code only ever works
 * for the purpose it was requested for.
 */
export const OTP_REQUEST_PURPOSES = ['login', 'password_reset'] as const;
export type OtpRequestPurpose = (typeof OTP_REQUEST_PURPOSES)[number];

export class RequestOtpDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizePhone(value) : value,
  )
  @IsString()
  @Matches(/^\+95\d{7,10}$/, { message: 'Enter a valid Myanmar phone number' })
  phone!: string;

  @IsOptional()
  @IsIn(OTP_REQUEST_PURPOSES, {
    message: `purpose must be one of: ${OTP_REQUEST_PURPOSES.join(', ')}`,
  })
  purpose?: OtpRequestPurpose;
}
