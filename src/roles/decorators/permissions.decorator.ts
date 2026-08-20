import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../permission-catalogue';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Restricts a route to callers whose role carries ALL of the given
 * permissions. Called with no arguments it means "authenticated only" and
 * overrides a class-level requirement (see UsersController's /users/me).
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
