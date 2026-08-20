import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { TrackingCommentQueryDto } from './dto/tracking-comment-query.dto';
import { ModerateCommentDto } from './dto/moderate-comment.dto';
import { TrackingFeedbackQueryDto } from './dto/tracking-feedback-query.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { ActiveUsersQueryDto } from './dto/active-users-query.dto';
import { WatchTimeQueryDto } from './dto/watch-time-query.dto';
import { TrackingSearchQueryDto } from './dto/tracking-search-query.dto';
import { TrackingSessionQueryDto } from './dto/tracking-session-query.dto';
import { TrackingReadService } from './tracking-read.service';

/**
 * The admin's Tracking section — comments, feedback, live presence, when
 * people watch, what people search for, and the phone/IP view.
 *
 * A class-level `TRACKING.VIEW` gate covers every route here, because every
 * one of them exposes behavioural data about identifiable users; there is no
 * public or self-service route in this controller for the gate to get in the
 * way of. The two write routes override it with a STRICTER pair
 * (`PermissionsGuard` requires ALL listed permissions), so moderating a
 * comment or triaging feedback needs both the section's read access and the
 * specific action — a role can be given the whole section read-only.
 *
 * `TRACKING.PII_VIEW` is deliberately NOT a route gate: it changes what a
 * response CONTAINS, not whether the caller may make the request, and that
 * decision belongs to the service (see TrackingReadService).
 */
@Controller('tracking')
@UseGuards(PermissionsGuard)
@RequirePermissions('TRACKING.VIEW')
export class TrackingController {
  constructor(private readonly trackingReadService: TrackingReadService) {}

  @Get('comments')
  comments(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: TrackingCommentQueryDto,
  ) {
    return this.trackingReadService.comments(actor, query);
  }

  /** Hide or restore a comment. Deleting one is `DELETE /comments/:id`. */
  @Patch('comments/:id')
  @RequirePermissions('TRACKING.VIEW', 'TRACKING.COMMENTS_MODERATE')
  moderateComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateCommentDto,
  ) {
    return this.trackingReadService.moderateComment(id, dto);
  }

  @Get('feedback')
  feedback(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: TrackingFeedbackQueryDto,
  ) {
    return this.trackingReadService.feedback(actor, query);
  }

  @Patch('feedback/:id')
  @RequirePermissions('TRACKING.VIEW', 'TRACKING.FEEDBACK_MANAGE')
  updateFeedbackStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeedbackStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.trackingReadService.updateFeedbackStatus(id, dto, actor);
  }

  @Get('active-users')
  activeUsers(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ActiveUsersQueryDto,
  ) {
    return this.trackingReadService.activeUsers(actor, query);
  }

  @Get('watch-time')
  watchTime(@Query() query: WatchTimeQueryDto) {
    return this.trackingReadService.watchTime(query);
  }

  /**
   * Declared before `GET searches` only for readability — Express matches
   * these two by exact path, so neither shadows the other.
   */
  @Get('searches/recent')
  recentSearches(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: TrackingSearchQueryDto,
  ) {
    return this.trackingReadService.recentSearches(actor, query);
  }

  @Get('searches')
  topSearches(@Query() query: TrackingSearchQueryDto) {
    return this.trackingReadService.topSearches(query);
  }

  @Get('sessions')
  sessions(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: TrackingSessionQueryDto,
  ) {
    return this.trackingReadService.sessions(actor, query);
  }

  @Get('sessions/:userId')
  userSessions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.trackingReadService.userSessions(actor, userId, pagination);
  }
}
