import { Transform } from 'class-transformer';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { FeedbackCategory } from '../../generated/prisma/client';

export class CreateFeedbackDto {
  @IsEnum(FeedbackCategory)
  category!: FeedbackCategory;

  /**
   * Trimmed before validation so whitespace can never pad a message up to
   * the 5-character minimum.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  message!: string;
}
