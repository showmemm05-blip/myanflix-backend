import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CodeField } from './code-field.decorator';

/**
 * POST /users/me/withdrawal-code/reset/confirm — the new code, proven by
 * EITHER the `resetToken` reset/verify returned (the designed flow: the SMS
 * code is checked before the new code is typed) OR the SMS code itself
 * (`otpCode`, one call). Exactly one of the two.
 */
export class ConfirmWithdrawalCodeResetDto {
  @CodeField()
  newCode!: string;

  /** The "Enter it again" entry; when sent it must equal `newCode`. */
  @CodeField({ optional: true })
  confirm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  resetToken?: string;

  @CodeField({ optional: true })
  otpCode?: string;
}
