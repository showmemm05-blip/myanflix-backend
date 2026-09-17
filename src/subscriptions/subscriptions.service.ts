import { Injectable, NotFoundException } from '@nestjs/common';
import { Role, TransactionType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from '../audit/audit.service';
import { subscriptionPlanSnapshot } from '../audit/audit-snapshots';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreatePlanDto } from './dto/create-plan.dto';
import type { UpdatePlanDto } from './dto/update-plan.dto';

/** Applied when a plan is created without an explicit durationDays (API back-compat). */
const DEFAULT_PLAN_DURATION_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * Staff see every plan, active or disabled — a disabled plan still needs
   * to be visible somewhere for an admin to re-enable it. Regular users only
   * ever see what they could actually subscribe to right now.
   */
  async findAllPlans(viewerRole: Role) {
    const plans = await this.prisma.subscriptionPlan.findMany({
      where: viewerRole === Role.USER ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    return plans.map((p) => ({ ...p, price: decimalToNumber(p.price) }));
  }

  async createPlan(dto: CreatePlanDto, actor: AuthenticatedUser) {
    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        ...dto,
        durationDays: dto.durationDays ?? DEFAULT_PLAN_DURATION_DAYS,
      },
    });
    await this.audit.record({
      action: 'subscription_plan.create',
      actor,
      target: { type: 'subscription_plan', id: plan.id, label: plan.name },
      after: subscriptionPlanSnapshot(plan),
    });
    return { ...plan, price: decimalToNumber(plan.price) };
  }

  async updatePlan(id: string, dto: UpdatePlanDto, actor: AuthenticatedUser) {
    // Full pre-read (not just an existence check) so the audit row can diff
    // the old price/duration against the new ones.
    const before = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
    });
    if (!before) throw new NotFoundException('Subscription plan not found');

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: dto,
    });
    await this.audit.record({
      action: 'subscription_plan.update',
      actor,
      target: { type: 'subscription_plan', id, label: plan.name },
      before: subscriptionPlanSnapshot(before),
      after: subscriptionPlanSnapshot(plan),
    });
    return { ...plan, price: decimalToNumber(plan.price) };
  }

  /** The caller's current subscription state, derived from their latest non-expired row. */
  async getMyStatus(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
      include: { plan: true },
    });
    return {
      isActive: Boolean(active),
      expiresAt: active?.expiresAt ?? null,
      planId: active?.planId ?? null,
      planName: active?.plan.name ?? null,
      durationDays: active?.plan.durationDays ?? null,
    };
  }

  /**
   * Debits the wallet, then either extends the caller's current active
   * subscription (renewing early never wastes remaining days — the new
   * period starts from the existing expiry, not from now) or starts a fresh
   * plan.durationDays-day period. Wallet debit + subscription row +
   * ledger transaction happen atomically, mirroring the old purchase flow.
   */
  async subscribe(userId: string, planId: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Subscription plan not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.walletService.debitWithinTransaction(
        tx,
        userId,
        plan.price.toNumber(),
      );

      const now = new Date();
      const current = await tx.userSubscription.findFirst({
        where: { userId, expiresAt: { gt: now } },
        orderBy: { expiresAt: 'desc' },
      });
      const base = current ? current.expiresAt : now;
      const expiresAt = new Date(
        base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000,
      );

      const subscription = await tx.userSubscription.create({
        data: { userId, planId, amount: plan.price, expiresAt },
      });
      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.SUBSCRIPTION,
          amount: plan.price,
          status: 'COMPLETED',
        },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      return { subscription, balance: wallet.balance };
    });

    // Emitted only after commit, same as every other balance-changing flow —
    // without this the wallet pill/balance in the UI goes stale until the
    // user manually reloads, since a subscription purchase previously fired
    // no real-time signal of any kind.
    this.realtimeGateway.notifyUserBalanceUpdated(
      userId,
      decimalToNumber(result.balance),
    );

    return result.subscription;
  }
}
