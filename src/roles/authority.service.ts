import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Permission } from './permission-catalogue';
import type { PermissionSubject } from './permission-resolver.service';
import { PermissionResolverService } from './permission-resolver.service';
import { isSystemRoleKey } from './system-roles.seed';

/** The permission that lets someone hand out permissions. */
const ROLES_EDIT: Permission = 'ROLES.EDIT';

/** An account being changed: its id plus both axes of its current assignment. */
export interface AuthoritySubject extends PermissionSubject {
  id: string;
}

/**
 * The two escalation principles the whole RBAC surface is held to, in one
 * place so every path that confers authority is a thin call rather than its
 * own hand-rolled check.
 *
 * **P1 — grant ceiling** (`assertCanGrant` / `assertCanRevoke`): nobody may
 * hand out, or take away, authority they do not themselves hold. Applied in
 * both directions of every permission diff: role create/edit, and what an
 * account gains or loses when a role is assigned to it. Checking only the
 * incoming set let a ROLES.EDIT holder hollow out the built-in Admin role
 * (F-004). The protected role resolves to every permission, so a Super Admin
 * is never affected by it.
 *
 * **P2 — tier protection** (`assertActorIsSuperAdmin`): only a holder of the
 * protected Super Admin role may create, become, assign or modify a
 * Super Admin-tier account. "Actor is a Super Admin" is read off the
 * EFFECTIVE role (an account whose `role` enum still says SUPER_ADMIN but
 * that has been moved onto a narrow AppRole is not one), while "target is
 * Super Admin-tier" is read off EITHER axis — both directions err safe.
 *
 * It also owns the two lockout guards, because both must agree with the
 * resolver on what "is a Super Admin" and "can manage roles" mean:
 * `assertNotLastActiveSuperAdmin` and `assertNotLastRoleManagerAccount`.
 */
@Injectable()
export class AuthorityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
  ) {}

  /**
   * P1. Refuses (403) unless every permission being conferred is already in
   * the actor's own effective set.
   */
  async assertCanGrant(
    actor: PermissionSubject,
    permissions: readonly string[],
  ): Promise<void> {
    await this.assertHeld(actor, permissions, 'grant');
  }

  /**
   * P1, the other direction. Refuses (403) unless every permission being
   * taken away is already in the actor's own effective set — F-004: the
   * ceiling used to look only at what was added, so an empty save stripped
   * everything, permissions the editor never held included.
   */
  async assertCanRevoke(
    actor: PermissionSubject,
    permissions: readonly string[],
  ): Promise<void> {
    await this.assertHeld(actor, permissions, 'remove');
  }

  private async assertHeld(
    actor: PermissionSubject,
    permissions: readonly string[],
    verb: 'grant' | 'remove',
  ): Promise<void> {
    if (permissions.length === 0) return;

    const held = await this.resolver.permissionsFor(actor);
    const missing = permissions.filter(
      (permission) => !held.has(permission as Permission),
    );
    if (missing.length === 0) return;

    throw new ForbiddenException(
      `You cannot ${verb} permissions you do not have yourself: ${missing.join(', ')}.`,
    );
  }

  /** P2. Refuses (403) unless the actor holds the protected Super Admin role. */
  async assertActorIsSuperAdmin(actor: PermissionSubject): Promise<void> {
    if (await this.isEffectiveSuperAdmin(actor)) return;
    throw new ForbiddenException(
      'Only a Super Admin can create or change a Super Admin account.',
    );
  }

  /**
   * The effective axis: does this assignment resolve to the protected role?
   * Mirrors the resolver's "a missing seed must not brick the only account
   * that could repair it" fallback, so the two never disagree.
   */
  async isEffectiveSuperAdmin(subject: PermissionSubject): Promise<boolean> {
    const role = await this.resolver.resolveForUser(subject);
    if (role) return role.isProtected;
    return subject.role === Role.SUPER_ADMIN;
  }

  /**
   * Target-side tier test: an account is Super Admin-tier if EITHER axis says
   * so — the legacy enum or an assigned protected AppRole. Deliberately wider
   * than `isEffectiveSuperAdmin`: for "who may I touch?" the safe answer is
   * "if in doubt, it's protected".
   */
  async isSuperAdminTier(subject: PermissionSubject): Promise<boolean> {
    if (subject.role === Role.SUPER_ADMIN) return true;
    return this.isEffectiveSuperAdmin(subject);
  }

  /**
   * P1 + P2 for every path that assigns a role to an account: creating staff,
   * changing a staff member's role, and PATCH /users/:id/role. Handing someone
   * a role hands them its whole permission set, so the set goes through the
   * grant ceiling exactly as a role edit does.
   *
   * With `current` (the account's present assignment) the move is also held
   * to the revoke ceiling: whatever the account loses must be held by the
   * actor too (F-004). Without it — a brand-new account — there is nothing
   * to lose and behaviour is unchanged.
   */
  async assertCanAssignRole(
    actor: PermissionSubject,
    assignment: PermissionSubject,
    current?: PermissionSubject,
  ): Promise<void> {
    if (await this.isSuperAdminTier(assignment)) {
      await this.assertActorIsSuperAdmin(actor);
    }
    const role = await this.resolver.resolveForUser(assignment);
    const after = role?.permissions ?? new Set<Permission>();
    await this.assertCanGrant(actor, [...after]);

    if (!current) return;
    const before = await this.resolver.permissionsFor(current);
    await this.assertCanRevoke(
      actor,
      [...before].filter((permission) => !after.has(permission)),
    );
  }

  /**
   * Refuses (409) a change that would leave nobody holding the protected role.
   *
   * Counts on the EFFECTIVE axis — an account assigned the protected AppRole,
   * or one still on the NULL fallback path whose `role` enum is SUPER_ADMIN.
   * Counting the enum alone used to let a custom AppRole assignment strip the
   * last real Super Admin while the guard looked the other way.
   */
  async assertNotLastActiveSuperAdmin(excludeUserId: string): Promise<void> {
    const protectedRoles = await this.prisma.appRole.findMany({
      where: { isProtected: true },
      select: { id: true },
    });

    const others = await this.prisma.user.count({
      where: {
        status: UserStatus.ACTIVE,
        NOT: { id: excludeUserId },
        OR: [
          { appRoleId: { in: protectedRoles.map((role) => role.id) } },
          { appRoleId: null, role: Role.SUPER_ADMIN },
        ],
      },
    });

    if (others === 0) {
      throw new ConflictException(
        'At least one active Super Admin must remain.',
      );
    }
  }

  /**
   * The account-axis twin of RolesService's `assertNotLastRoleManager`: that
   * one stops a matrix save from stripping ROLES.EDIT off the last role, this
   * one stops the last account that holds such a role from being suspended,
   * deleted or reassigned away from it. Both mean the same thing by "can
   * manage roles" — a protected role, or one granting ROLES.EDIT — and both
   * only block when no OTHER active member of any such role remains.
   *
   * `next` is the assignment the account is moving to, or null when it is
   * losing its access outright (suspend/delete).
   */
  async assertNotLastRoleManagerAccount(
    target: AuthoritySubject,
    next: PermissionSubject | null,
  ): Promise<void> {
    if (!(await this.resolver.can(target, ROLES_EDIT))) return;
    if (next && (await this.resolver.can(next, ROLES_EDIT))) return;

    const roles = await this.prisma.appRole.findMany({
      where: {
        OR: [
          { isProtected: true },
          { permissions: { some: { permission: ROLES_EDIT } } },
        ],
      },
      select: { id: true, key: true, isSystem: true },
    });

    // Built-in roles also answer for accounts still on the NULL fallback path.
    const fallbackKeys = roles
      .filter((role) => role.isSystem && isSystemRoleKey(role.key))
      .map((role) => role.key as Role);

    const others = await this.prisma.user.count({
      where: {
        status: UserStatus.ACTIVE,
        NOT: { id: target.id },
        OR: [
          { appRoleId: { in: roles.map((role) => role.id) } },
          ...(fallbackKeys.length > 0
            ? [{ appRoleId: null, role: { in: fallbackKeys } }]
            : []),
        ],
      },
    });

    if (others === 0) {
      throw new ConflictException(
        'This is the last account that can manage roles. Give another active account a role with Roles > Edit first.',
      );
    }
  }

  /**
   * The status-change gate shared by PATCH /staff/:id/status and
   * PATCH /users/:id/status (F-001: the users route used to skip every one of
   * these). In order: nobody changes their own status (403); a Super
   * Admin-tier target is only a Super Admin's to touch, in either direction
   * (P2, 403); and any move away from ACTIVE — SUSPENDED or BANNED alike —
   * runs both lockout guards (409). The 409s are defence in depth: an active
   * Super Admin actor always counts as a remaining one, so they only fire on
   * inconsistent data.
   */
  async assertCanChangeStatus(
    actor: AuthoritySubject,
    target: AuthoritySubject,
    nextStatus: UserStatus,
  ): Promise<void> {
    if (target.id === actor.id) {
      throw new ForbiddenException('You cannot deactivate your own account.');
    }

    if (await this.isSuperAdminTier(target)) {
      await this.assertActorIsSuperAdmin(actor);
    }

    if (nextStatus !== UserStatus.ACTIVE) {
      if (await this.isEffectiveSuperAdmin(target)) {
        await this.assertNotLastActiveSuperAdmin(target.id);
      }
      // F8: suspending the last roles manager locks everyone out just as
      // effectively as stripping the permission would.
      await this.assertNotLastRoleManagerAccount(target, null);
    }
  }

  /**
   * A single permission the caller must hold for this particular request,
   * where a decorator cannot express it because the answer depends on the
   * body (publishing vs unpublishing through a shared edit route).
   */
  async assertHas(
    actor: PermissionSubject,
    permission: Permission,
    message: string,
  ): Promise<void> {
    if (await this.resolver.can(actor, permission)) return;
    throw new ForbiddenException(message);
  }
}
