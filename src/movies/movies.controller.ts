import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import { MinioService } from '../common/storage/minio.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MovieStatus, Role } from '../generated/prisma/client';
import { AuthorityService } from '../roles/authority.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { VideoDurationService } from '../videos/video-duration.service';
import { BackfillDurationsDto } from './dto/backfill-durations.dto';
import { CreateMovieDto } from './dto/create-movie.dto';
import { CreateUploadPlaceholderDto } from './dto/create-upload-placeholder.dto';
import { MovieQueryDto } from './dto/movie-query.dto';
import { MovieResponseDto } from './dto/movie-response.dto';
import type { ImageUrlResolver } from './dto/movie-response.dto';
import { UpdateMovieDto } from './dto/update-movie.dto';
import { MoviesService } from './movies.service';

@Controller('movies')
export class MoviesController {
  constructor(
    private readonly moviesService: MoviesService,
    private readonly minioService: MinioService,
    private readonly authority: AuthorityService,
    private readonly videoDurationService: VideoDurationService,
  ) {}

  /**
   * Poster/cover/thumbnail URLs are persisted absolute (baked with whatever
   * host uploaded them), so every one of them is re-hosted against the
   * current request before going out — see MinioService.imageUrl. An arrow
   * property so it stays bound when handed to MovieResponseDto.fromEntity.
   */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  /**
   * Guests may browse the catalogue (@OptionalAuth) — they are scoped as
   * Role.USER, which is what makes the service return PUBLISHED standalone
   * movies only. A staff token on the same route keeps its full view.
   */
  @Get()
  @OptionalAuth()
  async findAll(
    @Query() query: MovieQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    const viewerId = user?.id;
    const { items, total, page, limit } = await this.moviesService.findAll(
      query,
      viewerRole,
      viewerId,
    );
    return {
      items: items.map((m) =>
        MovieResponseDto.fromEntity(m, this.resolveImageUrl),
      ),
      total,
      page,
      limit,
    };
  }

  /** Registered before ':id' so "me" is never parsed as a movie UUID. */
  @Get('me/purchases')
  getMyPurchases(
    @CurrentUser() user: AuthenticatedUser,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.moviesService.getPurchasesForUser(user.id, pagination);
  }

  /**
   * DB-derived filter options for the catalog's filter sheet — see
   * MoviesService.getFacets. Same auth as the rest of the catalog (open to
   * guests via @OptionalAuth; the facets are computed over PUBLISHED rows
   * only). Registered before ':id' so "facets" is never parsed as a movie
   * UUID.
   */
  @Get('facets')
  @OptionalAuth()
  getFacets() {
    return this.moviesService.getFacets();
  }

  /** Registered before ':id' so "most-purchased" is never parsed as a movie UUID. */
  @Get('most-purchased')
  @OptionalAuth()
  async getMostPurchased() {
    const movies = await this.moviesService.getMostPurchased();
    return movies.map((m) =>
      MovieResponseDto.fromEntity(m, this.resolveImageUrl),
    );
  }

  /** Guests see PUBLISHED movies only — anything else is a 404 for them, same as for a regular user. */
  @Get(':id')
  @OptionalAuth()
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    const movie = await this.moviesService.findByIdOrThrow(id, viewerRole);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.CREATE')
  async create(
    @Body() dto: CreateMovieDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const movie = await this.moviesService.create(dto, user);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  /**
   * Bootstraps a movie for the bulk pre-transcoded upload flow — title (and
   * the runtime the uploader probed from the bundle, when it could), status
   * UPLOADING. Everything else is filled in later via PUT /movies/:id once
   * the upload finishes and the admin edits it.
   */
  @Post('upload-placeholder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.CREATE')
  async createUploadPlaceholder(
    @Body() dto: CreateUploadPlaceholderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const movie = await this.moviesService.createUploadPlaceholder(
      dto.title,
      dto.seriesId
        ? {
            seriesId: dto.seriesId,
            seasonNumber: dto.seasonNumber!,
            episodeNumber: dto.episodeNumber!,
          }
        : undefined,
      { duration: dto.duration },
      user,
    );
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  /**
   * Repairs titles that predate runtime capture (Movie.duration still 0)
   * from the HLS they stream — see VideoDurationService.backfill. Idempotent
   * and capped at 100 per call; the admin clicks again while `remaining` is
   * non-zero. Registered before the ':id' routes so "durations" is never
   * parsed as a movie UUID.
   */
  @Post('durations/backfill')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.EDIT')
  backfillDurations(
    @Body() dto: BackfillDurationsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videoDurationService.backfill(dto.limit ?? 100, user);
  }

  /**
   * Movies have no publish route of their own — they publish through this
   * one's `status` field, which is why MOVIES.PUBLISH/UNPUBLISH gated nothing
   * (F11). MOVIES.EDIT still covers every other field; only an edit that
   * actually crosses the PUBLISHED line asks for the extra permission, so a
   * role that may edit but not publish can still fix a typo on a live movie.
   * Every seeded role holding MOVIES.EDIT also holds both, so nobody loses
   * access they have today.
   */
  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.EDIT')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMovieDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (dto.status !== undefined) {
      const current = await this.moviesService.getStatusOrThrow(id);
      const wasPublished = current === MovieStatus.PUBLISHED;
      const willBePublished = dto.status === MovieStatus.PUBLISHED;

      if (!wasPublished && willBePublished) {
        await this.authority.assertHas(
          user,
          'MOVIES.PUBLISH',
          'You do not have permission to publish movies',
        );
      } else if (wasPublished && !willBePublished) {
        await this.authority.assertHas(
          user,
          'MOVIES.UNPUBLISH',
          'You do not have permission to unpublish movies',
        );
      }
    }

    const movie = await this.moviesService.update(id, dto, user);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.DELETE')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.moviesService.remove(id, user);
  }
}
