import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { TransactionQueryDto } from './dto/transaction-query.dto';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: TransactionQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = query.userId ? { userId: query.userId } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const movieIds = [...new Set(items.map((t) => t.movieId).filter((id): id is string => !!id))];
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
        amount: decimalToNumber(t.amount),
        movieTitle: t.movieId ? (movieTitleById.get(t.movieId) ?? null) : null,
      })),
      total,
      page,
      limit,
    };
  }
}
