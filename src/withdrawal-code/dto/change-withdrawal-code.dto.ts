import { CodeField } from './code-field.decorator';

/** PUT /users/me/withdrawal-code — current code, then the new one. */
export class ChangeWithdrawalCodeDto {
  @CodeField()
  currentCode!: string;

  @CodeField()
  newCode!: string;

  /** The "Enter it again" entry; when sent it must equal `newCode`. */
  @CodeField({ optional: true })
  confirm?: string;
}
