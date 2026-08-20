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
import { RequirePermissions } from '../roles/decorators/permissions.decorator';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { WalletAdjustmentsService } from '../wallet/wallet-adjustments.service';
import { CreateWalletAdjustmentDto } from '../wallet/dto/create-wallet-adjustment.dto';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UsersQueryDto } from './dto/users-query.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import type { User } from '../generated/prisma/client';
import { UserResponseDto } from './dto/user-response.dto';
import { UserRelationshipsQueryDto } from './dto/user-relationships-query.dto';
import { UserRelationshipsService } from './user-relationships.service';
import { PermissionResolverService } from '../roles/permission-resolver.service';
import { UsersService, type WalletSummary } from './users.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * The old single USER_MANAGE bundle is split per route: reads need
 * USERS.VIEW, the role change needs USERS.EDIT, activate/suspend needs
 * USERS.SUSPEND and balance corrections keep their own USERS.WALLET_ADJUST.
 * The class-level rule stays as the fail-safe floor for any route that
 * forgets to state its own.
 */
@Controller('users')
@UseGuards(PermissionsGuard)
@RequirePermissions('USERS.VIEW')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly moviesService: MoviesService,
    private readonly videosService: VideosService,
    private readonly walletAdjustmentsService: WalletAdjustmentsService,
    private readonly userRelationshipsService: UserRelationshipsService,
    private readonly permissionResolver: PermissionResolverService,
  ) {}

  /**
   * Every authenticated role can read their own profile — overrides the
   * class-level USERS.VIEW requirement with an empty permission list.
   * Registered before ':id' so "me" is never parsed as a user UUID.
   */
  @Get('me')
  @RequirePermissions()
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.buildMeResponse(user);
  }

  /**
   * Self-service profile edit — same empty-permission override as GET me and
   * the avatar routes: editing your OWN profile must never require an admin
   * permission. Only `displayName` is writable (see UpdateProfileDto);
   * username and phone are login identities and stay read-only.
   *
   * Responds with the full GET /users/me shape (profile + wallet +
   * permissions + roleName) so the client can replace its stored user object
   * wholesale instead of merging fields.
   */
  @Patch('me')
  @RequirePermissions()
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    await this.usersService.updateProfile(user.id, dto);
    return this.buildMeResponse(user);
  }

  /**
   * Self-service password change. Auth-only, like the routes above. Other
   * sessions are deliberately left signed in — revoking refresh tokens on a
   * password change is out of scope here.
   */
  @Patch('me/password')
  @RequirePermissions()
  async changeMyPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.usersService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    return { changed: true };
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
  @RequirePermissions('USERS.VIEW')
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
   * Read-only phone-number relationship network for the admin graph. Runs on
   * USERS.VIEW — the same permission the rest of the admin Users page reads
   * with. Registered before ':id' so "relationships" is
   * never parsed as a user UUID.
   */
  @Get('relationships')
  @RequirePermissions('USERS.VIEW')
  getRelationships(@Query() query: UserRelationshipsQueryDto) {
    return this.userRelationshipsService.getNetwork(query.phone);
  }

  @Get(':id')
  @RequirePermissions('USERS.VIEW')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const [user, wallet] = await Promise.all([
      this.usersService.findByIdOrThrow(id),
      this.usersService.getWalletSummary(id),
    ]);
    return this.toResponse(user, wallet);
  }

  @Get(':id/purchases')
  @RequirePermissions('USERS.VIEW')
  getPurchases(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.moviesService.getPurchasesForUser(id, pagination);
  }

  @Get(':id/watch-history')
  @RequirePermissions('USERS.VIEW')
  getWatchHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.videosService.getWatchHistoryForUser(id, pagination);
  }

  /**
   * Stricter than the class-level USERS.VIEW — USERS.WALLET_ADJUST is
   * seeded to SUPER_ADMIN only, so the method-level override keeps regular
   * admins out of balance corrections. Deliberately not USERS.VIEW on the
   * GET either: the adjustment history is part of the same sensitive
   * surface as making one.
   */
  @Post(':id/wallet-adjustments')
  @RequirePermissions('USERS.WALLET_ADJUST')
  adjustWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWalletAdjustmentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.walletAdjustmentsService.adjust(id, dto, admin);
  }

  @Get(':id/wallet-adjustments')
  @RequirePermissions('USERS.WALLET_ADJUST')
  getWalletAdjustments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationQueryDto,
  ) {
    return this.walletAdjustmentsService.list(id, pagination);
  }

  @Patch(':id/role')
  @RequirePermissions('USERS.EDIT')
  async updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const user = await this.usersService.updateRole(id, dto.role, actor);
    return this.toResponse(user);
  }

  @Patch(':id/status')
  @RequirePermissions('USERS.SUSPEND')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    const user = await this.usersService.updateStatus(id, dto.status);
    return this.toResponse(user);
  }

  /**
   * The "my profile" payload shared by GET /users/me and PATCH /users/me:
   * profile + wallet summary + the caller's effective permission set.
   */
  private async buildMeResponse(
    user: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    const [profile, wallet, appRole] = await Promise.all([
      this.usersService.findByIdOrThrow(user.id),
      this.usersService.getWalletSummary(user.id),
      this.permissionResolver.resolveForUser(user),
    ]);
    const response = this.toResponse(profile, wallet);
    // The admin app renders entirely off these two fields — never off the
    // role name — so a permission change shows up on the next page load.
    response.permissions = appRole ? [...appRole.permissions] : [];
    response.roleName = appRole?.name ?? profile.role;
    return response;
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
