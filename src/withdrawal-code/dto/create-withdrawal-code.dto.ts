import { CodeField } from './code-field.decorator';

/** POST /users/me/withdrawal-code — the first code (only when none exists). */
export class CreateWithdrawalCodeDto {
  @CodeField()
  code!: string;

  /** The "Enter it again" entry; when sent it must equal `code`. */
  @CodeField({ optional: true })
  confirm?: string;
}
