import type { Role, User, UserStatus } from '../../generated/prisma/client';

/** The AppRole columns the staff list needs, as selected by StaffService. */
export interface StaffAppRole {
  id: string;
  key: string;
  name: string;
}

export type StaffUser = User & { appRole: StaffAppRole | null };

export class StaffResponseDto {
  id: string;
  username: string;
  /**
   * Cosmetic, user-editable name. Null when unset (true for every staff
   * account today) — the client falls back to username. Never a login identity.
   */
  displayName: string | null;
  /** Coarse account kind — kept for every existing caller. */
  role: Role;
  /** Granular RBAC assignment (null only for accounts still on the enum fallback). */
  appRoleId: string | null;
  appRoleKey: string | null;
  appRoleName: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;

  static fromEntity(user: StaffUser): StaffResponseDto {
    const dto = new StaffResponseDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.displayName = user.displayName;
    dto.role = user.role;
    dto.appRoleId = user.appRole?.id ?? user.appRoleId;
    dto.appRoleKey = user.appRole?.key ?? null;
    dto.appRoleName = user.appRole?.name ?? null;
    dto.status = user.status;
    dto.lastLoginAt = user.lastLoginAt;
    dto.createdAt = user.createdAt;
    return dto;
  }
}
