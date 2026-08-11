import { Injectable, NotFoundException } from '@nestjs/common';
import type { User, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Role, TransactionType } from '../generated/prisma/client';

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  phone?: string;
  role?: Role;
}

export interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalSpent: number;
  isSubscribed: boolean;
  subscriptionExpiresAt: Date | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: input });
      await tx.wallet.create({ data: { userId: user.id, balance: 0 } });
      return user;
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  async findByEmailOrUsername(
    email: string,
    username: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
  }

  /** Expects an already-normalized phone (see normalizePhone). */
  async findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(pagination: PaginationQueryDto): Promise<{
    items: User[];
    total: number;
    walletByUserId: Map<string, WalletSummary>;
  }> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    // Staff accounts (SUPER_ADMIN/ADMIN/CONTENT_UPLOADER) are managed on the
    // dedicated Staff page — this list is subscriber accounts only.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { role: Role.USER },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where: { role: Role.USER } }),
    ]);

    const walletByUserId = await this.getWalletSummaries(
      items.map((u) => u.id),
    );
    return { items, total, walletByUserId };
  }

  /** Batched version of getWalletSummary for list views — avoids N+1 queries per page. */
  async getWalletSummaries(
    userIds: string[],
  ): Promise<Map<string, WalletSummary>> {
    if (userIds.length === 0) return new Map();

    const [wallets, spent, deposited, activeSubscriptions] = await Promise.all([
      this.prisma.wallet.findMany({ where: { userId: { in: userIds } } }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          type: {
            in: [TransactionType.PURCHASE, TransactionType.SUBSCRIPTION],
          },
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          type: TransactionType.DEPOSIT,
          status: 'COMPLETED',
        },
        _sum: { amount: true },
      }),
      this.prisma.userSubscription.findMany({
        where: { userId: { in: userIds }, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      }),
    ]);

    const balanceById = new Map(
      wallets.map((w) => [w.userId, decimalToNumber(w.balance)]),
    );
    const spentById = new Map(
      spent.map((s) => [s.userId, decimalToNumber(s._sum.amount)]),
    );
    const depositedById = new Map(
      deposited.map((d) => [d.userId, decimalToNumber(d._sum.amount)]),
    );
    // findMany is ordered by expiresAt desc, so the first row seen per user
    // is their latest-expiring active subscription.
    const subscriptionExpiresAtById = new Map<string, Date>();
    for (const sub of activeSubscriptions) {
      if (!subscriptionExpiresAtById.has(sub.userId)) {
        subscriptionExpiresAtById.set(sub.userId, sub.expiresAt);
      }
    }

    return new Map(
      userIds.map((id) => [
        id,
        {
          balance: balanceById.get(id) ?? 0,
          totalDeposited: depositedById.get(id) ?? 0,
          totalSpent: spentById.get(id) ?? 0,
          isSubscribed: subscriptionExpiresAtById.has(id),
          subscriptionExpiresAt: subscriptionExpiresAtById.get(id) ?? null,
        },
      ]),
    );
  }

  async updateRole(id: string, role: Role): Promise<User> {
    await this.findByIdOrThrow(id);
    return this.prisma.user.update({ where: { id }, data: { role } });
  }

  async updateStatus(id: string, status: UserStatus): Promise<User> {
    await this.findByIdOrThrow(id);
    return this.prisma.user.update({ where: { id }, data: { status } });
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  /** Balance/spend summary shown on both the admin User Profile page and a user's own dashboard. */
  async getWalletSummary(userId: string): Promise<WalletSummary> {
    const [wallet, spentAgg, depositedAgg, activeSubscription] =
      await Promise.all([
        this.prisma.wallet.findUnique({ where: { userId } }),
        this.prisma.transaction.aggregate({
          where: {
            userId,
            type: {
              in: [TransactionType.PURCHASE, TransactionType.SUBSCRIPTION],
            },
            status: 'COMPLETED',
          },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: { userId, type: TransactionType.DEPOSIT, status: 'COMPLETED' },
          _sum: { amount: true },
        }),
        this.prisma.userSubscription.findFirst({
          where: { userId, expiresAt: { gt: new Date() } },
          orderBy: { expiresAt: 'desc' },
        }),
      ]);

    return {
      balance: decimalToNumber(wallet?.balance),
      totalDeposited: decimalToNumber(depositedAgg._sum.amount),
      totalSpent: decimalToNumber(spentAgg._sum.amount),
      isSubscribed: Boolean(activeSubscription),
      subscriptionExpiresAt: activeSubscription?.expiresAt ?? null,
    };
  }
}
