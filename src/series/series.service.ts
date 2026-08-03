import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  MovieStatus,
  Prisma,
  Role,
  TransactionType,
  type Category,
  type Series,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateSeriesDto } from './dto/create-series.dto';
import type { UpdateSeriesDto } from './dto/update-series.dto';

type SeriesWithCategories = Series & { categories?: Category[] };

/**
 * Show-level metadata CRUD plus series-level purchasing. Seasons are
 * deliberately NOT rows anywhere — a "season" is just the distinct
 * seasonNumber values across a series' episodes. The whole show is one
 * purchasable product: SeriesPurchase is what unlocks every episode
 * (including future ones), episodes are never sold individually.
 */
@Injectable()
export class SeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /** Prisma Decimal doesn't JSON-serialize as a number — every outward-facing series passes through here. */
  private serialize<T extends SeriesWithCategories>(series: T) {
    return { ...series, price: decimalToNumber(series.price) };
  }

  async findAll(pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.series.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { categories: true, _count: { select: { episodes: true } } },
      }),
      this.prisma.series.count(),
    ]);

    return {
      items: items.map(({ _count, ...series }) => ({ ...this.serialize(series), episodeCount: _count.episodes })),
      total,
      page,
      limit,
    };
  }

  async findByIdOrThrow(id: string): Promise<SeriesWithCategories> {
    const series = await this.prisma.series.findUnique({ where: { id }, include: { categories: true } });
    if (!series) throw new NotFoundException('Series not found');
    return series;
  }

  /** Detail shape for a viewer — staff always count as owning (they never see a Buy button). */
  async getForViewer(id: string, userId: string, role: Role) {
    const series = await this.findByIdOrThrow(id);
    const isPurchased = role !== Role.USER || !series.isPremium || (await this.isPurchased(userId, id));
    return { ...this.serialize(series), isPurchased };
  }

  async create(dto: CreateSeriesDto) {
    const { categoryIds, ...data } = dto;
    const created = await this.prisma.series.create({
      data: {
        ...data,
        categories: categoryIds ? { connect: categoryIds.map((id) => ({ id })) } : undefined,
      },
      include: { categories: true },
    });
    return this.serialize(created);
  }

  async update(id: string, dto: UpdateSeriesDto) {
    await this.findByIdOrThrow(id);
    const { categoryIds, ...data } = dto;
    const updated = await this.prisma.series.update({
      where: { id },
      data: {
        ...data,
        categories: categoryIds ? { set: categoryIds.map((cid) => ({ id: cid })) } : undefined,
      },
      include: { categories: true },
    });
    return this.serialize(updated);
  }

  /**
   * Deleting a series only removes the show-level metadata — its episodes
   * survive with seriesId nulled (the schema's SetNull), so hours of
   * uploaded, transcoded content never rides along with a metadata delete.
   * Removing actual episodes stays an explicit per-movie action with its
   * own storage cleanup (MoviesService.remove).
   */
  async remove(id: string): Promise<void> {
    await this.findByIdOrThrow(id);
    await this.prisma.series.delete({ where: { id } });
  }

  /** Distinct season numbers + per-season episode counts, e.g. [{seasonNumber: 1, episodeCount: 8}]. */
  async getSeasons(seriesId: string) {
    await this.findByIdOrThrow(seriesId);
    const grouped = await this.prisma.movie.groupBy({
      by: ['seasonNumber'],
      where: { seriesId, seasonNumber: { not: null } },
      _count: { seasonNumber: true },
      orderBy: { seasonNumber: 'asc' },
    });
    return grouped.map((g) => ({ seasonNumber: g.seasonNumber!, episodeCount: g._count.seasonNumber }));
  }

  /**
   * Episodes of one series (optionally one season), in playback order.
   * Regular users only ever see PUBLISHED episodes — same visibility rule
   * the movies catalog enforces.
   */
  async getEpisodes(seriesId: string, viewerRole: Role, seasonNumber?: number) {
    await this.findByIdOrThrow(seriesId);

    const where: Prisma.MovieWhereInput = { seriesId };
    if (seasonNumber !== undefined) where.seasonNumber = seasonNumber;
    if (viewerRole === Role.USER) where.status = MovieStatus.PUBLISHED;

    return this.prisma.movie.findMany({
      where,
      include: { categories: true },
      orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async isPurchased(userId: string, seriesId: string): Promise<boolean> {
    const purchase = await this.prisma.seriesPurchase.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });
    return Boolean(purchase);
  }

  /**
   * One purchase unlocks the entire show — every season and episode,
   * including any added later, since episode access is derived from this
   * row rather than anything per-episode. Mirrors MoviesService.purchase():
   * wallet debit + purchase row + ledger transaction, atomically.
   */
  async purchase(userId: string, seriesId: string) {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) throw new NotFoundException('Series not found');

    const alreadyOwned = await this.isPurchased(userId, seriesId);
    if (alreadyOwned) throw new ConflictException('You already own this series');

    return this.prisma.$transaction(async (tx) => {
      const amount = series.isPremium ? series.price : new Prisma.Decimal(0);

      if (series.isPremium) {
        await this.walletService.debitWithinTransaction(tx, userId, amount.toNumber());
      }

      const purchase = await tx.seriesPurchase.create({ data: { userId, seriesId, amount } });
      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.PURCHASE,
          amount,
          status: 'COMPLETED',
        },
      });

      return purchase;
    });
  }

  /** The caller's owned series — what the userwebsite's library context loads to know which shows are unlocked. */
  async getPurchasesForUser(userId: string) {
    const purchases = await this.prisma.seriesPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { series: { select: { id: true, title: true, posterUrl: true } } },
    });
    return purchases.map((p) => ({
      id: p.id,
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      posterUrl: p.series.posterUrl,
      amount: decimalToNumber(p.amount),
      createdAt: p.createdAt,
    }));
  }
}
