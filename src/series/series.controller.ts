import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { MovieResponseDto } from '../movies/dto/movie-response.dto';
import { CreateSeriesDto } from './dto/create-series.dto';
import { EpisodeQueryDto } from './dto/episode-query.dto';
import { SeriesQueryDto } from './dto/series-query.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesService } from './series.service';

@Controller('series')
export class SeriesController {
  constructor(private readonly seriesService: SeriesService) {}

  @Get()
  findAll(@Query() query: SeriesQueryDto) {
    return this.seriesService.findAll(query);
  }

  /** Registered before ':id' so "me" is never parsed as a series UUID. */
  @Get('me/purchases')
  getMyPurchases(@CurrentUser() user: AuthenticatedUser) {
    return this.seriesService.getPurchasesForUser(user.id);
  }

  /**
   * Cross-series episode listing for the admin's Series > Ready to Publish
   * tab, filterable by series/season/status. Registered before ':id' so
   * "episodes" is never parsed as a series UUID.
   */
  @Get('episodes')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SERIES_MANAGE)
  async findEpisodes(@Query() query: EpisodeQueryDto) {
    const { items, total, page, limit } =
      await this.seriesService.findEpisodesForAdmin(query);
    return {
      items: items.map((episode) => ({
        ...MovieResponseDto.fromEntity(episode),
        seriesTitle: episode.series?.title ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Count-only counterpart to GET /series/episodes, for the sidebar badge. */
  @Get('episodes/count')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SERIES_MANAGE)
  async countEpisodes(@Query() query: EpisodeQueryDto) {
    const count = await this.seriesService.countEpisodesForAdmin(query);
    return { count };
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.getForViewer(id, user.id, user.role);
  }

  @Get(':id/seasons')
  getSeasons(@Param('id', ParseUUIDPipe) id: string) {
    return this.seriesService.getSeasons(id);
  }

  @Get(':id/episodes')
  async getEpisodes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('seasonNumber', new ParseIntPipe({ optional: true }))
    seasonNumber?: number,
  ) {
    const episodes = await this.seriesService.getEpisodes(
      id,
      user.role,
      seasonNumber,
    );
    return episodes.map((e) => MovieResponseDto.fromEntity(e));
  }

  /** Grouped-by-season episode list + the caller's own watch progress, for the player page's "Episodes" section. */
  @Get(':id/player-episodes')
  getPlayerEpisodes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.getPlayerEpisodes(id, user.id, user.role);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SERIES_MANAGE)
  create(@Body() dto: CreateSeriesDto) {
    return this.seriesService.create(dto);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SERIES_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSeriesDto) {
    return this.seriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.SERIES_MANAGE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.seriesService.remove(id);
  }
}
