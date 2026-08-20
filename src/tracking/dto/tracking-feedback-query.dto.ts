import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  FeedbackCategory,
  FeedbackStatus,
} from '../../generated/prisma/client';
import { TrackingPagedRangeDto } from './tracking-range.dto';

export class TrackingFeedbackQueryDto extends TrackingPagedRangeDto {
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  @IsOptional()
  @IsEnum(FeedbackCategory)
  category?: FeedbackCategory;

  /** Message text, or the submitter's username / display name / phone. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
