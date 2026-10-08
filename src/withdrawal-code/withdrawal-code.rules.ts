/**
 * The withdrawal code's rules — pure functions, shared by the service and
 * the DTOs. The "too easy" list is the approved design's own check
 * (docs/withdrawal-code-2026-10-05/design, CreateCode/ChangeCode/ForgotCode),
 * repeated here because only the server's verdict counts.
 */

export const WITHDRAWAL_CODE_LENGTH = 6;
/** Wrong codes in a row that lock the code. */
export const WITHDRAWAL_CODE_MAX_TRIES = 5;
/** How long the 5th wrong code in a row locks it. */
export const WITHDRAWAL_CODE_LOCK_MS = 15 * 60 * 1000;

const SIX_DIGITS = /^\d{6}$/;

/** U+1040..U+1049, the Myanmar digits a Burmese keyboard types. */
const MYANMAR_ZERO = 0x1040;

/**
 * What a code field holds once the input noise is gone: whitespace removed
 * (a pasted "482 913" from the SMS keeps its space) and Myanmar digits
 * ၀-၉ turned into 0-9 (a website user on a Burmese keyboard). Anything
 * that is not a string is passed through for the validator to refuse.
 */
export function normalizeCodeInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\s+/g, '')
    .replace(/[၀-၉]/g, (digit) => String(digit.charCodeAt(0) - MYANMAR_ZERO));
}

/** Exactly 6 ASCII digits. */
export function isSixDigitCode(value: unknown): value is string {
  return typeof value === 'string' && SIX_DIGITS.test(value);
}

/**
 * True for the codes the design refuses as too easy to guess:
 *  - one digit six times (000000, 111111, …);
 *  - a straight run up or down, wrapping through 0 the way the design's
 *    check does (012345, 123456, 567890, 987654, 098765, 543210, …);
 *  - one pair three times (121212, 909090, …);
 *  - one three-digit group twice (123123, 507507, …).
 */
export function isTooEasyWithdrawalCode(code: string): boolean {
  // Only a 6-digit code is judged; anything else is a format error first.
  if (!isSixDigitCode(code)) return false;
  if (/^(\d)\1{5}$/.test(code)) return true;
  if ('01234567890'.includes(code) || '09876543210'.includes(code)) {
    return true;
  }
  if (/^(\d\d)\1\1$/.test(code) || /^(\d\d\d)\1$/.test(code)) return true;
  return false;
}
