import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permission.enum';

export const PERMISSIONS_KEY = 'permissions';

/** Restricts a route to callers whose role carries all given permissions. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
