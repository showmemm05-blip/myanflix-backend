import { IsEnum } from 'class-validator';
import { CommentStatus } from '../../generated/prisma/client';

/**
 * Hiding (or restoring) a comment. Deletion is a separate, harsher action
 * and already exists as `DELETE /comments/:id`, where the author's own
 * right to delete is what keeps it off a staff permission.
 */
export class ModerateCommentDto {
  @IsEnum(CommentStatus)
  status!: CommentStatus;
}
