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
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { CreateMovieDto } from './dto/create-movie.dto';
import { MovieQueryDto } from './dto/movie-query.dto';
import { MovieResponseDto } from './dto/movie-response.dto';
import { UpdateMovieDto } from './dto/update-movie.dto';
import { MoviesService } from './movies.service';

@Controller('movies')
export class MoviesController {
  constructor(private readonly moviesService: MoviesService) {}

  @Get()
  async findAll(@Query() query: MovieQueryDto, @CurrentUser() user: AuthenticatedUser) {
    const { items, total, page, limit } = await this.moviesService.findAll(query, user.role);
    return { items: items.map((m) => MovieResponseDto.fromEntity(m)), total, page, limit };
  }

  /** Registered before ':id' so "me" is never parsed as a movie UUID. */
  @Get('me/purchases')
  getMyPurchases(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationQueryDto) {
    return this.moviesService.getPurchasesForUser(user.id, pagination);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const movie = await this.moviesService.findByIdOrThrow(id, user.role);
    return MovieResponseDto.fromEntity(movie);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.MOVIE_CREATE)
  async create(@Body() dto: CreateMovieDto) {
    const movie = await this.moviesService.create(dto);
    return MovieResponseDto.fromEntity(movie);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.MOVIE_UPDATE)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMovieDto) {
    const movie = await this.moviesService.update(id, dto);
    return MovieResponseDto.fromEntity(movie);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(Permission.MOVIE_DELETE)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.moviesService.remove(id);
  }

  @Post(':id/purchase')
  async purchase(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.moviesService.purchase(user.id, id);
  }
}
