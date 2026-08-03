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
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { MovieResponseDto } from '../movies/dto/movie-response.dto';
import { CreateSeriesDto } from './dto/create-series.dto';
import { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesService } from './series.service';

@Controller('series')
export class SeriesController {
  constructor(private readonly seriesService: SeriesService) {}

  @Get()
  findAll(@Query() pagination: PaginationQueryDto) {
    return this.seriesService.findAll(pagination);
  }

  /** Registered before ':id' so "me" is never parsed as a series UUID. */
  @Get('me/purchases')
  getMyPurchases(@CurrentUser() user: AuthenticatedUser) {
    return this.seriesService.getPurchasesForUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.seriesService.getForViewer(id, user.id, user.role);
  }

  /** One purchase for the whole show — episodes are never bought individually. */
  @Post(':id/purchase')
  purchase(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.seriesService.purchase(user.id, id);
  }

  @Get(':id/seasons')
  getSeasons(@Param('id', ParseUUIDPipe) id: string) {
    return this.seriesService.getSeasons(id);
  }

  @Get(':id/episodes')
  async getEpisodes(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('seasonNumber', new ParseIntPipe({ optional: true })) seasonNumber?: number,
  ) {
    const episodes = await this.seriesService.getEpisodes(id, user.role, seasonNumber);
    return episodes.map((e) => MovieResponseDto.fromEntity(e));
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
