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
import { SkipThrottle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { UpdateWatchProgressDto } from './dto/update-watch-progress.dto';
import { VideoDiagnosisService } from './video-diagnosis.service';
import { VideosService } from './videos.service';

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

  /** Playback bootstrap — never rate limited. */
  @SkipThrottle()
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
