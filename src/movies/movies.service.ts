import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccessType,
  MovieStatus,
  Prisma,
  Role,
  type Actor,
  type Category,
  type Movie,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingService } from '../tracking/tracking.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { computeTwoTierSlice } from '../common/utils/two-tier-page.util';
import {
  facetStringFilter,
  numberRange,
} from '../common/utils/facet-filter.util';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateMovieDto } from './dto/create-movie.dto';
import type { UpdateMovieDto } from './dto/update-movie.dto';
import { MovieSort, type MovieQueryDto } from './dto/movie-query.dto';

/**
 * Every relation a Movie response carries. Exported because MovieResponseDto
 * turns an UNLOADED relation into `[]` — indistinguishable from "genuinely
 * empty" — so a query that forgets one hands the admin an empty cast, which
 * it then saves back as a deliberate deletion. Any query whose rows reach
 * MovieResponseDto must spread this rather than hand-rolling an include.
 */
export const CATALOG_INCLUDE = {
  categories: true,
  actors: true,
} satisfies Prisma.MovieInclude;

type MovieWithCategories = Movie & {
  categories: Category[];
  actors: Actor[];
};

/** One offered value of one facet, with how many PUBLIC movies carry it. */
export interface FacetValue {
  value: string;
  count: number;
}

export interface MovieFacets {
  genres: FacetValue[];
  languages: FacetValue[];
  countries: FacetValue[];
  ageRatings: FacetValue[];
  directors: FacetValue[];
  years: { min: number; max: number } | null;
}

const FACETS_TTL_MS = 60_000;

/**
 * groupBy rows -> offered facet values: null/empty values dropped (a movie
 * with no director is not a "director" option), sorted by count desc then
 * value asc. Counts are plain numbers straight from groupBy — no Decimals
 * anywhere near this.
 */
export function toFacetValues(
  pairs: Array<[string | null, unknown]>,
): FacetValue[] {
  return (
    pairs
      .filter(
        (pair): pair is [string, number] =>
          typeof pair[0] === 'string' && pair[0] !== '',
      )
      // With `_count: true` the count is always a plain number at runtime; the
      // generated groupBy type inside $transaction's array form is too wide to
      // prove it, hence the narrowing here instead of a cast at each call site.
      .map(([value, count]) => ({
        value,
        count: typeof count === 'number' ? count : 0,
      }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  );
}

/** The search predicate — title OR description, case-insensitive. */
export function movieSearchOr(search: string): Prisma.MovieWhereInput[] {
  return [
    { title: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } },
  ];
}

/**
 * Builds the catalog `where` from the canonical query — everything EXCEPT
 * the search term, which is applied by the caller (the relevance sort splits
 * it into two disjoint tiers; every other path ORs it in whole).
 *
 * Facet semantics: OR within a facet (genres, languages, actorIds,
 * directors, countries, ageRatings), AND across facets. Exported pure so the
 * spec can exercise every branch without a database.
 */
export function buildMovieWhere(
  query: MovieQueryDto,
  viewerRole: Role,
): Prisma.MovieWhereInput {
  const where: Prisma.MovieWhereInput = {};

  // Regular users can only browse published content; staff can filter freely.
  if (viewerRole === Role.USER) {
    where.status = MovieStatus.PUBLISHED;
    // Episodes never surface in the public movies catalog — they're
    // reached through their series (GET /series/:id/episodes).
    where.seriesId = null;
  } else {
    if (query.status) where.status = query.status;
    // The Movies module (All Movies, Movies Ready to Publish) manages
    // standalone movies only — episodes belong to the Series module's own
    // Ready to Publish view (GET /series/episodes). Passing seriesId
    // explicitly still lets staff tooling look up one series' episodes.
    where.seriesId = query.seriesId ?? null;
  }

  if (query.accessType) where.accessType = query.accessType;
  if (query.categoryId) where.categories = { some: { id: query.categoryId } };

  // Legacy ?genre= (the pre-filter-system deep-link contract) merges into
  // the canonical genres list rather than being a second code path.
  const genres = [
    ...(query.genres ?? []),
    ...(query.genre ? [query.genre] : []),
  ];
  const genreFilter = facetStringFilter(genres);
  if (genreFilter) where.genre = genreFilter;

  const languageFilter = facetStringFilter(query.languages ?? []);
  if (languageFilter) where.language = languageFilter;

  const directorFilter = facetStringFilter(query.directors ?? []);
  if (directorFilter) where.director = directorFilter;

  const countryFilter = facetStringFilter(query.countries ?? []);
  if (countryFilter) where.country = countryFilter;

  // "Any of the selected cast" — OR within the facet by construction.
  if (query.actorIds?.length) {
    where.actors = { some: { id: { in: query.actorIds } } };
  }

  if (query.ageRatings?.length) {
    where.ageRating = { in: query.ageRatings };
  }

  const yearRange = numberRange(query.yearFrom, query.yearTo);
  if (yearRange) where.releaseYear = yearRange;

  const ratingRange = numberRange(query.ratingMin, query.ratingMax);
  if (ratingRange) where.rating = ratingRange;

  // 0 is the unknown-runtime sentinel (a bulk-uploaded title whose probe
  // failed), not a short film: any duration filter floors at 1 so those rows
  // never match `Under 90 min` (FilterSheet.tsx:420, SearchFilterSheet.tsx:148)
  // or a custom range whose low edge is 0. numberRange() itself is left alone
  // — year and rating ranges must not inherit the floor.
  const durationRange = numberRange(query.durationMin, query.durationMax);
  if (durationRange) {
    where.duration = {
      ...durationRange,
      gte: Math.max(durationRange.gte ?? 1, 1),
    };
  }

  return where;
}

/**
 * orderBy for the plain (single-findMany) sorts. Every chain ends in `id` so
 * pagination is deterministic even across equal keys. The aggregate sorts
 * (mostViewed/mostPurchased) and relevance never reach this map.
 */
const SORT_ORDER_BY = {
  [MovieSort.RECENTLY_ADDED]: [{ createdAt: 'desc' }, { id: 'desc' }],
  [MovieSort.NEWEST]: [
    { releaseYear: 'desc' },
    { createdAt: 'desc' },
    { id: 'desc' },
  ],
  [MovieSort.OLDEST]: [
    { releaseYear: 'asc' },
    { createdAt: 'asc' },
    { id: 'asc' },
  ],
  [MovieSort.RATING]: [
    { rating: 'desc' },
    { createdAt: 'desc' },
    { id: 'desc' },
  ],
  [MovieSort.TITLE]: [{ title: 'asc' }, { id: 'asc' }],
} as const satisfies Partial<
  Record<MovieSort, Prisma.MovieOrderByWithRelationInput[]>
>;

export function movieOrderBy(
  sort: keyof typeof SORT_ORDER_BY,
): Prisma.MovieOrderByWithRelationInput[] {
  return [...SORT_ORDER_BY[sort]];
}

@Injectable()
export class MoviesService {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly trackingService: TrackingService,
  ) {}

  /**
   * `viewerId` is optional only so the many call sites that predate search
   * logging keep compiling; the catalog route always passes it, and it only
   * ever ends up as SearchQuery.userId.
   */
  async findAll(query: MovieQueryDto, viewerRole: Role, viewerId?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search?.trim() || undefined;

    // Relevance is only meaningful against a search term (the UI offers it
    // only while one is active); without one the server falls back to the
    // default rather than erroring on a stale deep link.
    let sort = query.sort ?? MovieSort.RECENTLY_ADDED;
    if (sort === MovieSort.RELEVANCE && !search) {
      sort = MovieSort.RECENTLY_ADDED;
    }

    const where = buildMovieWhere(query, viewerRole);

    let items: MovieWithCategories[];
    let total: number;

    if (sort === MovieSort.RELEVANCE) {
      ({ items, total } = await this.findRelevancePage(
        where,
        search!,
        page,
        limit,
      ));
    } else if (
      sort === MovieSort.MOST_VIEWED ||
      sort === MovieSort.MOST_PURCHASED
    ) {
      if (search) where.OR = movieSearchOr(search);
      ({ items, total } = await this.findAggregateOrderedPage(
        where,
        sort,
        page,
        limit,
      ));
    } else {
      if (search) where.OR = movieSearchOr(search);
      [items, total] = await this.prisma.$transaction([
        this.prisma.movie.findMany({
          where,
          include: CATALOG_INCLUDE,
          orderBy: movieOrderBy(sort),
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.movie.count({ where }),
      ]);
    }

    // Logged AFTER the query so `resultCount` is the real total this search
    // returned — whichever path computed it — not the size of the page being
    // read. Fire-and-forget by design: a search must never get slower, or
    // fail, because of tracking. Staff searches are dropped inside
    // recordSearch — an admin browsing the catalog through this same
    // endpoint is not user demand.
    if (query.search?.trim()) {
      this.trackingService.fireAndForget(
        'search',
        this.trackingService.recordSearch({
          term: query.search,
          resultCount: total,
          userId: viewerId ?? null,
          viewerRole,
        }),
      );
    }

    return { items, total, page, limit };
  }

  /**
   * The relevance sort: two-tier deterministic ranking over the real search
   * predicate — title matches (tier 1) strictly before description-only
   * matches (tier 2), each tier in recentlyAdded order. No faked scores, and
   * no Prisma full-text preview features (the generated client has no
   * `_relevance` orderBy). The tiers are disjoint by construction
   * (tier 2 excludes title matches), so count1 + count2 equals the plain
   * OR-count every other path reports for the same query.
   */
  private async findRelevancePage(
    base: Prisma.MovieWhereInput,
    search: string,
    page: number,
    limit: number,
  ): Promise<{ items: MovieWithCategories[]; total: number }> {
    const titleMatch: Prisma.MovieWhereInput = {
      title: { contains: search, mode: 'insensitive' },
    };
    const descriptionMatch: Prisma.MovieWhereInput = {
      description: { contains: search, mode: 'insensitive' },
    };
    const tier1: Prisma.MovieWhereInput = { AND: [base, titleMatch] };
    const tier2: Prisma.MovieWhereInput = {
      AND: [base, descriptionMatch, { NOT: titleMatch }],
    };

    const [count1, count2] = await this.prisma.$transaction([
      this.prisma.movie.count({ where: tier1 }),
      this.prisma.movie.count({ where: tier2 }),
    ]);
    const total = count1 + count2;

    const { skip1, take1, skip2, take2 } = computeTwoTierSlice(
      (page - 1) * limit,
      limit,
      count1,
    );
    const orderBy: Prisma.MovieOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    const [tier1Page, tier2Page] = await Promise.all([
      take1 > 0
        ? this.prisma.movie.findMany({
            where: tier1,
            include: CATALOG_INCLUDE,
            orderBy,
            skip: skip1,
            take: take1,
          })
        : Promise.resolve([] as MovieWithCategories[]),
      take2 > 0
        ? this.prisma.movie.findMany({
            where: tier2,
            include: CATALOG_INCLUDE,
            orderBy,
            skip: skip2,
            take: take2,
          })
        : Promise.resolve([] as MovieWithCategories[]),
    ]);

    return { items: tier1Page.concat(tier2Page), total };
  }

  /**
   * mostViewed / mostPurchased: an aggregate-ordered page.
   *
   * mostViewed ranks by UNIQUE VIEWERS — watch_history holds one row per
   * (user, movie) that actually started watching, so the groupBy count is
   * people, and cannot be inflated by one looping client the way a
   * seconds-sum over watch_activity could (that was the rejected
   * alternative). mostPurchased is the same algorithm over the FROZEN
   * pre-subscription purchases table — clients label it honestly.
   *
   * Algorithm: (1) one indexed groupBy for the per-movie counts; (2) an
   * id-only scan of the FILTERED set; (3) JS sort by count desc, createdAt
   * desc, id; (4) refetch just the page's ids with CATALOG_INCLUDE and
   * restore order. The id-only scan is fine to ~10k catalog rows; the
   * at-scale successor is a raw-SQL LEFT JOIN ... GROUP BY ... ORDER BY
   * count with LIMIT/OFFSET pushed into the database.
   */
  private async findAggregateOrderedPage(
    where: Prisma.MovieWhereInput,
    sort: MovieSort.MOST_VIEWED | MovieSort.MOST_PURCHASED,
    page: number,
    limit: number,
  ): Promise<{ items: MovieWithCategories[]; total: number }> {
    const grouped =
      sort === MovieSort.MOST_VIEWED
        ? await this.prisma.watchHistory.groupBy({
            by: ['movieId'],
            _count: { _all: true },
          })
        : await this.prisma.purchase.groupBy({
            by: ['movieId'],
            _count: { _all: true },
          });
    const countByMovieId = new Map(
      grouped.map((g) => [g.movieId, g._count._all]),
    );

    const rows = await this.prisma.movie.findMany({
      where,
      select: { id: true, createdAt: true },
    });
    rows.sort(
      (a, b) =>
        (countByMovieId.get(b.id) ?? 0) - (countByMovieId.get(a.id) ?? 0) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );

    const total = rows.length;
    const offset = (page - 1) * limit;
    const pageIds = rows.slice(offset, offset + limit).map((r) => r.id);
    if (pageIds.length === 0) return { items: [], total };

    // CATALOG_INCLUDE on the refetch too — these rows reach MovieResponseDto,
    // and an unloaded actors relation round-trips as a cast deletion via the
    // admin's edit dialog.
    const pageMovies = await this.prisma.movie.findMany({
      where: { id: { in: pageIds } },
      include: CATALOG_INCLUDE,
    });
    const byId = new Map(pageMovies.map((m) => [m.id, m]));
    const items = pageIds.flatMap((id) => {
      const movie = byId.get(id);
      return movie ? [movie] : [];
    });
    return { items, total };
  }

  private facetsCache: { data: MovieFacets; expiresAt: number } | null = null;

  /**
   * DB-derived filter options — only values that actually exist are offered,
   * which is what makes the clients' auto-hide rule honest (an empty facet
   * hides its control; no hard-coded genre/language lists anywhere).
   *
   * Always computed over the PUBLIC catalog set (PUBLISHED standalone
   * movies) regardless of the caller's role — facets feed the user-facing
   * filter sheet, and offering a value only drafts carry would produce
   * zero-result filters. Cached in-memory for 60s per instance: an admin
   * edit surfaces within a minute, which is acceptable and documented; no
   * invalidation hooks in v1.
   */
  async getFacets(): Promise<MovieFacets> {
    const now = Date.now();
    if (this.facetsCache && this.facetsCache.expiresAt > now) {
      return this.facetsCache.data;
    }

    const where: Prisma.MovieWhereInput = {
      status: MovieStatus.PUBLISHED,
      seriesId: null,
    };

    // `_count: true` (row count per group — plain number) + an explicit
    // orderBy, which Prisma's groupBy typing requires inside $transaction's
    // array form. Display order is applied by toFacetValues, not here.
    const [genres, languages, countries, ageRatings, directors, years] =
      await this.prisma.$transaction([
        this.prisma.movie.groupBy({
          by: ['genre'],
          where,
          _count: true,
          orderBy: { genre: 'asc' },
        }),
        this.prisma.movie.groupBy({
          by: ['language'],
          where,
          _count: true,
          orderBy: { language: 'asc' },
        }),
        this.prisma.movie.groupBy({
          by: ['country'],
          where,
          _count: true,
          orderBy: { country: 'asc' },
        }),
        this.prisma.movie.groupBy({
          by: ['ageRating'],
          where,
          _count: true,
          orderBy: { ageRating: 'asc' },
        }),
        this.prisma.movie.groupBy({
          by: ['director'],
          where,
          _count: true,
          orderBy: { director: 'asc' },
        }),
        this.prisma.movie.aggregate({
          where,
          _min: { releaseYear: true },
          _max: { releaseYear: true },
        }),
      ]);

    const data: MovieFacets = {
      genres: toFacetValues(genres.map((g) => [g.genre, g._count])),
      languages: toFacetValues(languages.map((g) => [g.language, g._count])),
      countries: toFacetValues(countries.map((g) => [g.country, g._count])),
      ageRatings: toFacetValues(ageRatings.map((g) => [g.ageRating, g._count])),
      directors: toFacetValues(directors.map((g) => [g.director, g._count])),
      years:
        years._min.releaseYear == null || years._max.releaseYear == null
          ? null
          : { min: years._min.releaseYear, max: years._max.releaseYear },
    };

    this.facetsCache = { data, expiresAt: now + FACETS_TTL_MS };
    return data;
  }

  async findByIdOrThrow(
    id: string,
    viewerRole: Role,
  ): Promise<MovieWithCategories> {
    const movie = await this.prisma.movie.findUnique({
      where: { id },
      include: CATALOG_INCLUDE,
    });

    if (
      !movie ||
      (viewerRole === Role.USER && movie.status !== MovieStatus.PUBLISHED)
    ) {
      throw new NotFoundException('Movie not found');
    }

    return movie;
  }

  /**
   * Image URLs as they should be STORED — see MinioService.canonicalImageUrl.
   * Responses re-host these per request, and the admin's edit dialog sends a
   * fetched movie's URLs straight back when the artwork was not changed, so
   * without this a row would inherit whichever host that one save arrived on.
   */
  private withCanonicalImageUrls<
    T extends {
      posterUrl?: string | null;
      coverUrl?: string | null;
      thumbnailUrl?: string | null;
    },
  >(data: T): T {
    const canon = (value: string | null | undefined) =>
      this.minioService.canonicalImageUrl(value);
    return {
      ...data,
      ...(data.posterUrl !== undefined
        ? { posterUrl: canon(data.posterUrl) }
        : {}),
      ...(data.coverUrl !== undefined
        ? { coverUrl: canon(data.coverUrl) }
        : {}),
      ...(data.thumbnailUrl !== undefined
        ? { thumbnailUrl: canon(data.thumbnailUrl) }
        : {}),
    };
  }

  /**
   * The admin's optional-metadata fields clear by submitting an empty
   * string (a blanked text input), which must persist as NULL — an empty
   * string would count as a real facet value and un-hide the filter.
   * Only touches keys that are present, so a partial update leaves absent
   * fields alone.
   */
  private withNormalizedOptionalMetadata<
    T extends { director?: string | null; country?: string | null },
  >(data: T): T {
    const emptyToNull = (value: string | null | undefined) =>
      typeof value === 'string' && value.trim() === '' ? null : value;
    return {
      ...data,
      ...(data.director !== undefined
        ? { director: emptyToNull(data.director) }
        : {}),
      ...(data.country !== undefined
        ? { country: emptyToNull(data.country) }
        : {}),
    };
  }

  async create(dto: CreateMovieDto): Promise<Movie> {
    const { categoryIds, actorIds, ...data } = dto;
    return this.prisma.movie.create({
      data: {
        ...this.withNormalizedOptionalMetadata(
          this.withCanonicalImageUrls(data),
        ),
        categories: categoryIds
          ? { connect: categoryIds.map((id) => ({ id })) }
          : undefined,
        actors: actorIds
          ? { connect: actorIds.map((id) => ({ id })) }
          : undefined,
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
   *
   * With `series` set, the placeholder is an episode: it inherits the show's
   * genre/language/releaseYear so the row is coherent from birth even before
   * the admin edits it, and carries its season/episode position.
   *
   * `options.duration` is the runtime (whole minutes) the uploader probed
   * from the bundle in the browser. Writing it at row birth is what keeps
   * the human-over-automatic rule trivially true: there is no existing value
   * to overwrite. Absent, the row is born with the 0 sentinel exactly as
   * before and finalize/backfill may fill it later.
   */
  async createUploadPlaceholder(
    title: string,
    series?: { seriesId: string; seasonNumber: number; episodeNumber: number },
    options?: { duration?: number },
  ): Promise<Movie> {
    let inherited: {
      genre: string;
      language: string;
      releaseYear: number;
    } | null = null;
    if (series) {
      const show = await this.prisma.series.findUnique({
        where: { id: series.seriesId },
      });
      if (!show) throw new NotFoundException('Series not found');
      inherited = {
        genre: show.genre,
        language: show.language,
        releaseYear: show.releaseYear,
      };
    }

    return this.prisma.movie.create({
      data: {
        title,
        description: '',
        genre: inherited?.genre ?? '',
        language: inherited?.language ?? '',
        releaseYear: inherited?.releaseYear ?? new Date().getFullYear(),
        duration: options?.duration ?? 0,
        accessType: AccessType.SUBSCRIPTION,
        status: MovieStatus.UPLOADING,
        seriesId: series?.seriesId,
        seasonNumber: series?.seasonNumber,
        episodeNumber: series?.episodeNumber,
      },
    });
  }

  async update(id: string, dto: UpdateMovieDto): Promise<Movie> {
    await this.assertExists(id);
    const { categoryIds, actorIds, ...data } = dto;

    return this.prisma.movie.update({
      where: { id },
      data: {
        ...this.withNormalizedOptionalMetadata(
          this.withCanonicalImageUrls(data),
        ),
        categories: categoryIds
          ? { set: categoryIds.map((cid) => ({ id: cid })) }
          : undefined,
        // `set`, not `connect`: the cast the admin submits is the whole cast,
        // so anyone dropped from the list has to come off the film too.
        actors: actorIds
          ? { set: actorIds.map((aid) => ({ id: aid })) }
          : undefined,
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
      this.logger.warn(
        `Failed to clean up storage for deleted movie ${id}: ${(error as Error).message}`,
      );
    }
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
      where: {
        id: { in: grouped.map((g) => g.movieId) },
        status: MovieStatus.PUBLISHED,
      },
      include: CATALOG_INCLUDE,
    });

    const orderById = new Map(grouped.map((g, index) => [g.movieId, index]));
    return movies.sort(
      (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
    );
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
        include: {
          movie: { select: { id: true, title: true, posterUrl: true } },
        },
      }),
      this.prisma.purchase.count({ where: { userId } }),
    ]);

    return {
      items: items.map((p) => ({
        id: p.id,
        movieId: p.movieId,
        movieTitle: p.movie.title,
        posterUrl: this.minioService.imageUrl(p.movie.posterUrl),
        amount: decimalToNumber(p.amount),
        createdAt: p.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Current lifecycle status only. Movies publish through the edit route's
   * `status` field, so the PUT /movies/:id gate has to know which direction
   * the edit is moving before it can pick MOVIES.PUBLISH vs MOVIES.UNPUBLISH.
   */
  async getStatusOrThrow(id: string): Promise<MovieStatus> {
    const movie = await this.prisma.movie.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    return movie.status;
  }

  private async assertExists(id: string): Promise<void> {
    const exists = await this.prisma.movie.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Movie not found');
  }
}
