import { Injectable } from '@nestjs/common';
import { Role } from '../generated/prisma/client';
import { ROLE_PERMISSIONS } from './role-permissions.map';

export interface RolePermissions {
  role: Role;
  permissions: string[];
}

@Injectable()
export class RolesService {
  /** Returns the fixed role -> permission matrix for the admin RBAC screen. */
  getRolePermissionMatrix(): RolePermissions[] {
    return Object.values(Role).map((role) => ({
      role,
      permissions: ROLE_PERMISSIONS[role],
    }));
  }
}
