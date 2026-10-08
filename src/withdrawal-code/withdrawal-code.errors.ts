import { HttpStatus } from '@nestjs/common';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { WITHDRAWAL_CODE_MAX_TRIES } from './withdrawal-code.rules';

/**
 * Every refusal of the withdrawal-code feature, as a CodedHttpException: the
 * `code` is the stable contract the mobile app and the website branch on;
 * the English `message` is the approved design's wording (clients show their
 * own translation by code). None of them ever carries the code or its hash.
 *
 * Never 401: both clients treat 401 as "session expired" (refresh, retry,
 * then sign out), so a wrong code must not look like one.
 */
export const WITHDRAWAL_CODE_ERRORS = {
  /** 409 — the account has no code yet: open "Create code". */
  NOT_SET: 'WITHDRAWAL_CODE_NOT_SET',
  /** 409 — POST create when a code already exists: use Change instead. */
  ALREADY_SET: 'WITHDRAWAL_CODE_ALREADY_SET',
  /** 400 — POST /withdrawals without `withdrawalCode` (the account has one). */
  REQUIRED: 'WITHDRAWAL_CODE_REQUIRED',
  /** 400 — not exactly 6 digits. No try is used up. */
  INVALID_FORMAT: 'WITHDRAWAL_CODE_INVALID_FORMAT',
  /** 400 — the code is wrong; `triesLeft` (1-4) says how many remain. */
  WRONG: 'WITHDRAWAL_CODE_WRONG',
  /** 423 — 5 wrong in a row; `lockedUntil` (ISO) says when it opens again. */
  LOCKED: 'WITHDRAWAL_CODE_LOCKED',
  /** 400 — a new code on the too-easy list. */
  TOO_EASY: 'WITHDRAWAL_CODE_TOO_EASY',
  /** 400 — `confirm` differs from the new code. */
  MISMATCH: 'WITHDRAWAL_CODE_MISMATCH',
  /** 400 — PUT change with a new code equal to the current one. */
  SAME: 'WITHDRAWAL_CODE_SAME',
  /** 409 — "forgot code" on an account with no phone to text. */
  RESET_NO_PHONE: 'WITHDRAWAL_CODE_RESET_NO_PHONE',
  /** 400 — the SMS code is wrong, expired or already used. */
  RESET_SMS_INVALID: 'WITHDRAWAL_CODE_RESET_SMS_INVALID',
  /** 400 — 5 wrong tries on this SMS code: send a new one. */
  RESET_SMS_TOO_MANY: 'WITHDRAWAL_CODE_RESET_SMS_TOO_MANY',
  /** 400 — the reset step token is missing, expired or already used. */
  RESET_EXPIRED: 'WITHDRAWAL_CODE_RESET_EXPIRED',
  /**
   * 503 — the server cannot check this account's code right now: it was
   * saved under a WITHDRAWAL_CODE_PEPPER this server no longer has (a
   * server setup problem, never the user's fault). No try is used up.
   */
  UNAVAILABLE: 'WITHDRAWAL_CODE_UNAVAILABLE',
} as const;

export type WithdrawalCodeErrorCode =
  (typeof WITHDRAWAL_CODE_ERRORS)[keyof typeof WITHDRAWAL_CODE_ERRORS];

const E = WITHDRAWAL_CODE_ERRORS;

export const withdrawalCodeNotSet = () =>
  new CodedHttpException(
    HttpStatus.CONFLICT,
    E.NOT_SET,
    'Create a withdrawal code first.',
  );

export const withdrawalCodeAlreadySet = () =>
  new CodedHttpException(
    HttpStatus.CONFLICT,
    E.ALREADY_SET,
    'You already have a withdrawal code. Use Change code instead.',
  );

export const withdrawalCodeRequired = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.REQUIRED,
    'Enter your 6-digit withdrawal code.',
  );

export const withdrawalCodeInvalidFormat = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.INVALID_FORMAT,
    'The code must be 6 digits.',
  );

export const withdrawalCodeWrong = (triesLeft: number) =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.WRONG,
    `Wrong code. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`,
    { triesLeft, maxTries: WITHDRAWAL_CODE_MAX_TRIES },
  );

/**
 * "Too many tries. Try again in 15 minutes." — the minutes are what is left
 * of the lock, rounded up, so the 5th wrong code reads exactly as designed.
 */
export const withdrawalCodeLocked = (lockedUntil: Date, now = new Date()) => {
  const minutes = Math.max(
    1,
    Math.ceil((lockedUntil.getTime() - now.getTime()) / 60_000),
  );
  return new CodedHttpException(
    HttpStatus.LOCKED,
    E.LOCKED,
    `Too many tries. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    {
      lockedUntil: lockedUntil.toISOString(),
      triesLeft: 0,
      maxTries: WITHDRAWAL_CODE_MAX_TRIES,
    },
  );
};

export const withdrawalCodeTooEasy = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.TOO_EASY,
    'Too easy to guess. Try a different code.',
  );

export const withdrawalCodeMismatch = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.MISMATCH,
    "Codes don't match. Start over.",
  );

export const withdrawalCodeSame = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.SAME,
    'Use a code different from your old one.',
  );

export const withdrawalCodeResetNoPhone = () =>
  new CodedHttpException(
    HttpStatus.CONFLICT,
    E.RESET_NO_PHONE,
    'Your account has no phone number to send a code to. Please contact support.',
  );

export const withdrawalCodeResetSmsInvalid = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.RESET_SMS_INVALID,
    'Wrong or expired code. Try again.',
  );

export const withdrawalCodeResetSmsTooMany = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.RESET_SMS_TOO_MANY,
    'Too many wrong tries. Send a new code.',
  );

export const withdrawalCodeResetExpired = () =>
  new CodedHttpException(
    HttpStatus.BAD_REQUEST,
    E.RESET_EXPIRED,
    'This step has expired. Please start again.',
  );

export const withdrawalCodeUnavailable = () =>
  new CodedHttpException(
    HttpStatus.SERVICE_UNAVAILABLE,
    E.UNAVAILABLE,
    'Withdrawals are not available right now. Please try again later.',
  );
