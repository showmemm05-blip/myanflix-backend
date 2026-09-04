import type { Role, User, UserStatus } from '../../generated/prisma/client';
import type { WalletSummary } from '../users.service';
import type { LevelDto } from '../../levels/levels.service';

export class UserResponseDto {
  id: string;
  username: string;
  phone: string | null;
  /**
   * Cosmetic, user-editable name (PATCH /users/me). Null when unset — the
   * client falls back to username/phone for display. Never a login identity.
   */
  displayName: string | null;
  /**
   * Per-request playback URL for the user's profile picture (or null). The
   * raw `avatar` object key is never exposed — callers pass the computed URL
   * in (see UsersService.avatarUrlFor).
   */
  avatarUrl: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Effective permission set — only populated on GET /users/me, which is how
   * the admin app learns what to render. Everything else keeps the plain
   * profile shape.
   */
  permissions?: string[];
  /** Display name of the caller's effective role (AppRole.name). */
  roleName?: string;
  balance?: number;
  totalDeposited?: number;
  totalSpent?: number;
  isSubscribed?: boolean;
  subscriptionExpiresAt?: Date | null;
  /**
   * Resolved membership level — ADDITIVE, populated only on the admin list
   * (GET /users), where the table renders the level icon per row. Null when
   * no enabled level qualifies; absent everywhere else (the detail page
   * uses GET /users/:id/level for the full status instead).
   */
  level?: LevelDto | null;

  static fromEntity(
    user: User,
    avatarUrl: string | null,
    wallet?: WalletSummary,
  ): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.phone = user.phone;
    dto.displayName = user.displayName;
    dto.avatarUrl = avatarUrl;
    dto.role = user.role;
    dto.status = user.status;
    dto.createdAt = user.createdAt;
    dto.updatedAt = user.updatedAt;
    if (wallet) {
      dto.balance = wallet.balance;
      dto.totalDeposited = wallet.totalDeposited;
      dto.totalSpent = wallet.totalSpent;
      dto.isSubscribed = wallet.isSubscribed;
      dto.subscriptionExpiresAt = wallet.subscriptionExpiresAt;
    }
    return dto;
  }
}
