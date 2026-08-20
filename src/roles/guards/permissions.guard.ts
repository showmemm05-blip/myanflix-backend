import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { Permission } from '../permission-catalogue';
import { PermissionResolverService } from '../permission-resolver.service';

/**
 * Authorizes a request against the caller's DB-backed permission set.
 *
 * The set comes from PermissionResolverService (cached per role, invalidated
 * on every role edit), so changing a role's permissions in the admin takes
 * effect on the next request — no redeploy, no re-login. SUPER_ADMIN is
 * short-circuited inside the resolver to every permission.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const grantedPermissions = await this.resolver.permissionsFor(user);
    const hasAll = requiredPermissions.every((permission) =>
      grantedPermissions.has(permission),
    );

    if (!hasAll) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }

    return true;
  }
}
