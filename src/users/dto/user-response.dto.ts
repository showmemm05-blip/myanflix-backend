import type { Role, User, UserStatus } from '../../generated/prisma/client';
import type { WalletSummary } from '../users.service';

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
