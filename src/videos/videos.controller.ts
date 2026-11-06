import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import {
  THROTTLER_DEFAULT,
  accountTracker,
} from '../common/throttling/throttling.config';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { UpdateWatchProgressDto } from './dto/update-watch-progress.dto';
import { VideoDiagnosisService } from './video-diagnosis.service';
import { VideosService } from './videos.service';

/**
 * Stream lookups per minute per ACCOUNT on GET :movieId/stream. A player
 * fetches it once per play and again after a 410 from the cache (hour-
 * quantised links, so at most once an hour per title); 60 is far above any
 * honest client and well below what a runaway loop needs to be a problem.
 */
export const STREAM_THROTTLE_PER_MINUTE = 60;

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videoDiagnosisService: VideoDiagnosisService,
  ) {}

  /** Registered before ':movieId/*' routes so "me" is never parsed as a movie UUID. */
  @Get('me/watch-history')
  getMyWatchHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.videosService.getWatchHistoryForUser(user.id, pagination);
  }

  /** Polled by the admin while transcoding — never rate limited. */
  @SkipThrottle()
  @Get('status/:movieId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MEDIA.VIEW')
  getStatus(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.videosService.getLatestStatusForMovie(movieId);
  }

  /**
   * Staff-only "Check playback": HEADs every object the title's video points
   * at and fetches the signed master through the cache server, and says
   * whether the fix is a reprocess, a replace, or neither. MOVIES.EDIT
   * rather than MEDIA.UPLOAD: its only caller is the Edit Movie dialog, it
   * is a read-only diagnosis of the title, and an editor who cannot upload
   * must still be able to see why a title does not play. Deliberately NOT
   * @SkipThrottle — each call is ~10 MinIO round-trips plus an HTTP fetch,
   * and the admin runs it on demand only.
   */
  @Get(':movieId/diagnose')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.EDIT')
  diagnose(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.videoDiagnosisService.diagnose(movieId);
  }

  /**
   * Playback bootstrap. Was @SkipThrottle (SEC-022): many viewers share one
   * carrier-NAT address, so the site-wide per-IP bucket would let one
   * household's play lock out the next. Still never keyed by IP — instead
   * the `default` bucket is re-keyed per account on this route alone
   * (accountTracker: `account:<id>` from the req.user JwtAuthGuard has
   * already set, and nothing from the body — express parses a body on a
   * GET too, so a tracker that read `username`/`phone` first would hand a
   * hammering client a fresh bucket per made-up value), which is what stops
   * one client from hammering the subscription check.
   */
  @Throttle({
    [THROTTLER_DEFAULT]: {
      limit: STREAM_THROTTLE_PER_MINUTE,
      ttl: 60_000,
      getTracker: accountTracker,
    },
  })
  @Get(':movieId/stream')
  async getStream(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videosService.getStreamInfo(movieId, user.id, user.role);
  }

  /**
   * The caller's own saved position for one title ({ position, progress,
   * updatedAt }, or null) — what the players resume from. Same guards as the
   * PATCH below (signed-in, default throttling); the user comes from the
   * access token only, never from the request.
   */
  @Get(':movieId/watch-progress')
  getWatchProgress(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videosService.getWatchProgress(user.id, movieId);
  }

  @Patch(':movieId/watch-progress')
  @HttpCode(HttpStatus.OK)
  async updateWatchProgress(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Body() dto: UpdateWatchProgressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videosService.recordWatchProgress(
      user.id,
      movieId,
      dto.progress,
      dto.lastPosition,
      user.role,
    );
  }
}
