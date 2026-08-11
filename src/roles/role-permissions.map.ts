import { Role } from '../generated/prisma/client';
import { Permission } from './permission.enum';

const ALL_PERMISSIONS = Object.values(Permission);

/**
 * Static Role -> Permission[] mapping. There is no admin UI for editing this
 * at runtime — permissions are a fixed property of each role, matching the
 * fixed roles the platform supports.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.SUPER_ADMIN]: ALL_PERMISSIONS,
  [Role.ADMIN]: [
    Permission.MOVIE_CREATE,
    Permission.MOVIE_UPDATE,
    Permission.MOVIE_DELETE,
    Permission.VIDEO_UPLOAD,
    Permission.DEPOSIT_MANAGE,
    Permission.WITHDRAWAL_MANAGE,
    Permission.SUBTITLE_MANAGE,
    Permission.SERIES_MANAGE,
    Permission.SUBSCRIPTION_MANAGE,
  ],
  // Content ingestion only — no MOVIE_DELETE (least privilege; the role's
  // pages only ever offer create/edit), no USER_MANAGE/FINANCE_VIEW/
  // DEPOSIT_MANAGE. Note SERIES_MANAGE also covers series delete and
  // MOVIE_CREATE/UPDATE also cover category management at the raw-API level
  // (neither permission is split finer than that today) — same bundling
  // ADMIN already has; the admin UI for both stays hidden from this role.
  [Role.CONTENT_UPLOADER]: [
    Permission.MOVIE_CREATE,
    Permission.MOVIE_UPDATE,
    Permission.VIDEO_UPLOAD,
    Permission.SUBTITLE_MANAGE,
    Permission.SERIES_MANAGE,
  ],
  [Role.USER]: [],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
