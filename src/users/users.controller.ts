import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { MoviesService } from '../movies/movies.service';
import { VideosService } from '../videos/videos.service';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGE)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly moviesService: MoviesService,
    private readonly videosService: VideosService,
  ) {}

  /**
   * Every authenticated role can read their own profile — overrides the
   * class-level USER_MANAGE requirement with an empty permission list.
   * Registered before ':id' so "me" is never parsed as a user UUID.
   */
  @Get('me')
  @RequirePermissions()
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    const [profile, wallet] = await Promise.all([
      this.usersService.findByIdOrThrow(user.id),
      this.usersService.getWalletSummary(user.id),
    ]);
    return UserResponseDto.fromEntity(profile, wallet);
  }

  @Get()
  async findAll(@Query() pagination: PaginationQueryDto) {
    const { items, total, walletByUserId } = await this.usersService.findAll(pagination);
    return {
      items: items.map((user) => UserResponseDto.fromEntity(user, walletByUserId.get(user.id))),
      total,
      page: pagination.page ?? 1,
      limit: pagination.limit ?? 20,
    };
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const [user, wallet] = await Promise.all([
      this.usersService.findByIdOrThrow(id),
      this.usersService.getWalletSummary(id),
    ]);
    return UserResponseDto.fromEntity(user, wallet);
  }

  @Get(':id/purchases')
  getPurchases(@Param('id', ParseUUIDPipe) id: string, @Query() pagination: PaginationQueryDto) {
    return this.moviesService.getPurchasesForUser(id, pagination);
  }

  @Get(':id/watch-history')
  getWatchHistory(@Param('id', ParseUUIDPipe) id: string, @Query() pagination: PaginationQueryDto) {
    return this.videosService.getWatchHistoryForUser(id, pagination);
  }

  @Patch(':id/role')
  async updateRole(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    const user = await this.usersService.updateRole(id, dto.role);
    return UserResponseDto.fromEntity(user);
  }

  @Patch(':id/status')
  async updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStatusDto) {
    const user = await this.usersService.updateStatus(id, dto.status);
    return UserResponseDto.fromEntity(user);
  }
}
