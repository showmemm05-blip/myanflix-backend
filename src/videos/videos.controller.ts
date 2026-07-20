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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { UpdateWatchProgressDto } from './dto/update-watch-progress.dto';
import { VideosService } from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  /** Registered before ':movieId/*' routes so "me" is never parsed as a movie UUID. */
  @Get('me/watch-history')
  getMyWatchHistory(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationQueryDto) {
    return this.videosService.getWatchHistoryForUser(user.id, pagination);
  }

  @Get('status/:movieId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.VIDEO_UPLOAD)
  getStatus(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.videosService.getLatestStatusForMovie(movieId);
  }

  @Get(':movieId/stream')
  async getStream(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videosService.getStreamInfo(movieId, user.id, user.role);
  }

  @Patch(':movieId/watch-progress')
  @HttpCode(HttpStatus.OK)
  async updateWatchProgress(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Body() dto: UpdateWatchProgressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videosService.recordWatchProgress(user.id, movieId, dto.progress, dto.lastPosition);
  }
}
