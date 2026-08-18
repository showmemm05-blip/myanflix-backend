import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { MoviesService } from '../movies/movies.service';
import { VideosService } from '../videos/videos.service';
import { Permission } from '../roles/permission.enum';
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { WalletAdjustmentsService } from '../wallet/wallet-adjustments.service';
import { CreateWalletAdjustmentDto } from '../wallet/dto/create-wallet-adjustment.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UsersQueryDto } from './dto/users-query.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import type { User } from '../generated/prisma/client';
import { UserResponseDto } from './dto/user-response.dto';
import { UserRelationshipsQueryDto } from './dto/user-relationships-query.dto';
import { UserRelationshipsService } from './user-relationships.service';
import { UsersService, type WalletSummary } from './users.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

@Controller('users')
@UseGuards(PermissionsGuard)
@RequirePermissions(Permission.USER_MANAGE)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly moviesService: MoviesService,
    private readonly videosService: VideosService,
    private readonly walletAdjustmentsService: WalletAdjustmentsService,
    private readonly userRelationshipsService: UserRelationshipsService,
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
    return this.toResponse(profile, wallet);
  }

  /**
   * Same empty-permission-override pattern as GET me — any authenticated
   * user manages their OWN avatar. Registered before ':id' routes so
   * "me" is never parsed as a user UUID.
   */
  @Post('me/avatar')
  @RequirePermissions()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES } }),
  )
  async uploadMyAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file)
      throw new BadRequestException(
        'No image file received (expected field "file")',
      );
    const [updated, wallet] = await Promise.all([
      this.usersService.uploadAvatar(user.id, file),
      this.usersService.getWalletSummary(user.id),
    ]);
    return this.toResponse(updated, wallet);
  }

  @Delete('me/avatar')
  @RequirePermissions()
  async removeMyAvatar(@CurrentUser() user: AuthenticatedUser) {
    const [updated, wallet] = await Promise.all([
      this.usersService.removeAvatar(user.id),
      this.usersService.getWalletSummary(user.id),
    ]);
    return this.toResponse(updated, wallet);
  }

  @Get()
  async findAll(@Query() pagination: UsersQueryDto) {
    const { items, total, walletByUserId } =
      await this.usersService.findAll(pagination);
    return {
      items: items.map((user) =>
        this.toResponse(user, walletByUserId.get(user.id)),
      ),
      total,
      page: pagination.page ?? 1,
      limit: pagination.limit ?? 20,
    };
  }

  /**
   * Read-only phone-number relationship network for the admin graph. Carries
   * the class-level USER_MANAGE requirement — same permission the rest of the
   * admin Users page runs on. Registered before ':id' so "relationships" is
   * never parsed as a user UUID.
   */
  @Get('relationships')
  getRelationships(@Query() query: UserRelationshipsQueryDto) {
    return this.userRelationshipsService.getNetwork(query.phone);
  }

  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const [user, wallet] = await Promise.all([
      this.usersService.findByIdOrThrow(id),
      this.usersService.getWalletSummary(id),
    ]);
    return this.toResponse(user, wallet);
  }

  @Get(':id/purchases')
  getPurchases(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.moviesService.getPurchasesForUser(id, pagination);
  }

  @Get(':id/watch-history')
  getWatchHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.videosService.getWatchHistoryForUser(id, pagination);
  }

  /**
   * Stricter than the class-level USER_MANAGE — WALLET_ADJUST is carried by
   * SUPER_ADMIN only (via ALL_PERMISSIONS), so the method-level override
   * keeps regular admins out of balance corrections.
   */
  @Post(':id/wallet-adjustments')
  @RequirePermissions(Permission.WALLET_ADJUST)
  adjustWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWalletAdjustmentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.walletAdjustmentsService.adjust(id, dto, admin);
  }

  @Get(':id/wallet-adjustments')
  @RequirePermissions(Permission.WALLET_ADJUST)
  getWalletAdjustments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.walletAdjustmentsService.list(id, pagination);
  }

  @Patch(':id/role')
  async updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    const user = await this.usersService.updateRole(id, dto.role);
    return this.toResponse(user);
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    const user = await this.usersService.updateStatus(id, dto.status);
    return this.toResponse(user);
  }

  /** Maps a User row to its response shape — the raw avatar key is replaced by a per-request playback URL. */
  private toResponse(user: User, wallet?: WalletSummary): UserResponseDto {
    return UserResponseDto.fromEntity(
      user,
      this.usersService.avatarUrlFor(user.avatar),
      wallet,
    );
  }
}
