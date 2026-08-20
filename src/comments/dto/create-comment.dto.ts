import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Exactly one of `movieId` / `seriesId` must be present — the DTO can only
 * check each field's own shape, so that either/or rule is enforced in
 * CommentsService.create (which is also where the "reply must belong to the
 * same title" check lives).
 */
export class CreateCommentDto {
  @IsOptional()
  @IsUUID('4')
  movieId?: string;

  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  /** The comment being replied to. Replies are one level deep — see the service. */
  @IsOptional()
  @IsUUID('4')
  parentId?: string;

  /**
   * Trimmed before validation, so a body of nothing but whitespace fails the
   * 1-character minimum instead of being stored as an empty comment.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  body!: string;
}
