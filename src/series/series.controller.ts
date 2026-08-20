import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MinioService } from '../common/storage/minio.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { SeriesStatus } from '../generated/prisma/client';
import { AuthorityService } from '../roles/authority.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { MovieResponseDto } from '../movies/dto/movie-response.dto';
import type { ImageUrlResolver } from '../movies/dto/movie-response.dto';
import { CreateSeriesDto } from './dto/create-series.dto';
import { EpisodeQueryDto } from './dto/episode-query.dto';
import { SeriesQueryDto } from './dto/series-query.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { UpdateSeriesStatusDto } from './dto/update-series-status.dto';
import { SeriesService } from './series.service';

@Controller('series')
export class SeriesController {
  constructor(
    private readonly seriesService: SeriesService,
    private readonly minioService: MinioService,
    private readonly authority: AuthorityService,
  ) {}

  /**
   * Episode poster/thumbnail URLs are persisted absolute (baked with
   * whatever host uploaded them), so they're re-hosted against the current
   * request on the way out — see MinioService.imageUrl. An arrow property so
   * it stays bound when handed to MovieResponseDto.fromEntity.
   */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  @Get()
  findAll(
    @Query() query: SeriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.findAll(query, user.role);
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
  @RequirePermissions('SERIES.VIEW')
  async findEpisodes(@Query() query: EpisodeQueryDto) {
    const { items, total, page, limit } =
      await this.seriesService.findEpisodesForAdmin(query);
    return {
      items: items.map((episode) => ({
        ...MovieResponseDto.fromEntity(episode, this.resolveImageUrl),
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
  @RequirePermissions('SERIES.VIEW')
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
  getSeasons(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.getSeasons(id, user.role);
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
    return episodes.map((e) =>
      MovieResponseDto.fromEntity(e, this.resolveImageUrl),
    );
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
  @RequirePermissions('SERIES.CREATE')
  create(@Body() dto: CreateSeriesDto) {
    return this.seriesService.create(dto);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SERIES.EDIT')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSeriesDto) {
    return this.seriesService.update(id, dto);
  }

  /**
   * Publish/unpublish a series — one route handles both directions, so the
   * decorator alone could only ever name one of the two permissions (F11).
   * The body decides which one is actually required, in addition to the
   * SERIES.PUBLISH the decorator already demands. Every seeded role holding
   * SERIES.EDIT holds both, so nobody loses access they have today.
   */
  @Patch(':id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SERIES.PUBLISH')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSeriesStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (dto.status === SeriesStatus.PUBLISHED) {
      await this.authority.assertHas(
        user,
        'SERIES.PUBLISH',
        'You do not have permission to publish series',
      );
    } else {
      await this.authority.assertHas(
        user,
        'SERIES.UNPUBLISH',
        'You do not have permission to unpublish series',
      );
    }
    return this.seriesService.updateStatus(id, dto.status);
  }

  /**
   * Deletes the show plus all its episodes and their stored media. Returns
   * the cleanup report (200, not 204) so the admin can surface a partial
   * storage cleanup instead of it failing silently:
   * { deletedEpisodes, storageCleanup: 'complete' | 'partial', failedObjects }.
   */
  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SERIES.DELETE')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.seriesService.remove(id);
  }
}
