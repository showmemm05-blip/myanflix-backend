import { HttpException } from '@nestjs/common';

/** Extra top-level fields a coded error may carry next to `message`/`code`. */
export type CodedErrorExtra = Record<string, string | number | boolean | null>;

/**
 * An HttpException with a stable, machine-readable `code` for clients to
 * branch on — the `message` is for people and may be reworded, the code
 * never is. AllExceptionsFilter puts both into the error envelope, plus any
 * `extra` fields at the top level:
 *
 *   { success: false, message, code, ...extra }
 *
 * e.g. `{ success: false, message: 'Wrong code. 4 tries left.',
 * code: 'WITHDRAWAL_CODE_WRONG', triesLeft: 4 }`. `extra` can never
 * override `success`, `message` or `code`. Plain HttpExceptions keep the
 * old `{ success: false, message }` envelope unchanged.
 */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly extra: CodedErrorExtra = {},
  ) {
    super({ ...extra, message, code }, status);
  }
}
