import { IsOptional, IsUUID } from 'class-validator';

/**
 * Which title's comments to list. Exactly one of the two is required —
 * enforced in the service, same either/or rule as CreateCommentDto.
 *
 * Deliberately not paginated: a title's comment thread is read whole by both
 * clients (the section renders every top-level comment with its replies
 * nested underneath), and PUBLIC_LIMIT in the service caps how much a single
 * request can pull.
 */
export class CommentQueryDto {
  @IsOptional()
  @IsUUID('4')
  movieId?: string;

  @IsOptional()
  @IsUUID('4')
  seriesId?: string;
}
