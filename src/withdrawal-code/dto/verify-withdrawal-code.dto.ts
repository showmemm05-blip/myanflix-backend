import { CodeField } from './code-field.decorator';

/**
 * POST /users/me/withdrawal-code/verify — "is this my current code?" (the
 * first step of Change code). Counts toward the 5-try lock like a
 * withdrawal does.
 */
export class VerifyWithdrawalCodeDto {
  @CodeField()
  code!: string;
}
