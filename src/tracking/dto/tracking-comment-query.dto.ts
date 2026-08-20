import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CommentStatus } from '../../generated/prisma/client';
import { TrackingPagedRangeDto } from './tracking-range.dto';

export class TrackingCommentQueryDto extends TrackingPagedRangeDto {
  /**
   * Matched case-insensitively against the comment body AND the commenter's
   * username, display name and phone — an operator following up on a report
   * has one of those in hand and should not have to know which.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Omitted = both visible and hidden, so moderation is reviewable. */
  @IsOptional()
  @IsEnum(CommentStatus)
  status?: CommentStatus;
}
