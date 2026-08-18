import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MovieStatus,
  Prisma,
  Role,
  type Category,
  type Series,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { CreateSeriesDto } from './dto/create-series.dto';
import type { EpisodeQueryDto } from './dto/episode-query.dto';
import type { SeriesQueryDto } from './dto/series-query.dto';
import type { UpdateSeriesDto } from './dto/update-series.dto';

type SeriesWithCategories = Series & { categories?: Category[] };

/**
 * Show-level metadata CRUD plus series-level access. Seasons are
 * deliberately NOT rows anywhere — a "season" is just the distinct
 * seasonNumber values across a series' episodes. The whole show is one
 * product: its own accessType governs every season and episode (including
 * future ones), episodes are never gated individually.
 */
@Injectable()
export class SeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * A show's poster/cover URLs are persisted absolute, baked with whatever
   * host uploaded them, so they go stale the moment this machine changes
   * networks. Every read path re-hosts them against the current request —
   * see MinioService.imageUrl. Purely a read-time derivation; the stored
   * values are never touched.
   */
  private withImageUrls<
    T extends { posterUrl: string | null; coverUrl: string | null },
  >(series: T): T {
    return {
      ...series,
      posterUrl: this.minioService.imageUrl(series.posterUrl),
      coverUrl: this.minioService.imageUrl(series.coverUrl),
    };
  }

  async findAll(query: SeriesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SeriesWhereInput = {};
    if (query.accessType) where.accessType = query.accessType;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.series.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { categories: true, _count: { select: { episodes: true } } },
      }),
      this.prisma.series.count({ where }),
    ]);

    return {
      items: items.map(({ _count, ...series }) => ({
        ...this.withImageUrls(series),
        episodeCount: _count.episodes,
      })),
      total,
      page,
      limit,
    };
  }

  async findByIdOrThrow(id: string): Promise<SeriesWithCategories> {
    const series = await this.prisma.series.findUnique({
      where: { id },
      include: { categories: true },
    });
    if (!series) throw new NotFoundException('Series not found');
    return this.withImageUrls(series);
  }

  /** Detail shape for a viewer — access is a global per-user subscription flag, not per-item, so it isn't computed here. */
  async getForViewer(id: string, _userId: string, _role: Role) {
    return this.findByIdOrThrow(id);
  }

  /**
   * Image URLs as they should be STORED — see MinioService.canonicalImageUrl.
   * The admin echoes a fetched record back on save when the artwork was not
   * touched, so without this a row would inherit whichever host that one save
   * request happened to arrive on.
   */
  private withCanonicalImageUrls<T extends { posterUrl?: string | null; coverUrl?: string | null }>(
    data: T,
  ): T {
    return {
      ...data,
      ...(data.posterUrl !== undefined
        ? { posterUrl: this.minioService.canonicalImageUrl(data.posterUrl) }
        : {}),
      ...(data.coverUrl !== undefined
        ? { coverUrl: this.minioService.canonicalImageUrl(data.coverUrl) }
        : {}),
    };
  }

  async create(dto: CreateSeriesDto) {
    const { categoryIds, ...data } = dto;
    const created = await this.prisma.series.create({
      data: {
        ...this.withCanonicalImageUrls(data),
        categories: categoryIds
          ? { connect: categoryIds.map((id) => ({ id })) }
          : undefined,
      },
      include: { categories: true },
    });
    return this.withImageUrls(created);
  }

  async update(id: string, dto: UpdateSeriesDto) {
    await this.findByIdOrThrow(id);
    const { categoryIds, ...data } = dto;
    const updated = await this.prisma.series.update({
      where: { id },
      data: {
        ...this.withCanonicalImageUrls(data),
        categories: categoryIds
          ? { set: categoryIds.map((cid) => ({ id: cid })) }
          : undefined,
      },
      include: { categories: true },
    });
    return this.withImageUrls(updated);
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
    return grouped.map((g) => ({
      seasonNumber: g.seasonNumber!,
      episodeCount: g._count.seasonNumber,
    }));
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
      orderBy: [
        { seasonNumber: 'asc' },
        { episodeNumber: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  /**
   * Episodes grouped by season for the player page's "Episodes" section,
   * each annotated with the caller's own watch progress. Two queries total
   * regardless of episode count — the episode list, then one batched
   * watch-history lookup keyed by movieId — never N+1 per episode. Mirrors
   * UsersService.getWalletSummaries' batching pattern (findMany with `{in}`
   * + a Map for O(1) lookup while assembling the response).
   */
  async getPlayerEpisodes(seriesId: string, userId: string, viewerRole: Role) {
    await this.findByIdOrThrow(seriesId);

    const where: Prisma.MovieWhereInput = { seriesId };
    if (viewerRole === Role.USER) where.status = MovieStatus.PUBLISHED;

    const episodes = await this.prisma.movie.findMany({
      where,
      select: {
        id: true,
        title: true,
        seasonNumber: true,
        episodeNumber: true,
        duration: true,
        thumbnailUrl: true,
        posterUrl: true,
      },
      orderBy: [
        { seasonNumber: 'asc' },
        { episodeNumber: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const episodeIds = episodes.map((e) => e.id);
    const watchHistory = episodeIds.length
      ? await this.prisma.watchHistory.findMany({
          where: { userId, movieId: { in: episodeIds } },
          select: { movieId: true, progress: true, lastPosition: true },
        })
      : [];
    const progressByMovieId = new Map(
      watchHistory.map((w) => [
        w.movieId,
        { progressPercent: w.progress, lastPositionSeconds: w.lastPosition },
      ]),
    );

    const seasons = new Map<number, typeof episodes>();
    for (const episode of episodes) {
      // A real episode always has a seasonNumber (assigned at upload time,
      // see admin's addFolders) — anything without one can't be grouped
      // usefully here and is skipped, same defensive filter getSeasons()
      // already applies.
      if (episode.seasonNumber == null) continue;
      if (!seasons.has(episode.seasonNumber)) {
        seasons.set(episode.seasonNumber, []);
      }
      seasons.get(episode.seasonNumber)!.push(episode);
    }

    return {
      seasons: Array.from(seasons.entries())
        .sort(([a], [b]) => a - b)
        .map(([seasonNumber, seasonEpisodes]) => ({
          seasonNumber,
          episodes: seasonEpisodes.map((e) => ({
            id: e.id,
            title: e.title,
            episodeNumber: e.episodeNumber,
            duration: e.duration,
            thumbnailUrl: this.minioService.imageUrl(e.thumbnailUrl),
            posterUrl: this.minioService.imageUrl(e.posterUrl),
            watchProgress: progressByMovieId.get(e.id) ?? null,
          })),
        })),
    };
  }

  private buildEpisodeWhere(filters: {
    seriesId?: string;
    seasonNumber?: number;
    status?: MovieStatus;
  }): Prisma.MovieWhereInput {
    const where: Prisma.MovieWhereInput = {
      seriesId: filters.seriesId ?? { not: null },
    };
    if (filters.seasonNumber !== undefined)
      where.seasonNumber = filters.seasonNumber;
    if (filters.status) where.status = filters.status;
    return where;
  }

  /**
   * Cross-series episode listing for the admin's Series > Ready to Publish
   * tab. Episodes are just Movie rows with seriesId set, so this queries
   * Movie directly (with the owning series' title attached) rather than
   * living per-series the way getEpisodes()/getPlayerEpisodes() do.
   */
  async findEpisodesForAdmin(query: EpisodeQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildEpisodeWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.movie.findMany({
        where,
        include: { series: { select: { id: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.movie.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  /** Count-only counterpart to findEpisodesForAdmin(), for the sidebar badge. */
  async countEpisodesForAdmin(filters: {
    seriesId?: string;
    seasonNumber?: number;
    status?: MovieStatus;
  }): Promise<number> {
    return this.prisma.movie.count({ where: this.buildEpisodeWhere(filters) });
  }

  /** The caller's owned series — historical purchase records from before the subscription model. */
  async getPurchasesForUser(userId: string) {
    const purchases = await this.prisma.seriesPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        series: { select: { id: true, title: true, posterUrl: true } },
      },
    });
    return purchases.map((p) => ({
      id: p.id,
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      posterUrl: this.minioService.imageUrl(p.series.posterUrl),
      amount: decimalToNumber(p.amount),
      createdAt: p.createdAt,
    }));
  }
}
