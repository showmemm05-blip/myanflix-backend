import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requestClientContext } from '../../common/storage/request-host.context';
import { LotteryActivityService } from './lottery-activity.service';

/**
 * POST /lottery/activity — the app's "I am in the lottery" ping. Any
 * signed-in user (the global JwtAuthGuard, no permission); the body is
 * ignored (the app sends `{}`), the answer is always 204 once auth
 * passed: the write is fire-and-forget and the service swallows its own
 * errors. The platform is read the way TrackingService reads it (the
 * X-Client-Platform header, UNKNOWN when absent), never from the body.
 */
@Controller('lottery/activity')
export class LotteryActivityController {
  constructor(private readonly activity: LotteryActivityService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  record(@CurrentUser() user: AuthenticatedUser): void {
    const { platform } = requestClientContext();
    void this.activity.record(user.id, platform, new Date());
  }
}
