import { Injectable, NotFoundException } from '@nestjs/common';
import { Role, TransactionType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { CreatePlanDto } from './dto/create-plan.dto';
import type { UpdatePlanDto } from './dto/update-plan.dto';

const SUBSCRIPTION_DURATION_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
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

  async createPlan(dto: CreatePlanDto) {
    const plan = await this.prisma.subscriptionPlan.create({ data: dto });
    return { ...plan, price: decimalToNumber(plan.price) };
  }

  async updatePlan(id: string, dto: UpdatePlanDto) {
    await this.assertPlanExists(id);
    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: dto,
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
      planName: active?.plan.name ?? null,
    };
  }

  /**
   * Debits the wallet, then either extends the caller's current active
   * subscription (renewing early never wastes remaining days — the new
   * period starts from the existing expiry, not from now) or starts a fresh
   * SUBSCRIPTION_DURATION_DAYS-day period. Wallet debit + subscription row +
   * ledger transaction happen atomically, mirroring the old purchase flow.
   */
  async subscribe(userId: string, planId: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Subscription plan not found');
    }

    return this.prisma.$transaction(async (tx) => {
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
        base.getTime() + SUBSCRIPTION_DURATION_DAYS * 24 * 60 * 60 * 1000,
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
      return subscription;
    });
  }

  private async assertPlanExists(id: string): Promise<void> {
    const exists = await this.prisma.subscriptionPlan.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Subscription plan not found');
  }
}
