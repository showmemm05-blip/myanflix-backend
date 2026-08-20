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
    return this.toResponse(role, 0);
  }

  /** Rename / re-describe. The protected role is read-only; `key` never changes. */
  async update(id: string, dto: UpdateAppRoleDto): Promise<AppRoleResponseDto> {
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
    return this.toResponse(updated, await this.countUsers(updated));
  }

  /**
   * Replaces a role's whole permission set (the matrix save). Diffed against
   * what is stored so unchanged rows are left alone, then the resolver cache
   * for this role is dropped — the change is live on the next request.
   *
   * Two escalation guards run first: the actor may not grant anything they do
   * not hold (P1), and may not edit the role they are themselves assigned to
   * (which would otherwise be a one-request self-promotion to anything).
   */
  async replacePermissions(
    id: string,
    permissions: string[],
    actor: AuthenticatedUser,
  ): Promise<AppRoleResponseDto> {
    const existing = await this.findByIdOrThrow(id);
    this.assertNotProtected(existing);
    await this.assertNotOwnRole(existing, actor);

    const next = normalizePermissions(permissions);
    await this.authority.assertCanGrant(actor, next);
    await this.assertNotLastRoleManager(existing, next);

    const current = new Set(existing.permissions.map((p) => p.permission));
    const wanted = new Set<string>(next);
    const toAdd = next.filter((permission) => !current.has(permission));
    const toRemove = [...current].filter(
      (permission) => !wanted.has(permission),
    );

    if (toAdd.length > 0 || toRemove.length > 0) {
      await this.prisma.$transaction([
        this.prisma.appRolePermission.deleteMany({
          where: { roleId: id, permission: { in: toRemove } },
        }),
        this.prisma.appRolePermission.createMany({
          data: toAdd.map((permission) => ({ roleId: id, permission })),
          skipDuplicates: true,
        }),
        this.prisma.appRole.update({
          where: { id },
          data: { updatedAt: new Date() },
        }),
      ]);
    }

    this.resolver.invalidate(id);
    const updated = await this.findByIdOrThrow(id);
    return this.toResponse(updated, await this.countUsers(updated));
  }

  /** Only custom roles with nobody assigned can go. Everything else is a 409. */
  async remove(id: string): Promise<void> {
    const existing = await this.findByIdOrThrow(id);

    if (existing.isSystem) {
      throw new ConflictException(
        'Built-in roles cannot be deleted. You can edit their permissions instead.',
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
