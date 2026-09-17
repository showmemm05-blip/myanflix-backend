import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClientPlatform, Prisma, Role } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { requestClientContext } from '../common/storage/request-host.context';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditAction,
  AuditTargetType,
  getAuditActionDefinition,
} from './audit-actions';
import {
  AuditChange,
  diffSnapshots,
  sanitizeSnapshot,
  sanitizeValue,
  REDACTED_KEY_PATTERN,
  REDACTED_VALUE,
} from './audit-snapshot';
import { AuditQueryDto } from './dto/audit-query.dto';

export interface AuditTarget {
  type: AuditTargetType;
  id?: string | null;
  /** Human label at the time — a title, an @username, a reference. */
  label?: string | null;
}

export interface RecordAuditInput {
  action: AuditAction;
  /** null = a system event (transcode result, PDF conversion, …). */
  actor: AuthenticatedUser | null;
  target: AuditTarget;
  /** Snapshot BEFORE the write (update/delete). */
  before?: Record<string, unknown> | null;
  /** Snapshot AFTER the write (create/update). */
  after?: Record<string, unknown> | null;
  /** Free-form extras: bulk results, reason, related ids, trigger. */
  metadata?: Record<string, unknown> | null;
  /** Write inside the caller's interactive transaction when given. */
  tx?: Prisma.TransactionClient;
  /**
   * Record even when `actor.role === USER`. Rare — for shared routes where
   * the caller has already decided this is a moderation act, not self-service.
   */
  force?: boolean;
}

interface ActorDetails {
  displayName: string | null;
  appRoleName: string | null;
}

interface CachedActorDetails extends ActorDetails {
  expiresAt: number;
}

/** How long one actor's displayName/appRole lookup is reused. */
export const ACTOR_CACHE_TTL_MS = 60_000;

/** Selected alongside the snapshot columns: the actor's CURRENT state. */
const ACTOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  avatar: true,
} satisfies Prisma.UserSelect;

/**
 * Writes and reads the staff audit log.
 *
 * `record()` is the only write path and is designed to be safe to call from
 * any service method: it drops end-user self-service on its own, tolerates
 * a missing request context (system events), never throws outside a
 * transaction, and sanitises everything before it is stored — so a caller
 * only ever hands over what happened, never worries about the log itself.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly actorCache = new Map<string, CachedActorDetails>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one staff action. Resolves without writing when the actor is a
   * plain USER (unless `force`), or when an `.update` produced no changes.
   *
   * Outside a transaction a failed write is logged and swallowed — a
   * business action must never fail because its log line could not be
   * written. Inside `tx` the error propagates so the whole transaction rolls
   * back together with the audit row.
   */
  async record(input: RecordAuditInput): Promise<void> {
    if (input.actor?.role === Role.USER && !input.force) return;

    if (input.tx) {
      await this.write(input, input.tx);
      return;
    }

    try {
      await this.write(input, this.prisma);
    } catch (error) {
      this.logger.error(
        `audit write failed for ${input.action} on ${input.target.type}${
          input.target.id ? `:${input.target.id}` : ''
        }`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Forget cached displayName/appRole for one actor (or everyone). */
  invalidateActorCache(actorId?: string): void {
    if (actorId === undefined) this.actorCache.clear();
    else this.actorCache.delete(actorId);
  }

  private async write(
    input: RecordAuditInput,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    const definition = getAuditActionDefinition(input.action);

    const before = sanitizeSnapshot(input.before);
    const after = sanitizeSnapshot(input.after);
    const isUpdate = before !== null && after !== null;
    const changes = isUpdate
      ? this.sanitizeChanges(diffSnapshots(input.before, input.after))
      : null;

    // No-op saves are noise: an `.update` whose diff is empty is not recorded.
    if (
      isUpdate &&
      changes !== null &&
      changes.length === 0 &&
      input.action.endsWith('.update')
    ) {
      return;
    }

    const actor = await this.actorSnapshot(input.actor, client);
    // A system row (background pipeline) must not inherit the IP/device of
    // the request that happened to launch that pipeline.
    const clientContext = input.actor
      ? requestClientContext()
      : { ip: null, userAgent: null, platform: ClientPlatform.UNKNOWN };

    await client.auditLog.create({
      data: {
        category: definition.category,
        action: input.action,
        ...actor,
        targetType: input.target.type,
        targetId: input.target.id ?? null,
        targetLabel: input.target.label ?? null,
        changes: toJsonInput(changes),
        before: toJsonInput(before),
        after: toJsonInput(after),
        metadata: toJsonInput(sanitizeSnapshot(input.metadata)),
        ip: clientContext.ip,
        userAgent: clientContext.userAgent,
        platform: clientContext.platform,
      },
    });
  }

  private sanitizeChanges(changes: AuditChange[]): AuditChange[] {
    return changes.map(({ field, from, to }) => ({
      field,
      // A secret-shaped FIELD is listed as changed, but never with its values.
      from: REDACTED_KEY_PATTERN.test(field)
        ? REDACTED_VALUE
        : (sanitizeValue(from) ?? null),
      to: REDACTED_KEY_PATTERN.test(field)
        ? REDACTED_VALUE
        : (sanitizeValue(to) ?? null),
    }));
  }

  private async actorSnapshot(
    actor: AuthenticatedUser | null,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<{
    actorId: string | null;
    actorUsername: string;
    actorDisplayName: string | null;
    actorRole: Role | null;
    actorAppRoleId: string | null;
    actorAppRoleName: string | null;
  }> {
    if (!actor) {
      return {
        actorId: null,
        actorUsername: 'system',
        actorDisplayName: 'System',
        actorRole: null,
        actorAppRoleId: null,
        actorAppRoleName: null,
      };
    }

    const details = await this.actorDetails(actor.id, client);
    return {
      actorId: actor.id,
      actorUsername: actor.username,
      actorDisplayName: details.displayName,
      actorRole: actor.role,
      actorAppRoleId: actor.appRoleId ?? null,
      actorAppRoleName: details.appRoleName,
    };
  }

  /**
   * displayName + appRole.name for the actor, from ONE query, cached
   * in-process for ACTOR_CACHE_TTL_MS so a burst of actions by the same
   * staff member costs one lookup rather than one per action. Always read
   * through the root client, never the caller's transaction: it is a cache
   * fill, not part of the business write.
   */
  private async actorDetails(
    actorId: string,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<ActorDetails> {
    const now = Date.now();
    const cached = this.actorCache.get(actorId);
    if (cached && cached.expiresAt > now) return cached;

    // Through the caller's client: inside a transaction this must not borrow a
    // second pool connection while the first one is held open.
    const user = await client.user.findUnique({
      where: { id: actorId },
      select: { displayName: true, appRole: { select: { name: true } } },
    });
    const details: ActorDetails = {
      displayName: user?.displayName ?? null,
      appRoleName: user?.appRole?.name ?? null,
    };
    this.actorCache.set(actorId, {
      ...details,
      expiresAt: now + ACTOR_CACHE_TTL_MS,
    });
    return details;
  }

  // -------------------------------------------------------------------------
  // Read side (GET /audit) — AUDIT.VIEW implies PII visibility: rows are
  // returned whole, ip and userAgent included, un-masked.
  // -------------------------------------------------------------------------

  async findAll(query: AuditQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.AuditLogWhereInput = {};
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.category) where.category = query.category;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    if (query.actorId) where.actorId = query.actorId;

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { targetLabel: { contains: search, mode: 'insensitive' } },
        { actorUsername: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { actor: { select: ACTOR_SELECT } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findOne(id: string) {
    const entry = await this.prisma.auditLog.findUnique({
      where: { id },
      include: { actor: { select: ACTOR_SELECT } },
    });
    if (!entry) throw new NotFoundException('Audit log entry not found');
    return entry;
  }
}

/**
 * A nullable Json column takes `undefined` for "leave NULL"; a plain `null`
 * is rejected at the type level (Prisma wants JsonNull/DbNull for that).
 */
function toJsonInput(
  value: Record<string, unknown> | AuditChange[] | null,
): Prisma.InputJsonValue | undefined {
  return value === null ? undefined : (value as Prisma.InputJsonValue);
}
