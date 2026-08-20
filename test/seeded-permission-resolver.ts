import type { Role } from '../src/generated/prisma/client';
import type { Permission } from '../src/roles/permission-catalogue';
import { ALL_PERMISSIONS } from '../src/roles/permission-catalogue';
import type {
  PermissionSubject,
  ResolvedRole,
} from '../src/roles/permission-resolver.service';
import { SYSTEM_ROLE_SEEDS } from '../src/roles/system-roles.seed';

/**
 * A PermissionResolverService stand-in backed by the real system-role seeds,
 * for specs that exercise the guard / permission-shaped service branches
 * without a database.
 *
 * Using the seeds (rather than ad-hoc sets) is deliberate: a spec that says
 * "ADMIN is refused here" then keeps proving the seeded ADMIN role really
 * lacks that permission, which is the parity guarantee the migration rests on.
 */
export function seededPermissionsFor(role: Role): ReadonlySet<Permission> {
  const seed = SYSTEM_ROLE_SEEDS.find((candidate) => candidate.key === role);
  if (!seed) return new Set<Permission>();
  return new Set(seed.isProtected ? ALL_PERMISSIONS : seed.permissions);
}

/** One AppRole as a spec fixture — the shape the resolver hands back. */
export interface TestRoleRow {
  id: string;
  key: string;
  name?: string;
  isSystem?: boolean;
  isProtected?: boolean;
  permissions: readonly Permission[];
}

/** A built-in role's real seeded permission set, under whatever id a spec uses. */
export function seededRoleRow(
  role: Role,
  id = `app-role-${role}`,
): TestRoleRow {
  const seed = SYSTEM_ROLE_SEEDS.find((candidate) => candidate.key === role);
  return {
    id,
    key: role,
    name: seed?.name ?? role,
    isSystem: true,
    isProtected: seed?.isProtected ?? false,
    permissions: [...seededPermissionsFor(role)],
  };
}

/**
 * A resolver stand-in that understands `appRoleId`, not just the `Role` enum —
 * needed by every spec that exercises a CUSTOM role, since that is exactly the
 * case the escalation guards exist for. Resolution mirrors the real service:
 * an explicit `appRoleId` wins, an unknown one falls through to the built-in
 * role whose key matches the enum, and a protected role holds everything.
 */
export function createRoleAwarePermissionResolver(rows: TestRoleRow[]) {
  const resolve = (user: PermissionSubject): ResolvedRole | null => {
    const row =
      (user.appRoleId
        ? rows.find((candidate) => candidate.id === user.appRoleId)
        : undefined) ??
      rows.find((candidate) => candidate.key === (user.role as string));
    if (!row) return null;
    return {
      id: row.id,
      key: row.key,
      name: row.name ?? row.key,
      isSystem: row.isSystem ?? false,
      isProtected: row.isProtected ?? false,
      permissions: new Set(
        row.isProtected ? ALL_PERMISSIONS : [...row.permissions],
      ),
    };
  };

  const permissionsFor = jest.fn(
    async (user: PermissionSubject): Promise<ReadonlySet<Permission>> =>
      resolve(user)?.permissions ??
      (user.role === ('SUPER_ADMIN' as Role)
        ? new Set(ALL_PERMISSIONS)
        : new Set<Permission>()),
  );

  return {
    permissionsFor,
    resolveForUser: jest.fn(
      async (user: PermissionSubject): Promise<ResolvedRole | null> =>
        resolve(user),
    ),
    can: jest.fn(async (user: PermissionSubject, permission: Permission) =>
      (await permissionsFor(user)).has(permission),
    ),
    canAny: jest.fn(
      async (user: PermissionSubject, permissions: readonly Permission[]) => {
        const granted = await permissionsFor(user);
        return permissions.some((permission) => granted.has(permission));
      },
    ),
    canAll: jest.fn(
      async (user: PermissionSubject, permissions: readonly Permission[]) => {
        const granted = await permissionsFor(user);
        return permissions.every((permission) => granted.has(permission));
      },
    ),
    invalidate: jest.fn(),
    invalidateAll: jest.fn(),
  };
}

export function createSeededPermissionResolver() {
  const permissionsFor = jest.fn(
    async (user: PermissionSubject): Promise<ReadonlySet<Permission>> =>
      seededPermissionsFor(user.role),
  );

  return {
    permissionsFor,
    resolveForUser: jest.fn(
      async (user: PermissionSubject): Promise<ResolvedRole | null> => {
        const seed = SYSTEM_ROLE_SEEDS.find(
          (candidate) => candidate.key === user.role,
        );
        if (!seed) return null;
        return {
          id: `app-role-${seed.key}`,
          key: seed.key,
          name: seed.name,
          isSystem: true,
          isProtected: seed.isProtected,
          permissions: seededPermissionsFor(user.role),
        };
      },
    ),
    can: jest.fn(async (user: PermissionSubject, permission: Permission) =>
      (await permissionsFor(user)).has(permission),
    ),
    canAny: jest.fn(
      async (user: PermissionSubject, permissions: readonly Permission[]) => {
        const granted = await permissionsFor(user);
        return permissions.some((permission) => granted.has(permission));
      },
    ),
    canAll: jest.fn(
      async (user: PermissionSubject, permissions: readonly Permission[]) => {
        const granted = await permissionsFor(user);
        return permissions.every((permission) => granted.has(permission));
      },
    ),
    invalidate: jest.fn(),
    invalidateAll: jest.fn(),
  };
}
