import type { Permission } from '../permission-catalogue';

/** Wire shape of every /roles route that returns a role. */
export class AppRoleResponseDto {
  id: string;
  /** Immutable identifier; the four built-ins use the `Role` enum members. */
  key: string;
  name: string;
  description: string | null;
  /** Built-in role: cannot be deleted, key cannot change. */
  isSystem: boolean;
  /** SUPER_ADMIN: permissions are read-only too (always the full catalogue). */
  isProtected: boolean;
  /** Granted permissions, always in catalogue order. */
  permissions: Permission[];
  /** Accounts resolving to this role — explicit assignments plus, for system roles, the NULL-appRoleId fallback. */
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}
