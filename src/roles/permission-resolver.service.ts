import { Injectable, Logger } from '@nestjs/common';
import { Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Permission } from './permission-catalogue';
import { ALL_PERMISSIONS } from './permission-catalogue';

/** The bits of the authenticated caller permission resolution actually needs. */
export interface PermissionSubject {
  role: Role;
  appRoleId?: string | null;
}

export interface ResolvedRole {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  isProtected: boolean;
  permissions: ReadonlySet<Permission>;
}

const ALL_PERMISSIONS_SET: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);
const EMPTY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>();

/**
 * How long a cached role may be served without being re-read. Invalidation is
 * still what makes an edit live on the very next request; this is defence in
 * depth for the cases invalidation cannot see (another process, a direct DB
 * edit) — see the staleness note on the class.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Turns a caller into the set of permissions they actually hold, reading the
 * DB-backed AppRole tables through a small in-process cache.
 *
 * The cache is what makes runtime-editable roles cheap: without it every
 * guarded request would cost a join. It is keyed by role id (with a secondary
 * key -> id index for the NULL-appRoleId fallback path) and is invalidated by
 * RolesService the moment a role's permissions change — so a permission edit
 * is live on the very next request, with no redeploy and no re-login.
 *
 * Two deliberate short-circuits:
 * - `isProtected` (SUPER_ADMIN) always resolves to every permission, so the
 *   protected role can never be edited or migrated into a lockout.
 * - If the SUPER_ADMIN role row is somehow missing, super admins still get
 *   every permission rather than none — losing the seed must not brick the
 *   only account that could repair it.
 *
 * Two things bound how stale a cached answer can be:
 *
 * - **In this process**: never. A load that was already in flight when
 *   `invalidate()`/`invalidateAll()` ran carries a stale snapshot, so its
 *   result is DISCARDED rather than written back over the fresh state — the
 *   `generation` counter is how it notices. Without that, a revoke racing a
 *   concurrent request could repopulate the cache with the permissions that
 *   were just taken away and keep serving them indefinitely.
 * - **Across processes**: at most CACHE_TTL_MS (60s). Invalidation is
 *   in-process only, so a second backend instance (or a direct DB edit) keeps
 *   serving its own cached copy until the entry expires. That window is the
 *   guaranteed upper bound on how long a revoked permission can survive
 *   anywhere in the fleet; closing it entirely needs a shared invalidation
 *   channel (pub/sub), which is deliberately out of scope here.
 */
@Injectable()
export class PermissionResolverService {
  private readonly logger = new Logger(PermissionResolverService.name);

  private readonly byId = new Map<string, ResolvedRole>();
  private readonly idByKey = new Map<string, string>();
  /** When each cached role was read, for the TTL check. */
  private readonly loadedAt = new Map<string, number>();
  /** De-duplicates concurrent loads of the same role into one query. */
  private readonly inFlight = new Map<string, Promise<ResolvedRole | null>>();
  /**
   * Bumped by every invalidation. A load that started before the bump is
   * holding a snapshot from before the change, so it must not be cached.
   */
  private generation = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** The caller's effective role: their AppRole, or the system role matching their `Role` enum. */
  async resolveForUser(user: PermissionSubject): Promise<ResolvedRole | null> {
    if (user.appRoleId) {
      const byId = await this.getById(user.appRoleId);
      if (byId) return byId;
      // Assignment points at a role that no longer exists (deleted between
      // the JWT lookup and here) — fall through to the account-kind default.
    }
    return this.getByKey(user.role);
  }

  async permissionsFor(
    user: PermissionSubject,
  ): Promise<ReadonlySet<Permission>> {
    const role = await this.resolveForUser(user);
    if (!role) {
      if (user.role === Role.SUPER_ADMIN) return ALL_PERMISSIONS_SET;
      return EMPTY_PERMISSIONS;
    }
    return role.permissions;
  }

  async can(user: PermissionSubject, permission: Permission): Promise<boolean> {
    const granted = await this.permissionsFor(user);
    return granted.has(permission);
  }

  async canAny(
    user: PermissionSubject,
    permissions: readonly Permission[],
  ): Promise<boolean> {
    const granted = await this.permissionsFor(user);
    return permissions.some((permission) => granted.has(permission));
  }

  async canAll(
    user: PermissionSubject,
    permissions: readonly Permission[],
  ): Promise<boolean> {
    const granted = await this.permissionsFor(user);
    return permissions.every((permission) => granted.has(permission));
  }

  /** Called by RolesService whenever one role's permissions/identity changed. */
  invalidate(roleId: string): void {
    this.generation += 1;
    const cached = this.byId.get(roleId);
    if (cached) this.idByKey.delete(cached.key);
    this.byId.delete(roleId);
    this.loadedAt.delete(roleId);
    this.inFlight.delete(`id:${roleId}`);
    if (cached) this.inFlight.delete(`key:${cached.key}`);
  }

  /** Called after bulk changes (or when a key mapping may have moved). */
  invalidateAll(): void {
    this.generation += 1;
    this.byId.clear();
    this.idByKey.clear();
    this.loadedAt.clear();
    this.inFlight.clear();
  }

  private async getById(roleId: string): Promise<ResolvedRole | null> {
    const cached = this.cached(roleId);
    if (cached) return cached;
    return this.load(`id:${roleId}`, () => this.query({ id: roleId }));
  }

  private async getByKey(key: string): Promise<ResolvedRole | null> {
    const id = this.idByKey.get(key);
    if (id) {
      const cached = this.cached(id);
      if (cached) return cached;
    }
    return this.load(`key:${key}`, () => this.query({ key }));
  }

  /** A cached role, or undefined once it is past its TTL. */
  private cached(roleId: string): ResolvedRole | undefined {
    const role = this.byId.get(roleId);
    if (!role) return undefined;

    const at = this.loadedAt.get(roleId) ?? 0;
    if (Date.now() - at < CACHE_TTL_MS) return role;

    this.byId.delete(roleId);
    this.loadedAt.delete(roleId);
    this.idByKey.delete(role.key);
    return undefined;
  }

  private async load(
    cacheKey: string,
    loader: () => Promise<ResolvedRole | null>,
  ): Promise<ResolvedRole | null> {
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    // Captured BEFORE the query: if a role edit lands while it is in flight,
    // this result describes the world before that edit and must not be cached.
    // The caller still gets it (their request was authorized against the state
    // it started in); it just never becomes the answer for anybody else.
    const generation = this.generation;

    const promise = loader()
      .then((role) => {
        if (role && generation === this.generation) {
          this.byId.set(role.id, role);
          this.idByKey.set(role.key, role.id);
          this.loadedAt.set(role.id, Date.now());
        }
        return role;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async query(
    where: { id: string } | { key: string },
  ): Promise<ResolvedRole | null> {
    const row = await this.prisma.appRole.findUnique({
      where: where as { id: string },
      include: { permissions: { select: { permission: true } } },
    });

    if (!row) {
      this.logger.warn(
        `No AppRole found for ${JSON.stringify(where)} — resolving to no permissions`,
      );
      return null;
    }

    return {
      id: row.id,
      key: row.key,
      name: row.name,
      isSystem: row.isSystem,
      isProtected: row.isProtected,
      permissions: row.isProtected
        ? ALL_PERMISSIONS_SET
        : new Set(row.permissions.map((p) => p.permission as Permission)),
    };
  }
}
