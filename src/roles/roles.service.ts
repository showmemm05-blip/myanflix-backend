import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AuthorityService } from './authority.service';
import type { AppRoleResponseDto } from './dto/app-role-response.dto';
import type { CreateAppRoleDto } from './dto/create-app-role.dto';
import type { UpdateAppRoleDto } from './dto/update-app-role.dto';
import type { Permission } from './permission-catalogue';
import {
  ALL_PERMISSIONS,
  getPermissionCatalogue,
  normalizePermissions,
} from './permission-catalogue';
import { PermissionResolverService } from './permission-resolver.service';
import { isSystemRoleKey } from './system-roles.seed';
import { AuditService } from '../audit/audit.service';
import { roleSnapshot } from '../audit/audit-snapshots';

/** The permission that lets someone edit roles — the one the lockout guard protects. */
const ROLES_EDIT: Permission = 'ROLES.EDIT';

const ROLE_INCLUDE = {
  permissions: { select: { permission: true } },
} as const;

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isProtected: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: { permission: string }[];
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
    private readonly authority: AuthorityService,
    private readonly audit: AuditService,
  ) {}

  /** Module/action tree for the permission matrix UI. */
  getCatalogue() {
    return {
      modules: getPermissionCatalogue(),
      permissions: ALL_PERMISSIONS,
    };
  }

  async findAll(): Promise<{ items: AppRoleResponseDto[] }> {
    const roles = await this.prisma.appRole.findMany({
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      include: ROLE_INCLUDE,
    });
    const counts = await this.countUsersByRole(roles);
    return {
      items: roles.map((role) =>
        this.toResponse(role, counts.get(role.id) ?? 0),
      ),
    };
  }

  async findOne(id: string): Promise<AppRoleResponseDto> {
    const role = await this.findByIdOrThrow(id);
    return this.toResponse(role, await this.countUsers(role));
  }

  /**
   * A new role may not exceed its creator (P1) — otherwise ROLES.CREATE alone
   * is a self-service escalation: mint a role holding everything, then have
   * someone assigned to it.
   */
  async create(
    dto: CreateAppRoleDto,
    actor: AuthenticatedUser,
  ): Promise<AppRoleResponseDto> {
    const name = dto.name.trim();
    const permissions = normalizePermissions(dto.permissions ?? []);
    await this.authority.assertCanGrant(actor, permissions);

    const key = await this.deriveUniqueKey(name);

    const role = await this.prisma.appRole.create({
      data: {
        key,
        name,
        description: dto.description?.trim() || null,
        isSystem: false,
        isProtected: false,
        permissions: {
          create: permissions.map((permission) => ({ permission })),
        },
      },
      include: ROLE_INCLUDE,
    });

    // A brand-new id can't be cached yet, but a key collision with a
    // previously-deleted role could be — cheap insurance.
    this.resolver.invalidate(role.id);
    await this.audit.record({
      action: 'role.create',
      actor,
      target: { type: 'role', id: role.id, label: role.name },
      after: roleSnapshot(role),
    });
    return this.toResponse(role, 0);
  }

  /** Rename / re-describe. The protected role is read-only; `key` never changes. */
  async update(
    id: string,
    dto: UpdateAppRoleDto,
    actor: AuthenticatedUser,
  ): Promise<AppRoleResponseDto> {
    const existing = await this.findByIdOrThrow(id);
    this.assertNotProtected(existing);

    const updated = await this.prisma.appRole.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.description !== undefined && {
          description: dto.description.trim() || null,
        }),
      },
      include: ROLE_INCLUDE,
    });

    this.resolver.invalidate(id);
    await this.audit.record({
      action: 'role.update',
      actor,
      target: { type: 'role', id, label: updated.name },
      before: roleSnapshot(existing),
      after: roleSnapshot(updated),
    });
    return this.toResponse(updated, await this.countUsers(updated));
  }

  /**
   * Replaces a role's whole permission set (the matrix save). Diffed against
   * what is stored so unchanged rows are left alone, then the resolver cache
   * for this role is dropped — the change is live on the next request.
   *
   * The guards run in this order, and the order decides which message the
   * user sees when several would fail:
   *  1. the protected role is read-only (409);
   *  2. a built-in role's permissions are only a Super Admin's to change
   *     (403) — built-ins are the fallback for every legacy account, so a
   *     change there reaches accounts the editor may never touch;
   *  3. the actor may not edit the role they are themselves assigned to
   *     (403 — otherwise a one-request self-promotion to anything);
   *  4. the ceiling on the DIFF (P1, 403): nothing may be added, and nothing
   *     may be removed, that the actor does not hold. Checking only the
   *     incoming set let a small ROLES.EDIT holder strip the built-in Admin
   *     role bare (F-004).
   * Then the lockout guard (409) refuses stripping ROLES.EDIT from the last
   * role that can reach it.
   */
  async replacePermissions(
    id: string,
    permissions: string[],
    actor: AuthenticatedUser,
  ): Promise<AppRoleResponseDto> {
    const existing = await this.findByIdOrThrow(id);
    this.assertNotProtected(existing);
    await this.assertSystemRoleEditableBy(existing, actor);
    await this.assertNotOwnRole(existing, actor);

    const next = normalizePermissions(permissions);
    const current = new Set(existing.permissions.map((p) => p.permission));
    const wanted = new Set<string>(next);
    const toAdd = next.filter((permission) => !current.has(permission));
    const toRemove = [...current].filter(
      (permission) => !wanted.has(permission),
    );

    // Grant before revoke: the grant message is the one the F4 specs pin.
    await this.authority.assertCanGrant(actor, toAdd);
    await this.authority.assertCanRevoke(actor, toRemove);
    await this.assertNotLastRoleManager(existing, next);

    if (toAdd.length > 0 || toRemove.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.appRolePermission.deleteMany({
          where: { roleId: id, permission: { in: toRemove } },
        });
        await tx.appRolePermission.createMany({
          data: toAdd.map((permission) => ({ roleId: id, permission })),
          skipDuplicates: true,
        });
        await tx.appRole.update({
          where: { id },
          data: { updatedAt: new Date() },
        });
        // Committed with the permission rows — or rolled back with them.
        await this.audit.record({
          action: 'role.permissions_change',
          actor,
          target: { type: 'role', id, label: existing.name },
          before: roleSnapshot(existing),
          after: roleSnapshot({ ...existing, permissions: next }),
          metadata: { added: toAdd, removed: toRemove },
          tx,
        });
      });
    }

    this.resolver.invalidate(id);
    const updated = await this.findByIdOrThrow(id);
    return this.toResponse(updated, await this.countUsers(updated));
  }

  /** Only custom roles with nobody assigned can go. Everything else is a 409. */
  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const existing = await this.findByIdOrThrow(id);

    if (existing.isSystem) {
      throw new ConflictException(
        'Built-in roles cannot be deleted. A Super Admin can change their permissions instead.',
      );
    }

    const userCount = await this.countUsers(existing);
    if (userCount > 0) {
      throw new ConflictException(
        `This role is assigned to ${userCount} account${userCount === 1 ? '' : 's'}. Move them to another role first.`,
      );
    }

    await this.prisma.appRole.delete({ where: { id } });
    this.resolver.invalidate(id);
    await this.audit.record({
      action: 'role.delete',
      actor,
      target: { type: 'role', id, label: existing.name },
      before: roleSnapshot(existing),
    });
  }

  private async findByIdOrThrow(id: string): Promise<RoleRow> {
    const role = await this.prisma.appRole.findUnique({
      where: { id },
      include: ROLE_INCLUDE,
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  /**
   * Editing your own role is editing your own authority. Whatever the actor is
   * missing, a ROLES.EDIT holder could otherwise tick the box for themselves —
   * so the change has to come from somebody else.
   */
  private async assertNotOwnRole(
    role: RoleRow,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const own = await this.resolver.resolveForUser(actor);
    if (own?.id !== role.id) return;
    throw new ForbiddenException(
      'You cannot change the permissions of the role you are assigned to. Ask another administrator.',
    );
  }

  private assertNotProtected(role: RoleRow): void {
    if (role.isProtected) {
      throw new ConflictException(
        'The Super Admin role is protected — its name and permissions cannot be changed.',
      );
    }
  }

  /**
   * F-004: what a built-in role may do is only a Super Admin's to change.
   * Built-ins are the NULL-appRoleId fallback for legacy accounts (see
   * `countUsers`), so an edit there reaches accounts the editor may never be
   * allowed to touch. Renaming stays open — a label confers nothing.
   */
  private async assertSystemRoleEditableBy(
    role: RoleRow,
    actor: AuthenticatedUser,
  ): Promise<void> {
    if (!role.isSystem) return;
    if (await this.authority.isEffectiveSuperAdmin(actor)) return;
    throw new ForbiddenException(
      'Only a Super Admin can change the permissions of a built-in role.',
    );
  }

  /**
   * Lockout guard (role axis; AuthorityService.assertNotLastRoleManagerAccount
   * is its account-axis twin): refuses a save that would strip ROLES.EDIT
   * from the last role that can actually reach it — i.e. no other role that still grants it
   * (or is protected, which implies it) has an active account assigned.
   * Without this, one matrix save could leave the platform with nobody able
   * to grant permissions back.
   */
  private async assertNotLastRoleManager(
    role: RoleRow,
    nextPermissions: Permission[],
  ): Promise<void> {
    const hadRolesEdit = role.permissions.some(
      (p) => p.permission === ROLES_EDIT,
    );
    if (!hadRolesEdit) return;
    if (nextPermissions.includes(ROLES_EDIT)) return;

    const others = await this.prisma.appRole.findMany({
      where: {
        id: { not: role.id },
        OR: [
          { isProtected: true },
          { permissions: { some: { permission: ROLES_EDIT } } },
        ],
      },
      select: { id: true, key: true, isSystem: true },
    });

    for (const other of others) {
      if ((await this.countUsers(other, UserStatus.ACTIVE)) > 0) return;
    }

    throw new ConflictException(
      'This is the last role that can manage roles. Grant Roles > Edit to another role with an active member first.',
    );
  }

  /**
   * Accounts that resolve to this role: explicit `appRoleId` assignments plus,
   * for the built-ins, accounts still on the NULL fallback path (their `role`
   * enum decides). Used for the response `userCount`, the delete guard and the
   * lockout guard, so all three agree on what "assigned" means.
   */
  private async countUsers(
    role: { id: string; key: string; isSystem: boolean },
    status?: UserStatus,
  ): Promise<number> {
    const statusFilter = status ? { status } : {};
    const explicit = await this.prisma.user.count({
      where: { appRoleId: role.id, ...statusFilter },
    });
    if (!role.isSystem || !isSystemRoleKey(role.key)) return explicit;

    const fallback = await this.prisma.user.count({
      where: { appRoleId: null, role: role.key, ...statusFilter },
    });
    return explicit + fallback;
  }

  private async countUsersByRole(
    roles: { id: string; key: string; isSystem: boolean }[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const role of roles) {
      counts.set(role.id, await this.countUsers(role));
    }
    return counts;
  }

  /** "Movie Manager" -> MOVIE_MANAGER, suffixed until unique. */
  private async deriveUniqueKey(name: string): Promise<string> {
    const base =
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'ROLE';

    let candidate = base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const clash = await this.prisma.appRole.findUnique({
        where: { key: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
      candidate = `${base}_${suffix}`;
    }
    throw new ConflictException(
      'Could not derive a unique key for this role name. Try a different name.',
    );
  }

  private toResponse(role: RoleRow, userCount: number): AppRoleResponseDto {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      isProtected: role.isProtected,
      // The protected role always holds everything (the resolver short-circuits
      // it), so report that rather than whatever rows happen to be stored.
      permissions: role.isProtected
        ? [...ALL_PERMISSIONS]
        : normalizePermissions(role.permissions.map((p) => p.permission)),
      userCount,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }
}
