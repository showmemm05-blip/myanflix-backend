import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../generated/prisma/client';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { RequirePermissions } from '../decorators/permissions.decorator';
import type { Permission } from '../permission-catalogue';
import type { PermissionResolverService } from '../permission-resolver.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * A stand-in controller carrying the same decorator shapes the real ones use:
 * a class-level default, a stricter method-level override, a multi-permission
 * route, and the empty "authenticated only" override (/users/me's pattern).
 */
@RequirePermissions('USERS.VIEW')
class TestController {
  listUsers() {}

  @RequirePermissions('USERS.SUSPEND')
  suspendUser() {}

  @RequirePermissions('USERS.EDIT', 'STAFF.EDIT')
  promoteUser() {}

  @RequirePermissions()
  me() {}
}

class UndecoratedController {
  ping() {}
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let granted: Set<Permission>;

  const user: AuthenticatedUser = {
    id: 'user-1',
    username: 'boss',
    role: Role.ADMIN,
    appRoleId: 'role-1',
  };

  const resolver = {
    permissionsFor: jest.fn(async () => granted as ReadonlySet<Permission>),
  } as unknown as PermissionResolverService;

  const contextFor = (
    target: object,
    handler: (...args: unknown[]) => unknown,
    currentUser: AuthenticatedUser | null = user,
  ): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => target,
      switchToHttp: () => ({
        getRequest: () => ({ user: currentUser ?? undefined }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    granted = new Set<Permission>();
    guard = new PermissionsGuard(new Reflector(), resolver);
  });

  it('allows a route with no permission metadata at all', async () => {
    await expect(
      guard.canActivate(
        contextFor(UndecoratedController, UndecoratedController.prototype.ping),
      ),
    ).resolves.toBe(true);
  });

  it('allows the empty @RequirePermissions() override (authenticated only)', async () => {
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.me),
      ),
    ).resolves.toBe(true);
  });

  it('allows a route whose class-level permission the caller holds', async () => {
    granted.add('USERS.VIEW');

    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.listUsers),
      ),
    ).resolves.toBe(true);
  });

  it('denies a route whose class-level permission the caller lacks', async () => {
    granted.add('MOVIES.VIEW');

    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.listUsers),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses the method-level override instead of the class default', async () => {
    granted.add('USERS.VIEW');

    // Holds the class default but not the route's own stricter permission.
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.suspendUser),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    granted.add('USERS.SUSPEND');
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.suspendUser),
      ),
    ).resolves.toBe(true);
  });

  it('requires ALL listed permissions, not any of them', async () => {
    granted.add('USERS.EDIT');

    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.promoteUser),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    granted.add('STAFF.EDIT');
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.promoteUser),
      ),
    ).resolves.toBe(true);
  });

  it('rejects a guarded request that somehow carries no authenticated user', async () => {
    granted.add('USERS.VIEW');

    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.listUsers, null),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reflects a permission revoked between two requests (no re-login needed)', async () => {
    granted.add('USERS.VIEW');
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.listUsers),
      ),
    ).resolves.toBe(true);

    granted.delete('USERS.VIEW');
    await expect(
      guard.canActivate(
        contextFor(TestController, TestController.prototype.listUsers),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
