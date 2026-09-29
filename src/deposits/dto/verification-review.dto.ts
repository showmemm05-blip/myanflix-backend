import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const VERIFICATION_REVIEW_ACTIONS = [
  'clear',
  'confirm_suspicious',
  'unlink',
] as const;

export type VerificationReviewAction =
  (typeof VERIFICATION_REVIEW_ACTIONS)[number];

/**
 * A staff decision on a flagged deposit/withdrawal (PATCH …/:id/verification):
 *   clear              — reviewed, no issue: reasons emptied.
 *   confirm_suspicious — the admin agrees with the flags.
 *   unlink             — the bank values were attached to the wrong row;
 *                        wipe them (and the screenshot) so the row re-enters
 *                        the open set and the phone-monitor's Resend can
 *                        re-post the event.
 * Shared by deposits and withdrawals — same three verbs, same audit shape.
 */
export class VerificationReviewDto {
  @IsIn(VERIFICATION_REVIEW_ACTIONS)
  action!: VerificationReviewAction;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
