import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CommentQueryDto } from './dto/comment-query.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CommentsService } from './comments.service';

/**
 * Reading a title's comments needs no token (the website shows the thread
 * to signed-out visitors) but honours one — @OptionalAuth(), not @Public(),
 * so a signed-in reader's own comments come back flagged `isMine`. The
 * thread is otherwise the same for everyone: no reader, token or not, gets
 * another commenter's username or user id (SEC-007). Posting and deleting
 * are authenticated. Deletion is self-or-moderator, which the service
 * decides — see CommentsService.remove.
 */
@Controller('comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @OptionalAuth()
  @Get()
  findForTitle(
    @Query() query: CommentQueryDto,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.commentsService.findForTitle(query, viewer?.id ?? null);
  }

  /** The replies beyond the first REPLY_PREVIEW_LIMIT a thread read carries. */
  @OptionalAuth()
  @Get(':id/replies')
  findReplies(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.commentsService.findReplies(id, pagination, viewer?.id ?? null);
  }

  @Post()
  create(
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentsService.create(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.commentsService.remove(id, user);
  }
}
