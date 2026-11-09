import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MinioService } from '../common/storage/minio.service';
import {
  MovieResponseDto,
  type ImageUrlResolver,
} from '../movies/dto/movie-response.dto';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { toSeriesResponse } from '../series/dto/series-response.dto';
import {
  ApplyMovieTmdbDto,
  ApplySeriesTmdbDto,
  TmdbEntryDto,
  TmdbMovieStatesQueryDto,
  TmdbSearchQueryDto,
  TmdbStatusQueryDto,
} from './dto/tmdb.dto';
import { TmdbFillService } from './tmdb-fill.service';
import { TmdbLookupService } from './tmdb-lookup.service';
import { TmdbSearchService } from './tmdb-search.service';
import { TmdbStateService } from './tmdb-state.service';
import { TmdbStatusService } from './tmdb-status.service';

/**
 * Movie and series details from TMDB — the staff routes (PLAN.md 5.3 of
 * docs/movie-details-tmdb-2026-11-06). Every TMDB call is made here, on
 * the server: the key never reaches a browser, and a browser never names
 * a TMDB address, only TMDB's numeric id of a film or a show.
 *
 * Reading (status, states) needs the VIEW permission of its catalogue;
 * searching and previewing need EDIT; anything that writes pictures into
 * storage (lookup, apply, a series created from TMDB) also needs
 * MEDIA.UPLOAD, as a staff image upload does. New actors additionally
 * need the caller's ACTORS.CREATE, checked inside the fill.
 *
 * While TMDB_API_KEY is missing, GET /tmdb/status answers `configured:
 * false`, GET /tmdb/movies/state still answers (it reads only our own
 * rows, and the folder name of an upload must stay readable), and every
 * other route answers 503 TMDB_NOT_CONFIGURED. Writes are audited by the
 * services (`movie.update` / `series.update` / `series.create` /
 * `actor.*` / `image.upload`, with `via: 'tmdb'`); searches, previews and
 * status changes are only logged.
 */
@Controller('tmdb')
@UseGuards(PermissionsGuard)
export class TmdbController {
  constructor(
    private readonly status: TmdbStatusService,
    private readonly search: TmdbSearchService,
    private readonly state: TmdbStateService,
    private readonly lookup: TmdbLookupService,
    private readonly fill: TmdbFillService,
    private readonly minioService: MinioService,
  ) {}

  /** Stored picture URLs are re-hosted per request — see MinioService.imageUrl. */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  /** Whether TMDB is connected. Answers without a key — it is how the admin learns there is none. */
  @Get('status')
  @RequirePermissions('MOVIES.VIEW')
  getStatus(@Query() query: TmdbStatusQueryDto) {
    return this.status.get(query.fresh === true);
  }

  @Get('search/movie')
  @RequirePermissions('MOVIES.EDIT')
  searchMovies(@Query() query: TmdbSearchQueryDto) {
    return this.search.searchMovies(query.query, query.year ?? null);
  }

  @Get('search/tv')
  @RequirePermissions('SERIES.EDIT')
  searchTv(@Query() query: TmdbSearchQueryDto) {
    return this.search.searchTv(query.query, query.year ?? null);
  }

  /** Where the lookup of each movie stands — what the badges poll while one is PENDING. Answers without a key too: the folder names. */
  @Get('movies/state')
  @RequirePermissions('MOVIES.VIEW')
  movieStates(@Query() query: TmdbMovieStatesQueryDto) {
    return this.state.movieStates(query.ids);
  }

  /** "Find details" / "Try again": starts the automatic lookup and answers at once. */
  @Post('movies/:id/lookup')
  @RequirePermissions('MOVIES.EDIT', 'MEDIA.UPLOAD')
  @HttpCode(HttpStatus.ACCEPTED)
  lookupMovie(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.lookup.requestLookup(id, user);
  }

  /** The review of one TMDB film against this movie. Writes nothing. */
  @Post('movies/:id/preview')
  @RequirePermissions('MOVIES.EDIT')
  @HttpCode(HttpStatus.OK)
  previewMovie(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TmdbEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fill.previewMovie(id, dto.tmdbId, user);
  }

  /** Writes exactly `fields` and links the movie; answers the movie as every movie route does, plus what was done. */
  @Post('movies/:id/apply')
  @RequirePermissions('MOVIES.EDIT', 'MEDIA.UPLOAD')
  @HttpCode(HttpStatus.OK)
  async applyMovie(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyMovieTmdbDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { movie, report } = await this.fill.applyMovie(
      id,
      dto.tmdbId,
      dto.fields,
      user,
    );
    return {
      movie: MovieResponseDto.fromEntity(movie, this.resolveImageUrl),
      report,
    };
  }

  @Get('series/:id/state')
  @RequirePermissions('SERIES.VIEW')
  seriesState(@Param('id', ParseUUIDPipe) id: string) {
    return this.state.seriesState(id);
  }

  /** "Find on TMDB" for a new show: creates the series from that entry, as a draft. 201. */
  @Post('series')
  @RequirePermissions('SERIES.CREATE', 'MEDIA.UPLOAD')
  async createSeries(
    @Body() dto: TmdbEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { series, report } = await this.fill.createSeries(dto.tmdbId, user);
    return { series: toSeriesResponse(series, this.resolveImageUrl), report };
  }

  /** The review of one TMDB show against this series. Writes nothing. */
  @Post('series/:id/preview')
  @RequirePermissions('SERIES.EDIT')
  @HttpCode(HttpStatus.OK)
  previewSeries(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TmdbEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fill.previewSeries(id, dto.tmdbId, user);
  }

  /** Writes exactly `fields` and links the series; answers the usual series shape (no TMDB columns), plus what was done. */
  @Post('series/:id/apply')
  @RequirePermissions('SERIES.EDIT', 'MEDIA.UPLOAD')
  @HttpCode(HttpStatus.OK)
  async applySeries(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplySeriesTmdbDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { series, report } = await this.fill.applySeries(
      id,
      dto.tmdbId,
      dto.fields,
      user,
    );
    return { series: toSeriesResponse(series, this.resolveImageUrl), report };
  }
}
