import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { SubscribeDto } from './dto/subscribe.dto';
import { SubscriptionsService } from './subscriptions.service';

/** Self-service only — no guard beyond auth, ownership scoped by @CurrentUser(). */
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('me')
  getMyStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionsService.getMyStatus(user.id);
  }

  @Post('subscribe')
  subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubscribeDto) {
    return this.subscriptionsService.subscribe(user.id, dto.planId);
  }
}
