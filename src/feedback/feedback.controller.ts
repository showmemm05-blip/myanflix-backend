import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * The route is self-only — feedback belongs to the authenticated caller,
 * so ownership is enforced by scoping the query to @CurrentUser() rather
 * than by a permission (same pattern as notifications.controller.ts). Staff
 * read and triage feedback through the Tracking module instead.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  create(
    @Body() dto: CreateFeedbackDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.feedbackService.create(user.id, dto);
  }
}
