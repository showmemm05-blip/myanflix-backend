import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TmdbLookupStatus,
  type Actor,
  type AgeRating,
  type Category,
  type Movie,
  type Series,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { movieSnapshot, seriesSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { replacedTmdbImageKeys } from '../images/image-source';
import {
  ImageStoreService,
  imageUploadByteLimit,
} from '../images/image-store.service';
import type { MovieQualitySource } from '../movies/dto/movie-response.dto';
import { CATALOG_INCLUDE } from '../movies/movies.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  applyChanges,
  decideField,
  fieldStanding,
  isUntouched,
  mergeAutoList,
  previewLineState,
  readTmdbAuto,
  sameIdSet,
  type ImageKeyOf,
  type TmdbAuto,
  type TmdbFieldChange,
  type TmdbFieldStanding,
  type TmdbFillMode,
  type TmdbTitleView,
} from './tmdb-auto';
import { TmdbCastService, type TmdbCastPlanEntry } from './tmdb-cast.service';
import {
  TMDB_ERRORS,
  tmdbError,
  tmdbFailureException,
  tmdbNotConfigured,
  type TmdbFailureReason,
} from './tmdb-errors';
import { TmdbImageFetcher } from './tmdb-image.fetcher';
import {
  TMDB_PREVIEW_SIZES,
  tmdbImageUrl,
  type TmdbImageKind,
} from './tmdb-image-url';
import {
  mapMovieDetails,
  mapTvDetails,
  matchCategories,
  type TmdbProposal,
} from './tmdb-mapping';
import {
  TmdbRunRegistry,
  movieRunKey,
  seriesRunKey,
  tvCreateRunKey,
} from './tmdb-runs';
import { movieView, seriesView } from './tmdb-title-view';
import { TmdbClient } from './tmdb.client';
import {
  tmdbFieldsFor,
  type TmdbField,
  type TmdbFillReport,
  type TmdbPreview,
  type TmdbPreviewLine,
  type TmdbPreviewValue,
  type TmdbTitleKind,
} from './tmdb.types';

/** A movie as every fill reads and returns it: with the relations MovieResponseDto needs. */
export type TmdbMovieRow = Movie & {
  categories: Category[];
  actors: Actor[];
  videos: MovieQualitySource[];
};

/** A series with the relations every series response carries (SeriesService's own include). */
export type TmdbSeriesRow = Series & {
  categories: Category[];
  actors: Actor[];
};

const SERIES_INCLUDE = {
  categories: true,
  actors: true,
} satisfies Prisma.SeriesInclude;

/** The two picture columns a fill writes — what a replaced TMDB picture is looked for in. */
const FILL_IMAGE_FIELDS = ['posterUrl', 'coverUrl'] as const;

type DbClient = Prisma.TransactionClient | PrismaService;

/** The scalar columns a fill may write. A key that is present is written. */
interface TitleColumns {
  title?: string;
  description?: string;
  releaseYear?: number;
  duration?: number;
  genre?: string;
  language?: string;
  country?: string | null;
  director?: string | null;
  ageRating?: AgeRating | null;
  posterUrl?: string | null;
  coverUrl?: string | null;
}

/** One write of a fill: the changed columns and lists, and the TMDB bookkeeping that always goes with them. */
interface TitleWrite {
  columns: TitleColumns;
  /** The whole list to set; absent = the list is not written. */
  categoryIds?: string[];
  actorIds?: string[];
  tmdbId: number;
  tmdbFetchedAt: Date;
  tmdbAuto: TmdbAuto;
}

/** What differs between filling a movie and filling a series. */
interface TitleOps<Row> {
  kind: TmdbTitleKind;
  /** The image folder its pictures are stored in. */
  purpose: 'movie' | 'series';
  auditAction: 'movie.update' | 'series.update';
  load(client: DbClient, id: string): Promise<Row | null>;
  /** Takes the row lock for the rest of the transaction. */
  lock(tx: Prisma.TransactionClient, id: string): Promise<void>;
  view(row: Row): TmdbTitleView;
  write(
    tx: Prisma.TransactionClient,
    id: string,
    data: TitleWrite,
  ): Promise<Row>;
  snapshot(row: Row): Record<string, unknown>;
}

/** The fields every stored title has, whichever catalogue it is in. */
interface StoredTitle {
  id: string;
  title: string;
  posterUrl: string | null;
  coverUrl: string | null;
  tmdbAuto: Prisma.JsonValue | null;
  categories: Category[];
  actors: Actor[];
}

interface FillRequest {
  mode: TmdbFillMode;
  /** The fields to consider: every field of the kind for an automatic fill, what staff switched on for an apply. */
  fields: readonly TmdbField[];
  /** For the audit row: started by the upload itself, or by a staff member. */
  trigger: 'upload' | 'staff';
  user: AuthenticatedUser;
  /** False for the pictures and cast of a show that was just created: that run records one series.create instead. */
  audit: boolean;
}

/** What an unreviewed fill of a movie came to — the lookup turns it into a status. */
export type TmdbAutomaticFill =
  | { outcome: 'filled'; report: TmdbFillReport }
  /** The movie was deleted while its details were being fetched. */
  | { outcome: 'gone' }
  | { outcome: 'failed'; reason: TmdbFailureReason };

const emptyReport = (): TmdbFillReport => ({
  filled: [],
  skipped: [],
  actors: { reused: 0, created: 0, skipped: [] },
  categories: { added: [], unmatched: [] },
});

/** The change that puts a field back to its empty placeholder (never asked for title / releaseYear). */
function resetChange(field: TmdbField): TmdbFieldChange | null {
  switch (field) {
    case 'title':
    case 'releaseYear':
      return null;
    default:
      return { field, value: null };
  }
}

/** Whether TMDB has a value for a scalar or picture field. */
function proposalHasValue(field: TmdbField, proposal: TmdbProposal): boolean {
  switch (field) {
    case 'poster':
      return proposal.posterPath !== null;
    case 'cover':
      return proposal.coverPath !== null;
    case 'categories':
      return proposal.categoryWords.length > 0;
    case 'cast':
      return proposal.cast.length > 0;
    default:
      return proposal[field] !== null;
  }
}

/** The write of one scalar field from TMDB's value; null when TMDB has none. */
function scalarChange(
  field: TmdbField,
  proposal: TmdbProposal,
): TmdbFieldChange | null {
  switch (field) {
    case 'title':
      return proposal.title === null ? null : { field, value: proposal.title };
    case 'releaseYear':
      return proposal.releaseYear === null
        ? null
        : { field, value: proposal.releaseYear };
    case 'description':
    case 'duration':
    case 'genre':
    case 'language':
    case 'country':
    case 'director':
    case 'ageRating': {
      const value = proposal[field];
      return value === null ? null : ({ field, value } as TmdbFieldChange);
    }
    default:
      return null;
  }
}

/** The columns the given changes touch, with the values they come to. */
function columnsOf(
  changes: readonly TmdbFieldChange[],
  view: TmdbTitleView,
): TitleColumns {
  const columns: TitleColumns = {};
  for (const { field } of changes) {
    switch (field) {
      case 'title':
        columns.title = view.title;
        break;
      case 'description':
        columns.description = view.description;
        break;
      case 'releaseYear':
        columns.releaseYear = view.releaseYear;
        break;
      case 'duration':
        columns.duration = view.duration;
        break;
      case 'genre':
        columns.genre = view.genre;
        break;
      case 'language':
        columns.language = view.language;
        break;
      case 'country':
        columns.country = view.country;
        break;
      case 'director':
        columns.director = view.director;
        break;
      case 'ageRating':
        columns.ageRating = view.ageRating;
        break;
      case 'poster':
        columns.posterUrl = view.posterUrl;
        break;
      case 'cover':
        columns.coverUrl = view.coverUrl;
        break;
      case 'categories':
      case 'cast':
        // Lists are written as relations, not columns.
        break;
    }
  }
  return columns;
}

/**
 * Fills a title from one TMDB entry: the review (preview), the write
 * (apply, and the unreviewed fill after an upload), and a show created
 * from TMDB (PLAN.md 2.6 to 2.11, 5.3 and 5.4 of
 * docs/movie-details-tmdb-2026-11-06).
 *
 * One write always runs in this order: fetch the details from TMDB → map
 * them to our words → read the title → decide, field by field, what may be
 * written (tmdb-auto.ts: staff's own values are never taken by an
 * unreviewed fill) → resolve the cast and store the pictures → then, in
 * ONE transaction holding the row lock, read the title again, drop any
 * field staff changed meanwhile, and write the row together with its TMDB
 * bookkeeping (`tmdbId`, `tmdbFetchedAt`, `tmdbAuto`; a movie also
 * `tmdbStatus = MATCHED`) → delete the TMDB pictures that were replaced or
 * never used → audit.
 *
 * It never writes `status`, the access type, the star rating, the Burmese
 * description or the thumbnail, and never touches an episode.
 */
@Injectable()
export class TmdbFillService {
  private readonly logger = new Logger(TmdbFillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TmdbClient,
    private readonly images: TmdbImageFetcher,
    private readonly imageStore: ImageStoreService,
    private readonly cast: TmdbCastService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
    private readonly runs: TmdbRunRegistry,
  ) {}

  private readonly keyOf: ImageKeyOf = (url) =>
    this.minioService.keyFromPublicUrl(url);

  private readonly movieOps: TitleOps<TmdbMovieRow> = {
    kind: 'movie',
    purpose: 'movie',
    auditAction: 'movie.update',
    load: (client, id) =>
      client.movie.findUnique({ where: { id }, include: CATALOG_INCLUDE }),
    lock: async (tx, id) => {
      await tx.$queryRaw`SELECT "id" FROM "movies" WHERE "id" = ${id} FOR UPDATE`;
    },
    view: movieView,
    write: (tx, id, data) =>
      tx.movie.update({
        where: { id },
        data: {
          ...data.columns,
          ...(data.categoryIds
            ? {
                categories: {
                  set: data.categoryIds.map((cid) => ({ id: cid })),
                },
              }
            : {}),
          ...(data.actorIds
            ? { actors: { set: data.actorIds.map((aid) => ({ id: aid })) } }
            : {}),
          tmdbId: data.tmdbId,
          tmdbFetchedAt: data.tmdbFetchedAt,
          tmdbAuto: data.tmdbAuto as unknown as Prisma.InputJsonObject,
          // The title is linked now, whatever the lookup said before.
          tmdbStatus: TmdbLookupStatus.MATCHED,
          tmdbError: null,
        },
        include: CATALOG_INCLUDE,
      }),
    snapshot: (row) => movieSnapshot(row),
  };

  private readonly seriesOps: TitleOps<TmdbSeriesRow> = {
    kind: 'series',
    purpose: 'series',
    auditAction: 'series.update',
    load: (client, id) =>
      client.series.findUnique({ where: { id }, include: SERIES_INCLUDE }),
    lock: async (tx, id) => {
      await tx.$queryRaw`SELECT "id" FROM "series" WHERE "id" = ${id} FOR UPDATE`;
    },
    view: seriesView,
    write: (tx, id, data) => {
      // A series has no runtime, director or age rating column.
      const columns: TitleColumns = { ...data.columns };
      delete columns.duration;
      delete columns.director;
      delete columns.ageRating;
      return tx.series.update({
        where: { id },
        data: {
          ...columns,
          ...(data.categoryIds
            ? {
                categories: {
                  set: data.categoryIds.map((cid) => ({ id: cid })),
                },
              }
            : {}),
          ...(data.actorIds
            ? { actors: { set: data.actorIds.map((aid) => ({ id: aid })) } }
            : {}),
          tmdbId: data.tmdbId,
          tmdbFetchedAt: data.tmdbFetchedAt,
          tmdbAuto: data.tmdbAuto as unknown as Prisma.InputJsonObject,
        },
        include: SERIES_INCLUDE,
      });
    },
    snapshot: (row) => seriesSnapshot(row),
  };

  // -------------------------------------------------------------------
  // Movies
  // -------------------------------------------------------------------

  /** The review of one TMDB film against one of our movies. Writes nothing and downloads no picture. */
  async previewMovie(
    movieId: string,
    tmdbId: number,
    user: AuthenticatedUser,
  ): Promise<TmdbPreview> {
    this.assertConfigured();
    await this.loadStandaloneMovieOrThrow(movieId);
    const proposal = await this.movieProposalOrThrow(tmdbId);
    // Read again after the TMDB call: the review shows the title as it is now.
    const movie = await this.loadStandaloneMovieOrThrow(movieId);
    return this.buildPreview(this.movieOps, movie, proposal, user);
  }

  /**
   * Apply after the review: writes exactly `fields` from that TMDB film and
   * links the movie to it. A field that was not named is only ever taken
   * back: one that still holds the previous match's value while this film
   * has none for it (see `fill`). One run per movie at a time (409
   * TMDB_BUSY).
   */
  async applyMovie(
    movieId: string,
    tmdbId: number,
    fields: readonly TmdbField[],
    user: AuthenticatedUser,
  ): Promise<{ movie: TmdbMovieRow; report: TmdbFillReport }> {
    this.assertConfigured();
    return this.runs.exclusive(movieRunKey(movieId), async () => {
      await this.loadStandaloneMovieOrThrow(movieId);
      const proposal = await this.movieProposalOrThrow(tmdbId);
      const filled = await this.fill(this.movieOps, movieId, proposal, {
        mode: 'staff',
        fields,
        trigger: 'staff',
        user,
        audit: true,
      });
      if (!filled) throw new NotFoundException('Movie not found');
      return { movie: filled.row, report: filled.report };
    });
  }

  /**
   * The unreviewed fill of the automatic path: every field staff have not
   * changed is written from the one clear match. The CALLER holds the
   * movie's run (TmdbLookupService) — this method does not take it — and
   * turns the result into the lookup status; nothing is thrown for a TMDB
   * failure or a deleted movie.
   */
  async fillMovieAutomatically(
    movieId: string,
    tmdbId: number,
    user: AuthenticatedUser,
    trigger: 'upload' | 'staff',
  ): Promise<TmdbAutomaticFill> {
    const details = await this.client.movieDetails(tmdbId);
    if (!details.ok) return { outcome: 'failed', reason: details.reason };
    const filled = await this.fill(
      this.movieOps,
      movieId,
      mapMovieDetails(details.data),
      {
        mode: 'automatic',
        fields: tmdbFieldsFor('movie'),
        trigger,
        user,
        audit: true,
      },
    );
    return filled
      ? { outcome: 'filled', report: filled.report }
      : { outcome: 'gone' };
  }

  // -------------------------------------------------------------------
  // Series
  // -------------------------------------------------------------------

  /** The review of one TMDB show against one of our series. Writes nothing and downloads no picture. */
  async previewSeries(
    seriesId: string,
    tmdbId: number,
    user: AuthenticatedUser,
  ): Promise<TmdbPreview> {
    this.assertConfigured();
    await this.loadSeriesOrThrow(seriesId);
    const proposal = await this.tvProposalOrThrow(tmdbId);
    const series = await this.loadSeriesOrThrow(seriesId);
    return this.buildPreview(this.seriesOps, series, proposal, user);
  }

  /** Apply after the review, for a show: writes exactly `fields` (and takes back what applyMovie would) and links the series. */
  async applySeries(
    seriesId: string,
    tmdbId: number,
    fields: readonly TmdbField[],
    user: AuthenticatedUser,
  ): Promise<{ series: TmdbSeriesRow; report: TmdbFillReport }> {
    this.assertConfigured();
    return this.runs.exclusive(seriesRunKey(seriesId), async () => {
      await this.loadSeriesOrThrow(seriesId);
      const proposal = await this.tvProposalOrThrow(tmdbId);
      const filled = await this.fill(this.seriesOps, seriesId, proposal, {
        mode: 'staff',
        fields,
        trigger: 'staff',
        user,
        audit: true,
      });
      if (!filled) throw new NotFoundException('Series not found');
      return { series: filled.row, report: filled.report };
    });
  }

  /**
   * "Find on TMDB" for a new show: creates the series from that TMDB entry
   * as a DRAFT. The details are fetched first, so nothing is created when
   * TMDB cannot be read. Then the row is born with the text TMDB has ('' /
   * no type where it has none, this year when it has no first-air date)
   * and a tmdbAuto that remembers every value written — so a later Refill
   * may replace them and staff's edits are recognised. Pictures,
   * categories and cast follow with the automatic rule; a failure there is
   * logged and reported and never undoes the show.
   *
   * 409 TMDB_SERIES_EXISTS (with `seriesId`) when one of our series is
   * already linked to this entry; two creations of the same entry at once
   * are kept apart by the run registry (409 TMDB_BUSY).
   */
  async createSeries(
    tmdbId: number,
    user: AuthenticatedUser,
  ): Promise<{ series: TmdbSeriesRow; report: TmdbFillReport }> {
    this.assertConfigured();
    return this.runs.exclusive(tvCreateRunKey(tmdbId), async () => {
      const existing = await this.prisma.series.findFirst({
        where: { tmdbId },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        throw tmdbError(
          HttpStatus.CONFLICT,
          TMDB_ERRORS.SERIES_EXISTS,
          'This series already exists',
          { seriesId: existing.id },
        );
      }
      const proposal = await this.tvProposalOrThrow(tmdbId);
      const title = proposal.title ?? proposal.match.title;
      // A show TMDB has no name for cannot become a title of ours.
      if (title === '') throw tmdbFailureException('bad_response');

      const now = new Date();
      const report = emptyReport();
      const born: TmdbFieldChange[] = [
        { field: 'title', value: title },
        // This year stands in for a missing first-air date; it is remembered
        // as automatic either way, so a Refill can still correct it.
        {
          field: 'releaseYear',
          value: proposal.releaseYear ?? now.getFullYear(),
        },
      ];
      report.filled.push('title');
      if (proposal.releaseYear === null) {
        report.skipped.push({ field: 'releaseYear', reason: 'no_value' });
      } else {
        report.filled.push('releaseYear');
      }
      for (const field of [
        'description',
        'genre',
        'language',
        'country',
      ] as const) {
        const change = scalarChange(field, proposal);
        if (change) {
          born.push(change);
          report.filled.push(field);
        } else {
          report.skipped.push({ field, reason: 'no_value' });
        }
      }
      const blank: TmdbTitleView = {
        title,
        description: '',
        releaseYear: now.getFullYear(),
        duration: 0,
        genre: '',
        language: '',
        country: null,
        director: null,
        ageRating: null,
        posterUrl: null,
        coverUrl: null,
        categoryIds: [],
        actorIds: [],
      };
      const { view, auto } = applyChanges(blank, null, born);

      const created = await this.prisma.series.create({
        data: {
          title: view.title,
          description: view.description,
          genre: view.genre,
          language: view.language,
          country: view.country,
          releaseYear: view.releaseYear,
          tmdbId,
          tmdbFetchedAt: now,
          tmdbAuto: {
            ...auto,
            match: proposal.match,
          } as unknown as Prisma.InputJsonObject,
        },
        include: SERIES_INCLUDE,
      });

      let series: TmdbSeriesRow = created;
      try {
        const rest = await this.fill(this.seriesOps, created.id, proposal, {
          mode: 'automatic',
          fields: ['poster', 'cover', 'categories', 'cast'],
          trigger: 'staff',
          user,
          audit: false,
        });
        if (rest) {
          series = rest.row;
          report.filled.push(...rest.report.filled);
          report.skipped.push(...rest.report.skipped);
          report.actors = rest.report.actors;
          report.categories = rest.report.categories;
        }
      } catch (error) {
        // The show exists and is correct as far as it goes; staff can
        // Refill it for the pictures and the cast.
        this.logger.error(
          `Series ${created.id} was created from TMDB ${tmdbId}, but its pictures and cast could not be added`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      const order = tmdbFieldsFor('series');
      report.filled = order.filter((field) => report.filled.includes(field));
      report.skipped.sort(
        (a, b) => order.indexOf(a.field) - order.indexOf(b.field),
      );

      await this.audit.record({
        action: 'series.create',
        actor: user,
        target: { type: 'series', id: series.id, label: series.title },
        after: seriesSnapshot(series),
        metadata: { via: 'tmdb', tmdbId },
      });
      return { series, report };
    });
  }

  // -------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------

  /** Every route of this service needs TMDB: 503 while TMDB_API_KEY is missing. */
  private assertConfigured(): void {
    if (!this.client.isEnabled) throw tmdbNotConfigured();
  }

  /** The movie, or 404; an episode is refused — episodes are not filled from TMDB. */
  private async loadStandaloneMovieOrThrow(id: string): Promise<TmdbMovieRow> {
    const movie = await this.movieOps.load(this.prisma, id);
    if (!movie) throw new NotFoundException('Movie not found');
    if (movie.seriesId !== null) {
      throw tmdbError(
        HttpStatus.BAD_REQUEST,
        TMDB_ERRORS.NOT_A_MOVIE,
        'Episodes are not filled from TMDB',
      );
    }
    return movie;
  }

  private async loadSeriesOrThrow(id: string): Promise<TmdbSeriesRow> {
    const series = await this.seriesOps.load(this.prisma, id);
    if (!series) throw new NotFoundException('Series not found');
    return series;
  }

  private async movieProposalOrThrow(tmdbId: number): Promise<TmdbProposal> {
    const details = await this.client.movieDetails(tmdbId);
    if (!details.ok) throw tmdbFailureException(details.reason);
    return mapMovieDetails(details.data);
  }

  private async tvProposalOrThrow(tmdbId: number): Promise<TmdbProposal> {
    const details = await this.client.tvDetails(tmdbId);
    if (!details.ok) throw tmdbFailureException(details.reason);
    return mapTvDetails(details.data);
  }

  /** Every category of ours — a handful of rows, read when a fill or a review looks at the categories. */
  private loadCategories(): Promise<Array<{ id: string; name: string }>> {
    return this.prisma.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Fetches one TMDB picture and stores it through ImageStoreService — the
   * byte cap, magic-byte check, resize and `image.upload` audit row of a
   * staff upload, under a tmdb-<uuid> file name. Null when it could not be
   * fetched or is not an image: the caller reports it and saves the rest.
   */
  private async storePicture(
    kind: TmdbImageKind,
    purpose: 'movie' | 'series',
    path: string,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    try {
      const fetched = await this.images.fetch(
        kind,
        path,
        imageUploadByteLimit(purpose),
      );
      if (!fetched.ok) return null;
      return await this.imageStore.save(
        purpose,
        path.slice(1),
        fetched.buffer,
        user,
        { source: 'tmdb', sourceRef: path },
      );
    } catch (error) {
      this.logger.warn(
        `Could not store the TMDB ${kind} ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Best-effort removal of stored TMDB pictures nothing points at. Never throws. */
  private async deleteObjects(
    keys: readonly string[],
    why: string,
  ): Promise<void> {
    for (const key of keys) {
      try {
        await this.minioService.deleteObject(key);
      } catch (error) {
        this.logger.warn(
          `Failed to delete the ${why} TMDB image ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private keysOf(urls: readonly string[]): string[] {
    return urls
      .map((url) => this.keyOf(url))
      .filter((key): key is string => key !== null);
  }

  /**
   * The write itself — see the class comment for the order. Returns null
   * when the title no longer exists (deleted while its details were being
   * fetched): nothing is written and the pictures stored for it are
   * removed again.
   */
  private async fill<Row extends StoredTitle>(
    ops: TitleOps<Row>,
    id: string,
    proposal: TmdbProposal,
    request: FillRequest,
  ): Promise<{ row: Row; report: TmdbFillReport } | null> {
    const stored = await ops.load(this.prisma, id);
    if (!stored) return null;
    const view = ops.view(stored);
    const auto = readTmdbAuto(stored.tmdbAuto);
    const considered = tmdbFieldsFor(ops.kind).filter((field) =>
      request.fields.includes(field),
    );

    const report = emptyReport();
    const skip = (
      field: TmdbField,
      reason: 'hand' | 'no_value' | 'image_failed',
    ) => report.skipped.push({ field, reason });
    const changes: TmdbFieldChange[] = [];
    /** Fields that hold TMDB's value after this run without a change (the same picture again). */
    const kept: TmdbField[] = [];
    /** Pictures this run stored, by field — removed again if the field is not written after all. */
    const storedPictures = new Map<TmdbField, string>();

    const categoryMatch = considered.includes('categories')
      ? matchCategories(proposal.categoryWords, await this.loadCategories())
      : { matched: [], unmatched: [] };
    report.categories.unmatched = categoryMatch.unmatched;

    /** No TMDB value: back to the placeholder when it was automatic, else left alone. */
    const withoutValue = (field: TmdbField, standing: TmdbFieldStanding) => {
      const reset =
        decideField(field, standing, false, request.mode) === 'reset'
          ? resetChange(field)
          : null;
      if (reset) changes.push(reset);
      skip(field, 'no_value');
    };

    // A staff apply names only the lines that had a switch, and a line TMDB
    // has nothing for has none (the review draws it as "none"). What the
    // previous match put in such a field must still not stay on a title
    // that is now linked to this entry (PLAN.md 2.9): a field that was not
    // named, still holds its automatic value and has no value here goes
    // back to its placeholder. "No value" is the review's own test
    // (buildPreview). What staff typed and what is empty are left alone,
    // and so is a line staff switched off while TMDB had a value for it.
    /** Fields taken back without being named — checked again under the row lock. */
    const takenBack = new Set<TmdbField>();
    if (request.mode === 'staff') {
      for (const field of tmdbFieldsFor(ops.kind)) {
        if (considered.includes(field)) continue;
        if (fieldStanding(field, view, auto, this.keyOf) !== 'auto') continue;
        const reset = resetChange(field);
        if (!reset) continue;
        let hasValue: boolean;
        if (field === 'categories') {
          const match = matchCategories(
            proposal.categoryWords,
            // No genre at all: there is nothing to look our categories up for.
            proposal.categoryWords.length > 0
              ? await this.loadCategories()
              : [],
          );
          hasValue = match.matched.length > 0;
          if (!hasValue) report.categories.unmatched = match.unmatched;
        } else if (field === 'cast') {
          hasValue =
            proposal.cast.length > 0 &&
            (await this.cast.plan(proposal.cast, request.user)).some(
              (entry) => entry.action === 'reuse' || entry.action === 'create',
            );
        } else {
          hasValue = proposalHasValue(field, proposal);
        }
        if (hasValue) continue;
        changes.push(reset);
        takenBack.add(field);
        skip(field, 'no_value');
      }
    }

    const slow: Array<Promise<void>> = [];
    for (const field of considered) {
      const standing = fieldStanding(field, view, auto, this.keyOf);
      const hasValue =
        field === 'categories'
          ? categoryMatch.matched.length > 0
          : proposalHasValue(field, proposal);
      const decision = decideField(field, standing, hasValue, request.mode);
      if (decision === 'skip_hand') {
        skip(field, 'hand');
        continue;
      }
      if (decision !== 'write') {
        withoutValue(field, standing);
        continue;
      }

      if (field === 'poster' || field === 'cover') {
        const path =
          field === 'poster' ? proposal.posterPath : proposal.coverPath;
        const rememberedPath =
          field === 'poster' ? auto?.posterPath : auto?.coverPath;
        if (path === null) continue;
        // The row still shows the very picture TMDB has: nothing to fetch.
        if (standing === 'auto' && rememberedPath === path) {
          kept.push(field);
          continue;
        }
        slow.push(
          this.storePicture(
            field === 'poster' ? 'poster' : 'backdrop',
            ops.purpose,
            path,
            request.user,
          ).then((url) => {
            if (url === null) {
              skip(field, 'image_failed');
              return;
            }
            storedPictures.set(field, url);
            changes.push({ field, value: { url, path } });
          }),
        );
      } else if (field === 'categories') {
        changes.push({
          field,
          value: categoryMatch.matched.map((category) => category.id),
        });
      } else if (field === 'cast') {
        slow.push(
          this.cast.attach(proposal.cast, request.user).then((outcome) => {
            report.actors = {
              reused: outcome.reused,
              created: outcome.created,
              skipped: outcome.skipped,
            };
            // Everyone was skipped (namesakes, no permission): TMDB has a
            // cast, but none of it can go on the title.
            if (outcome.actorIds.length === 0) withoutValue(field, standing);
            else changes.push({ field, value: outcome.actorIds });
          }),
        );
      } else {
        const change = scalarChange(field, proposal);
        if (change) changes.push(change);
      }
    }

    const storedUrls = () => [...storedPictures.values()];
    let written: { before: Row; after: Row; dropped: TmdbField[] } | null;
    try {
      // The pictures and the cast are fetched side by side (the downloads
      // themselves are capped inside TmdbImageFetcher). Every one is waited
      // for even when another failed, so no picture is stored after the
      // clean-up below has already run.
      const settled = await Promise.allSettled(slow);
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      written = await this.prisma.$transaction(async (tx) => {
        await ops.lock(tx, id);
        const before = await ops.load(tx, id);
        if (!before) return null;
        const freshView = ops.view(before);
        const freshAuto = readTmdbAuto(before.tmdbAuto);

        // An unreviewed fill gives way to whatever staff typed while the
        // details were being fetched. A staff apply was asked for by name —
        // all but the fields it takes back unasked, which give way as well.
        const dropped: TmdbField[] = [];
        const final = changes.filter((change) => {
          if (request.mode !== 'automatic' && !takenBack.has(change.field)) {
            return true;
          }
          const untouched = isUntouched(
            fieldStanding(change.field, freshView, freshAuto, this.keyOf),
          );
          if (!untouched) dropped.push(change.field);
          return untouched;
        });

        const applied = applyChanges(freshView, freshAuto, final);
        const writesCategories = final.some((c) => c.field === 'categories');
        const writesCast = final.some((c) => c.field === 'cast');
        // `set` refuses an id that no longer exists (a category or an actor
        // deleted a moment ago), so only rows that are still there are set.
        const categoryIds = writesCategories
          ? await this.existingIds(tx, 'category', applied.view.categoryIds)
          : undefined;
        const actorIds = writesCast
          ? await this.existingIds(tx, 'actor', applied.view.actorIds)
          : undefined;

        const after = await ops.write(tx, id, {
          columns: columnsOf(final, applied.view),
          categoryIds,
          actorIds,
          tmdbId: proposal.tmdbId,
          tmdbFetchedAt: new Date(),
          tmdbAuto: { ...applied.auto, match: proposal.match },
        });
        return { before, after, dropped };
      });
    } catch (error) {
      await this.deleteObjects(this.keysOf(storedUrls()), 'unused');
      throw error;
    }

    if (!written) {
      await this.deleteObjects(this.keysOf(storedUrls()), 'unused');
      return null;
    }
    const { before, after, dropped } = written;
    // A dropped field is reported once, as staff's own.
    report.skipped = report.skipped.filter(
      (entry) => !dropped.includes(entry.field),
    );
    for (const field of dropped) skip(field, 'hand');

    // Pictures the row no longer shows (replaced by this fill) and pictures
    // this run stored for a field it did not write after all.
    const orphaned = new Set(
      replacedTmdbImageKeys(before, after, FILL_IMAGE_FIELDS, this.keyOf),
    );
    for (const field of dropped) {
      const url = storedPictures.get(field);
      const key = url ? this.keyOf(url) : null;
      if (key) orphaned.add(key);
    }
    await this.deleteObjects([...orphaned], 'replaced');

    const writtenFields = new Set<TmdbField>(kept);
    for (const change of changes) {
      if (change.value !== null && !dropped.includes(change.field)) {
        writtenFields.add(change.field);
      }
    }
    const order = tmdbFieldsFor(ops.kind);
    report.filled = order.filter((field) => writtenFields.has(field));
    report.skipped.sort(
      (a, b) => order.indexOf(a.field) - order.indexOf(b.field),
    );
    if (writtenFields.has('categories')) {
      const had = new Set(before.categories.map((category) => category.id));
      report.categories.added = categoryMatch.matched
        .filter((category) => !had.has(category.id))
        .filter((category) =>
          after.categories.some((c) => c.id === category.id),
        )
        .map((category) => category.name);
    }

    if (request.audit) {
      await this.audit.record({
        action: ops.auditAction,
        actor: request.user,
        target: { type: ops.kind, id, label: after.title },
        before: ops.snapshot(before),
        after: ops.snapshot(after),
        metadata: {
          via: 'tmdb',
          trigger: request.trigger,
          tmdbId: proposal.tmdbId,
          fields: report.filled,
        },
      });
    }
    return { row: after, report };
  }

  /** The ids of the list that still exist, in the list's order. */
  private async existingIds(
    tx: Prisma.TransactionClient,
    table: 'category' | 'actor',
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const where = { id: { in: [...ids] } };
    const rows =
      table === 'category'
        ? await tx.category.findMany({ where, select: { id: true } })
        : await tx.actor.findMany({ where, select: { id: true } });
    const existing = new Set(rows.map((row) => row.id));
    return ids.filter((existingId) => existing.has(existingId));
  }

  /**
   * The review: one line per detail — what the title holds, what TMDB has,
   * and how the two stand — plus what would happen to each person of the
   * cast and which categories would be connected. Reads only.
   */
  private async buildPreview<Row extends StoredTitle>(
    ops: TitleOps<Row>,
    stored: Row,
    proposal: TmdbProposal,
    user: AuthenticatedUser,
  ): Promise<TmdbPreview> {
    const view = ops.view(stored);
    const auto = readTmdbAuto(stored.tmdbAuto);
    const [categories, castPlan] = await Promise.all([
      this.loadCategories(),
      this.cast.plan(proposal.cast, user),
    ]);
    const categoryMatch = matchCategories(proposal.categoryWords, categories);
    const matchedIds = categoryMatch.matched.map((category) => category.id);
    const attachable = castPlan.filter(
      (entry) => entry.action === 'reuse' || entry.action === 'create',
    );
    const reuseIds = attachable
      .map((entry) => entry.actor?.id)
      .filter((actorId): actorId is string => !!actorId);

    const line = (
      field: TmdbField,
      current: TmdbPreviewValue,
      proposed: TmdbPreviewValue,
      hasValue: boolean,
      same: boolean,
    ): TmdbPreviewLine => {
      const state = previewLineState(
        fieldStanding(field, view, auto, this.keyOf),
        hasValue,
        same,
      );
      return {
        field,
        current,
        proposed,
        state,
        defaultOn: state === 'empty' || state === 'auto',
      };
    };
    const scalar = (
      field: Exclude<TmdbField, 'poster' | 'cover' | 'categories' | 'cast'>,
      current: string | number | null,
    ): TmdbPreviewLine => {
      const proposed = proposal[field];
      const shown =
        typeof current === 'string' ? current.trim() || null : current || null;
      return line(
        field,
        shown,
        proposed,
        proposed !== null,
        shown === proposed,
      );
    };
    const picture = (
      field: 'poster' | 'cover',
      currentUrl: string | null,
      path: string | null,
      rememberedPath: string | undefined,
      size: string,
    ): TmdbPreviewLine =>
      line(
        field,
        // Re-hosted for this request, like every stored picture URL that
        // leaves the API.
        this.minioService.imageUrl(currentUrl) || null,
        tmdbImageUrl(size, path),
        path !== null,
        path !== null &&
          rememberedPath === path &&
          fieldStanding(field, view, auto, this.keyOf) === 'auto',
      );

    const lines: Record<TmdbField, () => TmdbPreviewLine> = {
      title: () => scalar('title', view.title),
      description: () => scalar('description', view.description),
      releaseYear: () => scalar('releaseYear', view.releaseYear),
      duration: () => scalar('duration', view.duration),
      genre: () => scalar('genre', view.genre),
      language: () => scalar('language', view.language),
      country: () => scalar('country', view.country),
      director: () => scalar('director', view.director),
      ageRating: () => scalar('ageRating', view.ageRating),
      poster: () =>
        picture(
          'poster',
          view.posterUrl,
          proposal.posterPath,
          auto?.posterPath,
          TMDB_PREVIEW_SIZES.poster,
        ),
      cover: () =>
        picture(
          'cover',
          view.coverUrl,
          proposal.coverPath,
          auto?.coverPath,
          TMDB_PREVIEW_SIZES.backdrop,
        ),
      categories: () =>
        line(
          'categories',
          stored.categories.map((category) => category.name),
          categoryMatch.matched.map((category) => category.name),
          matchedIds.length > 0,
          sameIdSet(
            mergeAutoList(view.categoryIds, auto?.categoryIds, matchedIds),
            view.categoryIds,
          ),
        ),
      cast: () =>
        line(
          'cast',
          stored.actors.map((actor) => actor.name),
          attachable.map((entry) => entry.person.name),
          attachable.length > 0,
          // Someone still to create is never "already the same".
          reuseIds.length === attachable.length &&
            sameIdSet(
              mergeAutoList(view.actorIds, auto?.actorIds, reuseIds),
              view.actorIds,
            ),
        ),
    };

    const onTitle = new Set(view.categoryIds);
    return {
      tmdbId: proposal.tmdbId,
      match: proposal.match,
      fields: tmdbFieldsFor(ops.kind).map((field) => lines[field]()),
      cast: castPlan.map((entry: TmdbCastPlanEntry) => ({
        name: entry.person.name,
        tmdbPersonId: entry.person.tmdbPersonId,
        action: entry.action,
        actorId: entry.actor?.id || null,
        hasPhoto: entry.person.profilePath !== null,
      })),
      categories: {
        add: categoryMatch.matched
          .filter((category) => !onTitle.has(category.id))
          .map(({ id, name }) => ({ id, name })),
        unmatched: categoryMatch.unmatched,
      },
    };
  }
}
