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
import { MinioService } from '../common/storage/minio.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MovieStatus } from '../generated/prisma/client';
import { AuthorityService } from '../roles/authority.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
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
  ) {}

  /**
   * Poster/cover/thumbnail URLs are persisted absolute (baked with whatever
   * host uploaded them), so every one of them is re-hosted against the
   * current request before going out — see MinioService.imageUrl. An arrow
   * property so it stays bound when handed to MovieResponseDto.fromEntity.
   */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  @Get()
  async findAll(
    @Query() query: MovieQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { items, total, page, limit } = await this.moviesService.findAll(
      query,
      user.role,
      user.id,
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

  /** Registered before ':id' so "most-purchased" is never parsed as a movie UUID. */
  @Get('most-purchased')
  async getMostPurchased() {
    const movies = await this.moviesService.getMostPurchased();
    return movies.map((m) =>
      MovieResponseDto.fromEntity(m, this.resolveImageUrl),
    );
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const movie = await this.moviesService.findByIdOrThrow(id, user.role);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.CREATE')
  async create(@Body() dto: CreateMovieDto) {
    const movie = await this.moviesService.create(dto);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  /**
   * Bootstraps a movie for the bulk pre-transcoded upload flow — title only,
   * status UPLOADING. Everything else is filled in later via PUT /movies/:id
   * once the upload finishes and the admin edits it.
   */
  @Post('upload-placeholder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.CREATE')
  async createUploadPlaceholder(@Body() dto: CreateUploadPlaceholderDto) {
    const movie = await this.moviesService.createUploadPlaceholder(
      dto.title,
      dto.seriesId
        ? {
            seriesId: dto.seriesId,
            seasonNumber: dto.seasonNumber!,
            episodeNumber: dto.episodeNumber!,
          }
        : undefined,
    );
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
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

    const movie = await this.moviesService.update(id, dto);
    return MovieResponseDto.fromEntity(movie, this.resolveImageUrl);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('MOVIES.DELETE')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.moviesService.remove(id);
  }
}
