import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  MovieStatus,
  Prisma,
  Role,
  TransactionType,
  type Category,
  type Movie,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateMovieDto } from './dto/create-movie.dto';
import type { MovieQueryDto } from './dto/movie-query.dto';
import type { UpdateMovieDto } from './dto/update-movie.dto';

const CATALOG_INCLUDE = { categories: true } satisfies Prisma.MovieInclude;

type MovieWithCategories = Movie & { categories: Category[] };

@Injectable()
export class MoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async findAll(query: MovieQueryDto, viewerRole: Role) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.MovieWhereInput = {};

    // Regular users can only browse published content; staff can filter freely.
    if (viewerRole === Role.USER) {
      where.status = MovieStatus.PUBLISHED;
    } else if (query.status) {
      where.status = query.status;
    }

    if (query.genre) where.genre = { equals: query.genre, mode: 'insensitive' };
    if (query.categoryId) where.categories = { some: { id: query.categoryId } };
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.movie.findMany({
        where,
        include: CATALOG_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.movie.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findByIdOrThrow(id: string, viewerRole: Role): Promise<MovieWithCategories> {
    const movie = await this.prisma.movie.findUnique({ where: { id }, include: CATALOG_INCLUDE });

    if (!movie || (viewerRole === Role.USER && movie.status !== MovieStatus.PUBLISHED)) {
      throw new NotFoundException('Movie not found');
    }

    return movie;
  }

  async create(dto: CreateMovieDto): Promise<Movie> {
    const { categoryIds, ...data } = dto;
    return this.prisma.movie.create({
      data: {
        ...data,
        categories: categoryIds ? { connect: categoryIds.map((id) => ({ id })) } : undefined,
      },
      include: CATALOG_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateMovieDto): Promise<Movie> {
    await this.assertExists(id);
    const { categoryIds, ...data } = dto;

    return this.prisma.movie.update({
      where: { id },
      data: {
        ...data,
        categories: categoryIds ? { set: categoryIds.map((cid) => ({ id: cid })) } : undefined,
      },
      include: CATALOG_INCLUDE,
    });
  }

  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.movie.delete({ where: { id } });
  }

  /** User wallet -> purchase movie -> create transaction -> grant movie access. */
  async purchase(userId: string, movieId: string) {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie || movie.status !== MovieStatus.PUBLISHED) {
      throw new NotFoundException('Movie not found');
    }

    const alreadyOwned = await this.prisma.purchase.findUnique({
      where: { userId_movieId: { userId, movieId } },
    });
    if (alreadyOwned) {
      throw new ConflictException('You already own this movie');
    }

    return this.prisma.$transaction(async (tx) => {
      const amount = movie.isPremium ? movie.price : new Prisma.Decimal(0);

      if (movie.isPremium) {
        await this.walletService.debitWithinTransaction(tx, userId, amount.toNumber());
      }

      const purchase = await tx.purchase.create({ data: { userId, movieId, amount } });
      await tx.transaction.create({
        data: {
          userId,
          movieId,
          type: TransactionType.PURCHASE,
          amount,
          status: 'COMPLETED',
        },
      });

      return purchase;
    });
  }

  /** Purchase history for a user (own profile, or an admin viewing any user). */
  async getPurchasesForUser(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { movie: { select: { id: true, title: true, posterUrl: true } } },
      }),
      this.prisma.purchase.count({ where: { userId } }),
    ]);

    return {
      items: items.map((p) => ({
        id: p.id,
        movieId: p.movieId,
        movieTitle: p.movie.title,
        posterUrl: p.movie.posterUrl,
        amount: decimalToNumber(p.amount),
        createdAt: p.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.movie.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Movie not found');
  }
}
