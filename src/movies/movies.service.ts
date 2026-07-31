import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateMovieDto } from './dto/create-movie.dto';
import type { MovieQueryDto } from './dto/movie-query.dto';
import type { UpdateMovieDto } from './dto/update-movie.dto';

const CATALOG_INCLUDE = { categories: true } satisfies Prisma.MovieInclude;

type MovieWithCategories = Movie & { categories: Category[] };

@Injectable()
export class MoviesService {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly minioService: MinioService,
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

  /**
   * Bootstrap row for the bulk pre-transcoded upload flow — the admin has
   * only picked a folder at this point, so only its extracted title is
   * known. Starts at UPLOADING; everything else (description, genre,
   * categories, price, release date, images) gets filled in later via
   * update() once the admin edits it, after the upload finishes.
   */
  async createUploadPlaceholder(title: string): Promise<Movie> {
    return this.prisma.movie.create({
      data: {
        title,
        description: '',
        genre: '',
        language: '',
        releaseYear: new Date().getFullYear(),
        duration: 0,
        price: 0,
        isPremium: true,
        status: MovieStatus.UPLOADING,
      },
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

  /**
   * Deletes the movie row (cascading to its Video/Subtitle/UploadSession
   * rows) and then best-effort cleans up its actual bytes in storage —
   * without this, every deleted movie would leak its original file, every
   * HLS rendition, its subtitles, and its poster/banner/thumbnail forever.
   * Storage cleanup runs AFTER the DB delete (the catalog removal is the
   * primary, user-facing action and shouldn't be blocked by a storage
   * hiccup) and is logged rather than thrown on failure — a partial cleanup
   * just leaves orphaned bytes behind, it's not a functional problem.
   */
  async remove(id: string): Promise<void> {
    const movie = await this.prisma.movie.findUnique({
      where: { id },
      include: { videos: { include: { subtitles: true } } },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    await this.prisma.movie.delete({ where: { id } });

    try {
      await this.minioService.deleteByPrefix(`videos/${id}/`);

      for (const url of [movie.posterUrl, movie.coverUrl, movie.thumbnailUrl]) {
        if (!url) continue;
        const key = this.minioService.keyFromPublicUrl(url);
        if (key) await this.minioService.deleteObject(key);
      }

      for (const video of movie.videos) {
        for (const subtitle of video.subtitles) {
          // Bundle-detected subtitles already live under videos/<movieId>/...
          // and were just caught by the prefix delete above; manually
          // uploaded ones live under the separate global subtitles/<id>/
          // prefix and need deleting individually.
          if (!subtitle.objectKey.startsWith(`videos/${id}/`)) {
            await this.minioService.deleteObject(subtitle.objectKey);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to clean up storage for deleted movie ${id}: ${(error as Error).message}`);
    }
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

  /** Published movies ranked by how many users have purchased them. */
  async getMostPurchased(limit = 12): Promise<MovieWithCategories[]> {
    const grouped = await this.prisma.purchase.groupBy({
      by: ['movieId'],
      _count: { movieId: true },
      orderBy: { _count: { movieId: 'desc' } },
      take: limit,
    });
    if (grouped.length === 0) return [];

    const movies = await this.prisma.movie.findMany({
      where: { id: { in: grouped.map((g) => g.movieId) }, status: MovieStatus.PUBLISHED },
      include: CATALOG_INCLUDE,
    });

    const orderById = new Map(grouped.map((g, index) => [g.movieId, index]));
    return movies.sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
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
