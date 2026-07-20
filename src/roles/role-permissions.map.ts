import { Role } from '../generated/prisma/client';
import { Permission } from './permission.enum';

const ALL_PERMISSIONS = Object.values(Permission);

/**
 * Static Role -> Permission[] mapping. There is no admin UI for editing this
 * at runtime — permissions are a fixed property of each role, matching the
 * three fixed roles the platform supports.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.SUPER_ADMIN]: ALL_PERMISSIONS,
  [Role.ADMIN]: [
    Permission.MOVIE_CREATE,
    Permission.MOVIE_UPDATE,
    Permission.MOVIE_DELETE,
    Permission.VIDEO_UPLOAD,
  ],
  [Role.USER]: [],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
