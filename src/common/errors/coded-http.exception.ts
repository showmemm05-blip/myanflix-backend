import { HttpException } from '@nestjs/common';

/** Any JSON value — what an extra field may hold once serialised. */
export type CodedErrorValue =
  | string
  | number
  | boolean
  | null
  | CodedErrorValue[]
  | { [key: string]: CodedErrorValue };

/**
 * Extra top-level fields a coded error may carry next to `message`/`code`.
 * Scalars for the usual `triesLeft` / `lockedUntil`; a list or an object
 * where a client needs the particulars (the lottery's `details`: which
 * numbers are off sale, how many of each are left).
 */
export type CodedErrorExtra = Record<string, CodedErrorValue>;

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
