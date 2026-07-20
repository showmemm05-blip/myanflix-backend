import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { Permission } from '../permission.enum';
import { ROLE_PERMISSIONS } from '../role-permissions.map';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const grantedPermissions = ROLE_PERMISSIONS[user.role];
    const hasAll = requiredPermissions.every((permission) =>
      grantedPermissions.includes(permission),
    );

    if (!hasAll) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }

    return true;
  }
}
