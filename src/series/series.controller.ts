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
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import { MinioService } from '../common/storage/minio.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Role, SeriesStatus } from '../generated/prisma/client';
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

  /**
   * Guests may browse series (@OptionalAuth) — scoped as Role.USER, which
   * restricts the list to PUBLISHED shows. A staff token keeps its full view.
   */
  @Get()
  @OptionalAuth()
  findAll(
    @Query() query: SeriesQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    return this.seriesService.findAll(query, viewerRole);
  }

  /**
   * DB-derived filter options for the series tab's filter sheet — see
   * SeriesService.getFacets. Same auth as the rest of the catalog (open to
   * guests via @OptionalAuth; computed over PUBLISHED rows only). Registered
   * before ':id' so "facets" is never parsed as a series UUID.
   */
  @Get('facets')
  @OptionalAuth()
  getFacets() {
    return this.seriesService.getFacets();
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

  /** Guests see PUBLISHED series only — anything else is a 404 for them, same as for a regular user. */
  @Get(':id')
  @OptionalAuth()
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    const viewerId = user?.id;
    return this.seriesService.getForViewer(id, viewerId, viewerRole);
  }

  @Get(':id/seasons')
  getSeasons(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.getSeasons(id, user.role);
  }

  /** Episode metadata only (MovieResponseDto — no stream/HLS fields), so guests may read it. */
  @Get(':id/episodes')
  @OptionalAuth()
  async getEpisodes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthenticatedUser,
    @Query('seasonNumber', new ParseIntPipe({ optional: true }))
    seasonNumber?: number,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    const episodes = await this.seriesService.getEpisodes(
      id,
      viewerRole,
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
  create(@Body() dto: CreateSeriesDto, @CurrentUser() user: AuthenticatedUser) {
    return this.seriesService.create(dto, user);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('SERIES.EDIT')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSeriesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.update(id, dto, user);
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
    return this.seriesService.updateStatus(id, dto.status, user);
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
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.seriesService.remove(id, user);
  }
}
