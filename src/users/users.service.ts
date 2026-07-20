import { Injectable, NotFoundException } from '@nestjs/common';
import type { Role, User, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { TransactionType } from '../generated/prisma/client';

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
}

export interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalSpent: number;
  moviesPurchased: number;
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

  async findByEmailOrUsername(email: string, username: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByIdOrThrow(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(
    pagination: PaginationQueryDto,
  ): Promise<{ items: User[]; total: number; walletByUserId: Map<string, WalletSummary> }> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count(),
    ]);

    const walletByUserId = await this.getWalletSummaries(items.map((u) => u.id));
    return { items, total, walletByUserId };
  }

  /** Batched version of getWalletSummary for list views — avoids N+1 queries per page. */
  async getWalletSummaries(userIds: string[]): Promise<Map<string, WalletSummary>> {
    if (userIds.length === 0) return new Map();

    const [wallets, spent, deposited, purchaseCounts] = await Promise.all([
      this.prisma.wallet.findMany({ where: { userId: { in: userIds } } }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, type: TransactionType.PURCHASE, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, type: TransactionType.DEPOSIT, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.purchase.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _count: { _all: true },
      }),
    ]);

    const balanceById = new Map(wallets.map((w) => [w.userId, decimalToNumber(w.balance)]));
    const spentById = new Map(spent.map((s) => [s.userId, decimalToNumber(s._sum.amount)]));
    const depositedById = new Map(deposited.map((d) => [d.userId, decimalToNumber(d._sum.amount)]));
    const purchaseCountById = new Map(purchaseCounts.map((p) => [p.userId, p._count._all]));

    return new Map(
      userIds.map((id) => [
        id,
        {
          balance: balanceById.get(id) ?? 0,
          totalDeposited: depositedById.get(id) ?? 0,
          totalSpent: spentById.get(id) ?? 0,
          moviesPurchased: purchaseCountById.get(id) ?? 0,
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

  /** Balance/spend summary shown on both the admin User Profile page and a user's own dashboard. */
  async getWalletSummary(userId: string): Promise<WalletSummary> {
    const [wallet, spentAgg, depositedAgg, purchaseCount] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.transaction.aggregate({
        where: { userId, type: TransactionType.PURCHASE, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { userId, type: TransactionType.DEPOSIT, status: 'COMPLETED' },
        _sum: { amount: true },
      }),
      this.prisma.purchase.count({ where: { userId } }),
    ]);

    return {
      balance: decimalToNumber(wallet?.balance),
      totalDeposited: decimalToNumber(depositedAgg._sum.amount),
      totalSpent: decimalToNumber(spentAgg._sum.amount),
      moviesPurchased: purchaseCount,
    };
  }
}
