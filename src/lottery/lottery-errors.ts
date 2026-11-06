import { HttpStatus } from '@nestjs/common';
import {
  CodedHttpException,
  type CodedErrorExtra,
} from '../common/errors/coded-http.exception';

/**
 * Error codes a client can branch on; the message is for people. The
 * draw / settings codes are thrown here (phase 2 A); the purchase codes
 * are declared here for engineer B's purchases service so the apps see
 * one list. LOTTERY_DREAM_NOT_FOUND stays in lottery-dreams.service.ts.
 * The RESULTS_* codes are phase 3: the first three are thrown by the
 * results service, the last two and PUBLISH_INCOMPLETE by the publish
 * service and the public results.
 */
export const LOTTERY_ERRORS = {
  DRAW_NOT_FOUND: 'LOTTERY_DRAW_NOT_FOUND',
  /** 409: the draw is not in a state that allows this (open / pause / close). */
  DRAW_STATE: 'LOTTERY_DRAW_STATE',
  /** 409: the field cannot change any more (tickets exist, or the draw is closed / published). */
  DRAW_LOCKED: 'LOTTERY_DRAW_LOCKED',
  /** 409: another draw already has this drawNo. */
  DRAW_NO_TAKEN: 'LOTTERY_DRAW_NO_TAKEN',
  /** 400: sales would close after the draw itself. */
  DRAW_TIME_INVALID: 'LOTTERY_DRAW_TIME_INVALID',
  SALES_CLOSED: 'LOTTERY_SALES_CLOSED',
  /** details.numbers: the numbers that are off sale. */
  NUMBER_OFF_SALE: 'LOTTERY_NUMBER_OFF_SALE',
  /** details: [{ number, held, left }] for every number over the limit. */
  LIMIT_EXCEEDED: 'LOTTERY_LIMIT_EXCEEDED',
  /** details: { total, balance }. */
  INSUFFICIENT_BALANCE: 'LOTTERY_INSUFFICIENT_BALANCE',
  BAD_NUMBER: 'LOTTERY_BAD_NUMBER',
  /** 409: the idempotency key was already used for a different draw or basket (a client bug, never a retry). */
  IDEMPOTENCY_MISMATCH: 'LOTTERY_IDEMPOTENCY_MISMATCH',
  PURCHASE_NOT_FOUND: 'LOTTERY_PURCHASE_NOT_FOUND',
  TICKET_NOT_FOUND: 'LOTTERY_TICKET_NOT_FOUND',
  /** 400: the entered sheet is not a full one; details.errors lists every problem. */
  RESULTS_INVALID: 'LOTTERY_RESULTS_INVALID',
  /** 409: "Fetch now" / "Test the source" with no results URL in the settings. */
  RESULTS_SOURCE_NOT_SET: 'LOTTERY_RESULTS_SOURCE_NOT_SET',
  /** 409: the sheet cannot change — the draw is published (results are locked). */
  RESULTS_LOCKED: 'LOTTERY_RESULTS_LOCKED',
  /** 409: publish (or its preview) asked while the sheet is not a full FETCHED one. */
  RESULTS_NOT_READY: 'LOTTERY_RESULTS_NOT_READY',
  /** 404: the public results of a draw that is not PUBLISHED. */
  RESULTS_NOT_PUBLISHED: 'LOTTERY_RESULTS_NOT_PUBLISHED',
  /**
   * 500: the draw is PUBLISHED but a chunk of tickets could not be settled;
   * details { paid, settled, remaining }. Publishing again resumes where
   * it stopped and never pays a ticket twice.
   */
  PUBLISH_INCOMPLETE: 'LOTTERY_PUBLISH_INCOMPLETE',
  /**
   * 400 (analytics): `from` after `to`, one of the two without the other,
   * or a date that is not a calendar day.
   */
  ANALYTICS_RANGE_INVALID: 'LOTTERY_ANALYTICS_RANGE_INVALID',
  /** 400 (analytics): the period spans more than 366 days; details { days, maxDays }. */
  ANALYTICS_RANGE_TOO_LONG: 'LOTTERY_ANALYTICS_RANGE_TOO_LONG',
  /**
   * Prize claims (2026-10-24). The customer's POST /lottery/claims refuses
   * with the first five; the admin confirm / reject / reopen with the last
   * three. The app refetches the draw's claim view on any 409.
   */
  /** 409: no UNCLAIMED prize of this draw belongs to the caller (nothing won, or already requested / expired). */
  CLAIM_NOTHING_TO_CLAIM: 'LOTTERY_CLAIM_NOTHING_TO_CLAIM',
  /** 409: the caller already has a REQUESTED or PAID claim for this draw; extra { status }. */
  CLAIM_ALREADY_REQUESTED: 'LOTTERY_CLAIM_ALREADY_REQUESTED',
  /** 409: the caller's claim for this draw was rejected — contact support (the admin can review it again). */
  CLAIM_REJECTED: 'LOTTERY_CLAIM_REJECTED',
  /** 409: the draw's claim deadline has passed; extra { claimDeadlineAt }. */
  CLAIM_EXPIRED: 'LOTTERY_CLAIM_EXPIRED',
  /** 409: confirm / reject / reopen on a claim that is not in the status the verb needs; extra { status }. */
  CLAIM_STATE: 'LOTTERY_CLAIM_STATE',
  /** 404: no claim with this id. */
  CLAIM_NOT_FOUND: 'LOTTERY_CLAIM_NOT_FOUND',
  /**
   * 409: the payouts under the claim no longer add up to the claim (a row
   * was changed by hand) — the confirm pays nothing and the staff member
   * checks; details { ticketsCount, payouts, ks, payoutsKs }.
   */
  CLAIM_TOTAL_MISMATCH: 'LOTTERY_CLAIM_TOTAL_MISMATCH',
} as const;

export type LotteryErrorCode =
  (typeof LOTTERY_ERRORS)[keyof typeof LOTTERY_ERRORS];

export const lotteryError = (
  status: HttpStatus,
  code: LotteryErrorCode,
  message: string,
  extra?: CodedErrorExtra,
) => new CodedHttpException(status, code, message, extra);

export const drawNotFound = () =>
  lotteryError(
    HttpStatus.NOT_FOUND,
    LOTTERY_ERRORS.DRAW_NOT_FOUND,
    'Draw not found',
  );
