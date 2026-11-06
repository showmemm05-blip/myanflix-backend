import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { requestClientContext } from '../common/storage/request-host.context';
import {
  accountTracker,
  THROTTLER_DEFAULT,
} from '../common/throttling/throttling.config';
import { AdDecisionService } from './ad-decision.service';
import {
  AdPlaybackEventDto,
  MidrollRequestDto,
  PrerollRequestDto,
} from './dto/ad-preroll.dto';

/** Per account, like /videos/:id/stream: one decision and a few events per play. */
const PREROLL_THROTTLE_PER_MINUTE = 60;

/**
 * The player's side of ads. Any signed-in viewer (the global JwtAuthGuard,
 * no permission); guests get 401 like they do on /stream. The decisions are
 * POSTs that answer 200 because they write PENDING playback rows: `session`
 * once per open of a title (the ad before the movie, the break plan, the
 * corner picture), `midroll` once per break, `preroll` the session's
 * pre-roll part for app builds from before the session route. The events
 * route answers 200 with the row's status, a repeat included, so the player
 * never has to special-case a replay.
 */
@Controller('ads')
export class AdsController {
  constructor(private readonly decisions: AdDecisionService) {}

  @Throttle({
    [THROTTLER_DEFAULT]: {
      limit: PREROLL_THROTTLE_PER_MINUTE,
      ttl: 60_000,
      getTracker: accountTracker,
    },
  })
  @Post('session')
  @HttpCode(HttpStatus.OK)
  session(
    @Body() dto: PrerollRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { platform } = requestClientContext();
    return this.decisions.session({
      userId: user.id,
      role: user.role,
      movieId: dto.movieId,
      platform,
    });
  }

  @Throttle({
    [THROTTLER_DEFAULT]: {
      limit: PREROLL_THROTTLE_PER_MINUTE,
      ttl: 60_000,
      getTracker: accountTracker,
    },
  })
  @Post('midroll')
  @HttpCode(HttpStatus.OK)
  midroll(
    @Body() dto: MidrollRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { platform } = requestClientContext();
    return this.decisions.midroll({
      userId: user.id,
      role: user.role,
      movieId: dto.movieId,
      breakAtSeconds: dto.breakAtSeconds,
      platform,
    });
  }

  @Throttle({
    [THROTTLER_DEFAULT]: {
      limit: PREROLL_THROTTLE_PER_MINUTE,
      ttl: 60_000,
      getTracker: accountTracker,
    },
  })
  @Post('preroll')
  @HttpCode(HttpStatus.OK)
  decide(
    @Body() dto: PrerollRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { platform } = requestClientContext();
    return this.decisions.preroll({
      userId: user.id,
      role: user.role,
      movieId: dto.movieId,
      platform,
    });
  }

  @Throttle({
    [THROTTLER_DEFAULT]: {
      limit: PREROLL_THROTTLE_PER_MINUTE,
      ttl: 60_000,
      getTracker: accountTracker,
    },
  })
  @Post('playbacks/:playbackId/events')
  @HttpCode(HttpStatus.OK)
  event(
    @Param('playbackId', ParseUUIDPipe) playbackId: string,
    @Body() dto: AdPlaybackEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.decisions.recordEvent(
      playbackId,
      user.id,
      dto.event,
      dto.positionSeconds,
    );
  }
}
