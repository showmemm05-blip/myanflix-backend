import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TransactionType } from '../generated/prisma/client';
import type { Wallet } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getByUserId(userId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found for this user');
    return wallet;
  }

  async getTransactions(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.transaction.count({ where: { userId } }),
    ]);

    const movieIds = [
      ...new Set(
        items.map((t) => t.movieId).filter((id): id is string => !!id),
      ),
    ];
    const movies = movieIds.length
      ? await this.prisma.movie.findMany({
          where: { id: { in: movieIds } },
          select: { id: true, title: true },
        })
      : [];
    const movieTitleById = new Map(movies.map((m) => [m.id, m.title]));

    return {
      items: items.map((t) => ({
        ...t,
        movieTitle: t.movieId ? (movieTitleById.get(t.movieId) ?? null) : null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Adds funds to a user's wallet and records a DEPOSIT transaction. */
  async deposit(userId: string, amount: number): Promise<Wallet> {
    if (amount <= 0)
      throw new BadRequestException('Deposit amount must be positive');

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      });
      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.DEPOSIT,
          amount,
          status: 'COMPLETED',
        },
      });
      return wallet;
    });
  }

  /**
   * Debits a wallet within an existing transaction context (used by the
   * subscribe flow, which must also create the UserSubscription row
   * atomically). Throws if the balance is insufficient.
   *
   * The check and the write happen in one conditional UPDATE (`balance >=
   * amount`) rather than a separate read-then-check-then-write — two
   * concurrent debits (e.g. a double-tap Subscribe) could otherwise both
   * read the same balance before either write commits, both pass the check,
   * and both apply, letting the balance go negative.
   */
  async debitWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
  ): Promise<Wallet> {
    const result = await tx.wallet.updateMany({
      where: { userId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });

    if (result.count === 0) {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet)
        throw new NotFoundException('Wallet not found for this user');
      throw new BadRequestException('Insufficient wallet balance');
    }

    return tx.wallet.findUniqueOrThrow({ where: { userId } });
  }

  /**
   * Credits a wallet within an existing transaction context (used by the
   * deposit-approval flow, which must also flip the Deposit row and create
   * the Transaction record atomically).
   */
  async creditWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
  ): Promise<Wallet> {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found for this user');

    return tx.wallet.update({
      where: { userId },
      data: { balance: { increment: amount } },
    });
  }
}
