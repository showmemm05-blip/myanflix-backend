import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  TransactionStatus,
  TransactionType,
} from '../generated/prisma/client';
import type { UserLevel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type {
  CreateLevelDto,
  ReorderLevelsDto,
  UpdateLevelDto,
} from './dto/level.dto';

/** UserLevel row with Decimal mapped to a plain number — the ONLY shape that leaves this service. */
export interface LevelDto {
  id: string;
  name: string;
  threshold: number;
  icon: string;
  color: string;
  order: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserLevelStatusDto {
  /** Lifetime qualifying spend (Ks): SUM of COMPLETED SUBSCRIPTION transactions. */
  qualifyingTotal: number;
  level: LevelDto | null;
  nextLevel: LevelDto | null;
  remaining: number | null;
  progressPercent: number;
  /** Enabled levels in display order, so the frontends never need a second call. */
  ladder: LevelDto[];
}

/**
 * The whole level-resolution rulebook as one pure function, so boundary
 * behaviour is testable without a database:
 *
 * - level    = highest enabled threshold <= total (null when none qualifies)
 * - next     = lowest enabled threshold  >  total (null at the top)
 * - progress = total / next.threshold, clamped 0..100 (100 at the top,
 *              0 when no levels are enabled)
 *
 * `enabledLevels` may arrive in any order; resolution sorts by threshold
 * (order as a deterministic tie-break) while the returned ladder keeps
 * display order (`order` asc). Division is safe: next.threshold > total >= 0
 * implies next.threshold > 0.
 *
 * Basis-agnostic on purpose: `qualifyingTotal` is whatever sum the caller
 * decides counts (today: lifetime subscription spend).
 */
export function resolveLevelStatus(
  qualifyingTotal: number,
  enabledLevels: LevelDto[],
): UserLevelStatusDto {
  const byThreshold = [...enabledLevels].sort(
    (a, b) => a.threshold - b.threshold || a.order - b.order,
  );

  let level: LevelDto | null = null;
  for (const candidate of byThreshold) {
    if (candidate.threshold <= qualifyingTotal) level = candidate;
  }
  const nextLevel =
    byThreshold.find((l) => l.threshold > qualifyingTotal) ?? null;

  const remaining = nextLevel
    ? Math.max(0, nextLevel.threshold - qualifyingTotal)
    : null;
  const progressPercent = nextLevel
    ? Math.min(
        100,
        Math.max(0, Math.round((qualifyingTotal / nextLevel.threshold) * 100)),
      )
    : level
      ? 100
      : 0;

  const ladder = [...enabledLevels].sort(
    (a, b) => a.order - b.order || a.threshold - b.threshold,
  );

  return { qualifyingTotal, level, nextLevel, remaining, progressPercent, ladder };
}

/**
 * The subscription-spend membership ladder. A user's level is NEVER stored —
 * it is resolved per read from SUM(amount) of Transaction rows with
 * type SUBSCRIPTION and status COMPLETED, so an admin threshold edit
 * re-ranks every user by definition (no batch jobs, no recalc endpoints,
 * no stored-level drift).
 *
 * Why these Transaction rows and not Wallet.balance: users only spend on
 * subscriptions, and subscriptions.service writes exactly one such
 * transaction row (wallet debit + subscription row + transaction in one
 * $transaction) on every subscription purchase — that row is the one
 * current-state home of subscription-spend truth. Wallet.balance mixes in
 * every other kind of money movement and is the wrong source.
 *
 * Refund plug-in point: there is no subscription-refund flow today. If one
 * ever exists, it would flip or annotate the transaction row (e.g. status
 * COMPLETED -> FAILED, or a compensating entry excluded by this filter) and
 * the qualifying sum — and therefore everyone's level — corrects itself
 * with zero changes in this module.
 */
@Injectable()
export class LevelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The public ladder: enabled levels only, display order. */
  async findEnabled(): Promise<LevelDto[]> {
    const levels = await this.prisma.userLevel.findMany({
      where: { enabled: true },
      orderBy: [{ order: 'asc' }, { threshold: 'asc' }],
    });
    return levels.map((l) => this.toResponse(l));
  }

  /** Admin management list: disabled included, same ordering. */
  async findAll(): Promise<LevelDto[]> {
    const levels = await this.prisma.userLevel.findMany({
      orderBy: [{ order: 'asc' }, { threshold: 'asc' }],
    });
    return levels.map((l) => this.toResponse(l));
  }

  async create(dto: CreateLevelDto): Promise<LevelDto> {
    await this.assertNameAvailable(dto.name);
    await this.assertThresholdAvailable(dto.threshold);
    const order = dto.order ?? (await this.nextOrder());
    const level = await this.prisma.userLevel.create({
      data: { ...dto, order },
    });
    return this.toResponse(level);
  }

  async update(id: string, dto: UpdateLevelDto): Promise<LevelDto> {
    await this.assertExists(id);
    if (dto.name !== undefined) await this.assertNameAvailable(dto.name, id);
    if (dto.threshold !== undefined) {
      await this.assertThresholdAvailable(dto.threshold, id);
    }
    const level = await this.prisma.userLevel.update({
      where: { id },
      data: dto,
    });
    return this.toResponse(level);
  }

  /**
   * Hard delete — no relations exist, and users at this level simply resolve
   * to the next qualifying rung on their next read.
   */
  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.userLevel.delete({ where: { id } });
  }

  /** Applies the whole new ordering atomically; 404 if any id is unknown. */
  async reorder(dto: ReorderLevelsDto): Promise<LevelDto[]> {
    const ids = dto.items.map((item) => item.id);
    const existing = await this.prisma.userLevel.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existing.length !== new Set(ids).size) {
      throw new NotFoundException('Level not found');
    }
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.userLevel.update({
          where: { id: item.id },
          data: { order: item.order },
        }),
      ),
    );
    return this.findAll();
  }

  /**
   * The single home of the level math — both GET /users/me/level and
   * GET /users/:id/level land here; nothing else recomputes it.
   */
  async getUserLevelStatus(userId: string): Promise<UserLevelStatusDto> {
    const [agg, enabledLevels] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: {
          userId,
          type: TransactionType.SUBSCRIPTION,
          status: TransactionStatus.COMPLETED,
        },
        _sum: { amount: true },
      }),
      this.prisma.userLevel.findMany({
        where: { enabled: true },
        orderBy: [{ threshold: 'asc' }, { order: 'asc' }],
      }),
    ]);
    // decimalToNumber maps the no-matching-rows null to 0.
    const qualifyingTotal = decimalToNumber(agg._sum.amount);
    return resolveLevelStatus(
      qualifyingTotal,
      enabledLevels.map((l) => this.toResponse(l)),
    );
  }

  /**
   * Batched level resolution for list views (the admin users table) —
   * the getWalletSummaries antidote to per-row N+1: ONE transaction.groupBy
   * over the page's user ids plus ONE enabled-levels fetch, resolved per
   * user through the same pure resolveLevelStatus as everything else.
   * Returns only the resolved level row per user (name/icon/color is all a
   * table cell needs); users with no COMPLETED subscription spend still
   * resolve (total 0 → the zero-threshold rung), and null means no enabled
   * level qualifies.
   */
  async getLevelsForUsers(
    userIds: string[],
  ): Promise<Map<string, LevelDto | null>> {
    if (userIds.length === 0) return new Map();

    const [sums, enabledRows] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          type: TransactionType.SUBSCRIPTION,
          status: TransactionStatus.COMPLETED,
        },
        _sum: { amount: true },
      }),
      this.prisma.userLevel.findMany({
        where: { enabled: true },
        orderBy: [{ threshold: 'asc' }, { order: 'asc' }],
      }),
    ]);

    const enabledLevels = enabledRows.map((l) => this.toResponse(l));
    const totalByUserId = new Map(
      sums.map((s) => [s.userId, decimalToNumber(s._sum.amount)]),
    );

    return new Map(
      userIds.map((id) => [
        id,
        resolveLevelStatus(totalByUserId.get(id) ?? 0, enabledLevels).level,
      ]),
    );
  }

  private async nextOrder(): Promise<number> {
    const agg = await this.prisma.userLevel.aggregate({
      _max: { order: true },
    });
    return (agg._max.order ?? 0) + 1;
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.userLevel.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Level not found');
  }

  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.userLevel.findFirst({
      where: { name },
      select: { id: true },
    });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('A level with this name already exists');
    }
  }

  /**
   * Thresholds must be unique across ALL levels (disabled included) —
   * service-validated rather than a DB constraint so the migration stayed a
   * bare additive CREATE+INSERT. A tie would make resolution ambiguous.
   */
  private async assertThresholdAvailable(
    threshold: number,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.prisma.userLevel.findFirst({
      where: { threshold },
      select: { id: true },
    });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException('Another level already uses this threshold');
    }
  }

  /** Decimal must never leave the service — JSON.stringify chokes on it. */
  private toResponse(level: UserLevel): LevelDto {
    return {
      id: level.id,
      name: level.name,
      threshold: decimalToNumber(level.threshold),
      icon: level.icon,
      color: level.color,
      order: level.order,
      enabled: level.enabled,
      createdAt: level.createdAt,
      updatedAt: level.updatedAt,
    };
  }
}
