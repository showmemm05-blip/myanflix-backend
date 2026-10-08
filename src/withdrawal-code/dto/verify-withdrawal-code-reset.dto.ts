import { CodeField } from './code-field.decorator';

/**
 * POST /users/me/withdrawal-code/reset/verify — the SMS code from
 * reset/request. Right: a `resetToken` for reset/confirm.
 */
export class VerifyWithdrawalCodeResetDto {
  /** The SMS shows it as "482 913"; the space is stripped. */
  @CodeField()
  otpCode!: string;
}
