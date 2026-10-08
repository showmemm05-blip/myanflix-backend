import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PUBLIC_COMMENT_LIMIT } from '../comments.service';

/**
 * Which title's comments to list. Exactly one of the three is required —
 * enforced in the service, same either/or rule as CreateCommentDto.
 *
 * `page`/`limit` page the top-level comments. Both are optional and default
 * to the first page of PUBLIC_COMMENT_LIMIT, which is exactly what the
 * clients read today — they render a whole thread and send neither.
 * Replies ride along capped at REPLY_PREVIEW_LIMIT per comment; the rest
 * come from `GET /comments/:id/replies`.
 */
export class CommentQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_COMMENT_LIMIT)
  limit?: number;

  @IsOptional()
  @IsUUID('4')
  movieId?: string;

  @IsOptional()
  @IsUUID('4')
  seriesId?: string;

  @IsOptional()
  @IsUUID('4')
  bookId?: string;
}
