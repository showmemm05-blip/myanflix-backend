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
import { Role } from '../generated/prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalAuth } from '../common/decorators/optional-auth.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { ActorsService } from './actors.service';
import { ActorQueryDto, CreateActorDto, UpdateActorDto } from './dto/actor.dto';
import { ActorResponseDto } from './dto/actor-response.dto';
import type { ImageUrlResolver } from '../movies/dto/movie-response.dto';

/**
 * Reads are open to any authenticated caller — the cast of a film is public
 * catalog metadata, exactly like its categories, so the user site reads this
 * without a permission. The list and detail reads are also open to guests
 * (@OptionalAuth) for the catalogue's cast filter; they return only actor
 * metadata and re-hosted headshot URLs. Mutations are gated per route.
 */
@Controller('actors')
export class ActorsController {
  constructor(
    private readonly actorsService: ActorsService,
    private readonly minioService: MinioService,
  ) {}

  /** Headshots are persisted absolute and re-hosted per request — see MinioService.imageUrl. */
  private readonly resolveImageUrl: ImageUrlResolver = (url) =>
    this.minioService.imageUrl(url);

  @Get()
  @OptionalAuth()
  async findAll(
    @Query() query: ActorQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    // Guests and regular users get counts over the PUBLISHED catalogue only,
    // so a number on the People list never exceeds what the person's page
    // can show them; staff count everything.
    const viewerRole = user?.role ?? Role.USER;
    const { items, total, page, limit } = await this.actorsService.findAll(
      query,
      viewerRole,
    );
    return {
      items: items.map((a) =>
        ActorResponseDto.fromEntity(a, this.resolveImageUrl),
      ),
      total,
      page,
      limit,
    };
  }

  @Get(':id')
  @OptionalAuth()
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const viewerRole = user?.role ?? Role.USER;
    const actor = await this.actorsService.findByIdOrThrow(id, viewerRole);
    return ActorResponseDto.fromEntity(actor, this.resolveImageUrl);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ACTORS.CREATE')
  async create(
    @Body() dto: CreateActorDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actor = await this.actorsService.create(dto, user);
    return ActorResponseDto.fromEntity(actor, this.resolveImageUrl);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ACTORS.EDIT')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActorDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actor = await this.actorsService.update(id, dto, user);
    return ActorResponseDto.fromEntity(actor, this.resolveImageUrl);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ACTORS.DELETE')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.actorsService.remove(id, user);
  }
}
