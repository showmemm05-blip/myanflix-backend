import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  MovieStatus,
  Prisma,
  Role,
  SeriesStatus,
  type Category,
  type Series,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CATALOG_INCLUDE,
  toFacetValues,
  type FacetValue,
} from '../movies/movies.service';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { computeTwoTierSlice } from '../common/utils/two-tier-page.util';
import {
  facetStringFilter,
  numberRange,
} from '../common/utils/facet-filter.util';
import type { CreateSeriesDto } from './dto/create-series.dto';
import type { EpisodeQueryDto } from './dto/episode-query.dto';
import type { UpdateSeriesDto } from './dto/update-series.dto';
import { SeriesSort, type SeriesQueryDto } from './dto/series-query.dto';

type SeriesWithCategories = Series & { categories?: Category[] };

export interface SeriesFacets {
  genres: FacetValue[];
  languages: FacetValue[];
  years: { min: number; max: number } | null;
}

const FACETS_TTL_MS = 60_000;

/**
 * The series `where` from the canonical query — everything except the
 * search term (the relevance sort splits it into tiers; other sorts OR it
 * in whole). Exported pure for the spec. Same facet semantics as the
 * movies catalog: OR within a facet, AND across facets.
 */
export function buildSeriesWhere(
  query: SeriesQueryDto,
  viewerRole: Role,
): Prisma.SeriesWhereInput {
  const where: Prisma.SeriesWhereInput = {};
  if (query.accessType) where.accessType = query.accessType;

  // Regular users can only ever browse PUBLISHED series — any status
  // filter they pass is ignored, not honored. Staff see everything by
  // default and may narrow to one status.
  if (viewerRole === Role.USER) {
    where.status = SeriesStatus.PUBLISHED;
  } else if (query.status) {
    where.status = query.status;
  }

  const genreFilter = facetStringFilter(query.genres ?? []);
  if (genreFilter) where.genre = genreFilter;

  const languageFilter = facetStringFilter(query.languages ?? []);
  if (languageFilter) where.language = languageFilter;

  const yearRange = numberRange(query.yearFrom, query.yearTo);
  if (yearRange) where.releaseYear = yearRange;

  return where;
}

/** The series search predicate — title OR description, case-insensitive. */
export function seriesSearchOr(search: string): Prisma.SeriesWhereInput[] {
  return [
    { title: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } },
  ];
}

/**
 * orderBy for the plain series sorts (the subset — see SeriesSort). Every
 * chain ends in `id` so pagination is deterministic across equal keys.
 */
const SERIES_SORT_ORDER_BY = {
  [SeriesSort.RECENTLY_ADDED]: [{ createdAt: 'desc' }, { id: 'desc' }],
  [SeriesSort.NEWEST]: [
    { releaseYear: 'desc' },
    { createdAt: 'desc' },
    { id: 'desc' },
  ],
  [SeriesSort.OLDEST]: [
    { releaseYear: 'asc' },
    { createdAt: 'asc' },
    { id: 'asc' },
  ],
  [SeriesSort.TITLE]: [{ title: 'asc' }, { id: 'asc' }],
} as const satisfies Partial<
  Record<SeriesSort, Prisma.SeriesOrderByWithRelationInput[]>
>;

export function seriesOrderBy(
  sort: keyof typeof SERIES_SORT_ORDER_BY,
): Prisma.SeriesOrderByWithRelationInput[] {
  return [...SERIES_SORT_ORDER_BY[sort]];
}

/** The list-row include — categories plus the derived episode count. */
const SERIES_LIST_INCLUDE = {
  categories: true,
  _count: { select: { episodes: true } },
} satisfies Prisma.SeriesInclude;

type SeriesListRow = Prisma.SeriesGetPayload<{
  include: typeof SERIES_LIST_INCLUDE;
}>;

export interface SeriesRemovalResult {
  deletedEpisodes: number;
  storageCleanup: 'complete' | 'partial';
  failedObjects: string[];
}

/**
 * Show-level metadata CRUD plus series-level access. Seasons are
 * deliberately NOT rows anywhere — a "season" is just the distinct
 * seasonNumber values across a series' episodes. The whole show is one
 * product: its own accessType governs every season and episode (including
 * future ones), episodes are never gated individually.
 */
@Injectable()
export class SeriesService {
  private readonly logger = new Logger(SeriesService.name);

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

  async findAll(query: SeriesQueryDto, viewerRole: Role) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim() || undefined;

    // Relevance needs a term — a stale deep link without one falls back to
    // the default sort, same rule as the movies catalog.
    let sort = query.sort ?? SeriesSort.RECENTLY_ADDED;
    if (sort === SeriesSort.RELEVANCE && !search) {
      sort = SeriesSort.RECENTLY_ADDED;
    }

    const where = buildSeriesWhere(query, viewerRole);

    let items: SeriesListRow[];
    let total: number;

    if (sort === SeriesSort.RELEVANCE) {
      ({ items, total } = await this.findRelevancePage(
        where,
        search!,
        page,
        limit,
      ));
    } else {
      if (search) where.OR = seriesSearchOr(search);
      [items, total] = await this.prisma.$transaction([
        this.prisma.series.findMany({
          where,
          orderBy: seriesOrderBy(sort),
          skip: (page - 1) * limit,
          take: limit,
          include: SERIES_LIST_INCLUDE,
        }),
        this.prisma.series.count({ where }),
      ]);
    }

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

  /**
   * Two-tier relevance page for series — same deterministic title-first
   * ranking as MoviesService.findRelevancePage (tiers disjoint, total =
   * count1 + count2, page spliced via computeTwoTierSlice).
   */
  private async findRelevancePage(
    base: Prisma.SeriesWhereInput,
    search: string,
    page: number,
    limit: number,
  ): Promise<{ items: SeriesListRow[]; total: number }> {
    const titleMatch: Prisma.SeriesWhereInput = {
      title: { contains: search, mode: 'insensitive' },
    };
    const descriptionMatch: Prisma.SeriesWhereInput = {
      description: { contains: search, mode: 'insensitive' },
    };
    const tier1: Prisma.SeriesWhereInput = { AND: [base, titleMatch] };
    const tier2: Prisma.SeriesWhereInput = {
      AND: [base, descriptionMatch, { NOT: titleMatch }],
    };

    const [count1, count2] = await this.prisma.$transaction([
      this.prisma.series.count({ where: tier1 }),
      this.prisma.series.count({ where: tier2 }),
    ]);
    const total = count1 + count2;

    const { skip1, take1, skip2, take2 } = computeTwoTierSlice(
      (page - 1) * limit,
      limit,
      count1,
    );
    const orderBy: Prisma.SeriesOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    const [tier1Page, tier2Page] = await Promise.all([
      take1 > 0
        ? this.prisma.series.findMany({
            where: tier1,
            include: SERIES_LIST_INCLUDE,
            orderBy,
            skip: skip1,
            take: take1,
          })
        : Promise.resolve([] as SeriesListRow[]),
      take2 > 0
        ? this.prisma.series.findMany({
            where: tier2,
            include: SERIES_LIST_INCLUDE,
            orderBy,
            skip: skip2,
            take: take2,
          })
        : Promise.resolve([] as SeriesListRow[]),
    ]);

    return { items: tier1Page.concat(tier2Page), total };
  }

  private facetsCache: { data: SeriesFacets; expiresAt: number } | null = null;

  /**
   * DB-derived filter options over PUBLISHED series — the series mirror of
   * MoviesService.getFacets (same public-set rule, same 60s in-memory TTL,
   * same "admin edits surface within a minute" trade-off). Series carry no
   * director/country/ageRating columns in v1, so those facets simply do not
   * exist here.
   */
  async getFacets(): Promise<SeriesFacets> {
    const now = Date.now();
    if (this.facetsCache && this.facetsCache.expiresAt > now) {
      return this.facetsCache.data;
    }

    const where: Prisma.SeriesWhereInput = { status: SeriesStatus.PUBLISHED };

    // Same `_count: true` + explicit orderBy shape as the movies facets —
    // display order comes from toFacetValues.
    const [genres, languages, years] = await this.prisma.$transaction([
      this.prisma.series.groupBy({
        by: ['genre'],
        where,
        _count: true,
        orderBy: { genre: 'asc' },
      }),
      this.prisma.series.groupBy({
        by: ['language'],
        where,
        _count: true,
        orderBy: { language: 'asc' },
      }),
      this.prisma.series.aggregate({
        where,
        _min: { releaseYear: true },
        _max: { releaseYear: true },
      }),
    ]);

    const data: SeriesFacets = {
      genres: toFacetValues(genres.map((g) => [g.genre, g._count])),
      languages: toFacetValues(languages.map((g) => [g.language, g._count])),
      years:
        years._min.releaseYear == null || years._max.releaseYear == null
          ? null
          : { min: years._min.releaseYear, max: years._max.releaseYear },
    };

    this.facetsCache = { data, expiresAt: now + FACETS_TTL_MS };
    return data;
  }

  async findByIdOrThrow(id: string): Promise<SeriesWithCategories> {
    const series = await this.prisma.series.findUnique({
      where: { id },
      include: { categories: true },
    });
    if (!series) throw new NotFoundException('Series not found');
    return this.withImageUrls(series);
  }

  /**
   * findByIdOrThrow plus the show-level visibility rule: a series that is
   * not PUBLISHED simply does not exist for regular users — the same
   * NotFoundException as a bogus id, so an unpublished show's presence
   * never leaks. Staff pass through untouched.
   */
  private async findViewableOrThrow(
    id: string,
    viewerRole: Role,
  ): Promise<SeriesWithCategories> {
    const series = await this.findByIdOrThrow(id);
    if (viewerRole === Role.USER && series.status !== SeriesStatus.PUBLISHED) {
      throw new NotFoundException('Series not found');
    }
    return series;
  }

  /** Detail shape for a viewer — access is a global per-user subscription flag, not per-item, so it isn't computed here. */
  async getForViewer(id: string, _userId: string, role: Role) {
    return this.findViewableOrThrow(id, role);
  }

  /**
   * Image URLs as they should be STORED — see MinioService.canonicalImageUrl.
   * The admin echoes a fetched record back on save when the artwork was not
   * touched, so without this a row would inherit whichever host that one save
   * request happened to arrive on.
   */
  private withCanonicalImageUrls<
    T extends { posterUrl?: string | null; coverUrl?: string | null },
  >(data: T): T {
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
   * Publish / unpublish — the one status transition endpoint. Deliberately
   * separate from update() so SERIES_MANAGE metadata edits can never flip
   * visibility as a side effect of echoing a stale form back.
   */
  async updateStatus(id: string, status: SeriesStatus) {
    await this.findByIdOrThrow(id);
    const updated = await this.prisma.series.update({
      where: { id },
      data: { status },
      include: { categories: true },
    });
    return this.withImageUrls(updated);
  }

  /**
   * Deletes the whole show: the series row, every episode (Movie rows —
   * the schema's onDelete: Cascade removes them and their Video/Subtitle/
   * WatchHistory/UploadSession children with the one series delete), and
   * then best-effort cleans their bytes out of MinIO, mirroring
   * MoviesService.remove's per-movie cleanup.
   *
   * Order matters: DB first, storage second — a failed storage call must
   * never leave broken DB rows behind. Storage failures are therefore
   * COLLECTED, not thrown: the caller gets storageCleanup 'partial' plus
   * the exact keys that survived, and the same list is logged at error
   * level, so a MinIO hiccup is visible to the admin but never rolls back
   * the catalog delete.
   */
  async remove(id: string): Promise<SeriesRemovalResult> {
    const series = await this.prisma.series.findUnique({
      where: { id },
      include: {
        episodes: { include: { videos: { include: { subtitles: true } } } },
      },
    });
    if (!series) throw new NotFoundException('Series not found');

    await this.prisma.series.delete({ where: { id } });

    const failedObjects: string[] = [];

    for (const episode of series.episodes) {
      // The whole HLS tree (original + renditions + bundle subtitles) lives
      // under this id-keyed prefix — unshareable by construction, no guard.
      const prefix = `videos/${episode.id}/`;
      try {
        await this.minioService.deleteByPrefix(prefix);
      } catch {
        failedObjects.push(prefix);
      }

      // Manually-uploaded subtitles live under the separate global
      // subtitles/<id>/ prefix and need deleting individually; bundle ones
      // were already caught by the prefix delete above. Same rule as
      // MoviesService.remove.
      for (const video of episode.videos) {
        for (const subtitle of video.subtitles) {
          if (subtitle.objectKey.startsWith(prefix)) continue;
          try {
            await this.minioService.deleteObject(subtitle.objectKey);
          } catch {
            failedObjects.push(subtitle.objectKey);
          }
        }
      }
    }

    // Image keys (episode poster/cover/thumbnail + series poster/cover) are
    // uuid-named under images/ and CAN be referenced by several rows, so
    // each key is deleted only after confirming no surviving movie or
    // series row still points at it (the rows being deleted are already
    // gone from the DB at this point and can't count as references).
    const imageKeys = new Set<string>();
    const collectImageKey = (url: string | null) => {
      if (!url) return;
      const key = this.minioService.keyFromPublicUrl(url);
      if (key) imageKeys.add(key);
    };
    for (const episode of series.episodes) {
      collectImageKey(episode.posterUrl);
      collectImageKey(episode.coverUrl);
      collectImageKey(episode.thumbnailUrl);
    }
    collectImageKey(series.posterUrl);
    collectImageKey(series.coverUrl);

    for (const key of imageKeys) {
      try {
        if (await this.isImageKeyStillReferenced(key)) continue;
        await this.minioService.deleteObject(key);
      } catch {
        failedObjects.push(key);
      }
    }

    if (failedObjects.length > 0) {
      this.logger.error(
        `Storage cleanup incomplete for deleted series ${id} — ${failedObjects.length} object(s)/prefix(es) not removed: ${failedObjects.join(', ')}`,
      );
    }

    return {
      deletedEpisodes: series.episodes.length,
      storageCleanup: failedObjects.length === 0 ? 'complete' : 'partial',
      failedObjects,
    };
  }

  /**
   * Shared-asset guard for image deletes: true when any OTHER movie or
   * series row (the deleted ones no longer exist in the DB) references a
   * URL containing this object key — deleting it would break that row's
   * artwork.
   */
  private async isImageKeyStillReferenced(key: string): Promise<boolean> {
    const [movieRefs, seriesRefs] = await Promise.all([
      this.prisma.movie.count({
        where: {
          OR: [
            { posterUrl: { contains: key } },
            { coverUrl: { contains: key } },
            { thumbnailUrl: { contains: key } },
          ],
        },
      }),
      this.prisma.series.count({
        where: {
          OR: [
            { posterUrl: { contains: key } },
            { coverUrl: { contains: key } },
          ],
        },
      }),
    ]);
    return movieRefs + seriesRefs > 0;
  }

  /** Distinct season numbers + per-season episode counts, e.g. [{seasonNumber: 1, episodeCount: 8}]. */
  async getSeasons(seriesId: string, viewerRole: Role) {
    await this.findViewableOrThrow(seriesId, viewerRole);
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
    await this.findViewableOrThrow(seriesId, viewerRole);

    const where: Prisma.MovieWhereInput = { seriesId };
    if (seasonNumber !== undefined) where.seasonNumber = seasonNumber;
    if (viewerRole === Role.USER) where.status = MovieStatus.PUBLISHED;

    return this.prisma.movie.findMany({
      where,
      include: CATALOG_INCLUDE,
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
    await this.findViewableOrThrow(seriesId, viewerRole);

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
        include: {
          ...CATALOG_INCLUDE,
          series: { select: { id: true, title: true } },
        },
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
