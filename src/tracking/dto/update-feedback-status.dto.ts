import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { FeedbackStatus } from '../../generated/prisma/client';

/** Hard bound on the internal triage note. */
export const FEEDBACK_ADMIN_NOTE_MAX = 2000;

/**
 * Triage of one feedback row. `status` is required — this endpoint exists to
 * move a row through the queue, and a note-only edit would leave the queue
 * position ambiguous. Omitting `adminNote` leaves any existing note alone;
 * sending an empty string clears it.
 */
export class UpdateFeedbackStatusDto {
  @IsEnum(FeedbackStatus)
  status!: FeedbackStatus;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(FEEDBACK_ADMIN_NOTE_MAX)
  adminNote?: string;
}
