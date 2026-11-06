import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AdvertisementFormat,
  AdvertisementPlacement,
  AdvertisementPlaybackStatus,
  AdvertisementTargetType,
  type Advertisement,
  type Prisma,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { advertisementSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import {
  loadTitleCards,
  loadVisibleTitleKeys,
  titleKey,
  type TitleRef,
} from '../home/home-titles';
import { PrismaService } from '../prisma/prisma.service';
import { ADS_ERRORS, adBadRequest, adError } from './ads-errors';
import {
  AD_LIMITS,
  DEFAULT_CORNER_SHOW_SECONDS,
  type AdLiveState,
  type AdminAdQueryDto,
  type CreateAdvertisementDto,
  type UpdateAdvertisementDto,
} from './dto/advertisement.dto';

/** Default offset of a new ad's daily window: Myanmar, UTC+6:30. */
export const DEFAULT_TZ_OFFSET_MINUTES = 390;

const CREATED_BY_SELECT = {
  select: { id: true, username: true, displayName: true },
} as const;

const MOVIES_SELECT = { select: { movieId: true } } as const;

type AdRow = Advertisement & {
  createdBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
  movies: { movieId: string }[];
};

/**
 * An http(s) web address: a host (a name or an IP address, with or without
 * a port) and anything after it, no spaces. A "user@" part is refused — it
 * makes a link look like one site while opening another. The admin form
 * uses the same rule.
 */
export const AD_LINK_PATTERN = /^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i;

/**
 * Whether an ad can be picked right now, and if not, why. NO_VIDEO ("no
 * video / picture") wins over everything: an ad without its file has
 * nothing to show whatever its switch says (the service refuses to switch
 * it on anyway).
 */
export function adLiveStateOf(
  ad: Pick<
    Advertisement,
    'isActive' | 'startsAt' | 'endsAt' | 'videoKey' | 'format' | 'imageKey'
  >,
  now = new Date(),
): AdLiveState {
  const media =
    ad.format === AdvertisementFormat.CORNER ? ad.imageKey : ad.videoKey;
  if (!media) return 'NO_VIDEO';
  if (!ad.isActive) return 'OFF';
  if (ad.endsAt && ad.endsAt.getTime() <= now.getTime()) return 'ENDED';
  if (ad.startsAt && ad.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'LIVE';
}

/** A selected title as the admin list shows it — hidden titles included. */
export interface StaffAdTargetMovie {
  id: string;
  /** Null when the title no longer exists. */
  title: string | null;
  imageUrl: string | null;
  /** False when deleted, unpublished, or turned into an episode. */
  isVisible: boolean;
  missing: boolean;
}

export interface StaffAdCounters {
  impressions: number;
  completions: number;
  /** Video ads only (a corner picture's ✕ is a close). */
  skips: number;
  /** Corner pictures: showings (first ones + comebacks), taps, closes. */
  shows: number;
  clicks: number;
  closes: number;
}

const EMPTY_COUNTERS: StaffAdCounters = {
  impressions: 0,
  completions: 0,
  skips: 0,
  shows: 0,
  clicks: 0,
  closes: 0,
};

export interface StaffAdView {
  id: string;
  title: string;
  description: string | null;
  isActive: boolean;
  liveState: AdLiveState;
  /** A fresh signed playback URL, or null before a video is attached. */
  videoUrl: string | null;
  durationSeconds: number | null;
  videoBytes: number | null;
  targetType: AdvertisementTargetType;
  targetMovies: StaffAdTargetMovie[];
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  /** "HH:mm" in the ad's offset, or null. */
  dailyStartTime: string | null;
  dailyEndTime: string | null;
  tzOffsetMinutes: number;
  isSkippable: boolean;
  skipAfterSeconds: number | null;
  frequencyLimitMinutes: number | null;
  maxImpressionsPerUserPerDay: number | null;
  format: AdvertisementFormat;
  playsBeforeMovie: boolean;
  playsAtBreaks: boolean;
  /** The corner picture's public URL (built for this request), or null. */
  imageUrl: string | null;
  imageBytes: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  linkUrl: string | null;
  cornerShowSeconds: number | null;
  cornerRepeatMinutes: number | null;
  cornerClosable: boolean;
  /** All-time, on impressions (started plays). */
  counters: StaffAdCounters;
  createdBy: {
    id: string;
    username: string;
    displayName: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StaffAdPage {
  items: StaffAdView[];
  total: number;
  page: number;
  limit: number;
}

/** The merged, checked fields one create or update writes. */
interface ResolvedFields {
  title: string;
  description: string | null;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  dailyStartMinutes: number | null;
  dailyEndMinutes: number | null;
  tzOffsetMinutes: number;
  targetType: AdvertisementTargetType;
  priority: number;
  isSkippable: boolean;
  skipAfterSeconds: number | null;
  frequencyLimitMinutes: number | null;
  maxImpressionsPerUserPerDay: number | null;
  playsBeforeMovie: boolean;
  playsAtBreaks: boolean;
  linkUrl: string | null;
  cornerShowSeconds: number | null;
  cornerRepeatMinutes: number | null;
  cornerClosable: boolean;
}

/** The type-specific fields one create or update asks for (before the rules). */
interface FormatInput {
  format: AdvertisementFormat;
  playsBeforeMovie: boolean;
  playsAtBreaks: boolean;
  linkUrl: string | null;
  cornerShowSeconds: number | null;
  cornerRepeatMinutes: number | null;
  cornerClosable: boolean;
}

/** Video-only fields a request sent for a corner picture, and the reverse. */
function mismatchedFields(
  format: AdvertisementFormat,
  dto: CreateAdvertisementDto | UpdateAdvertisementDto,
): string[] {
  const sent = (value: unknown) => value !== undefined && value !== null;
  if (format === AdvertisementFormat.CORNER) {
    return [
      dto.playsBeforeMovie === true ? 'playsBeforeMovie' : null,
      dto.playsAtBreaks === true ? 'playsAtBreaks' : null,
      dto.isSkippable === true ? 'isSkippable' : null,
      sent(dto.skipAfterSeconds) ? 'skipAfterSeconds' : null,
    ].filter((field): field is string => field !== null);
  }
  return [
    sent(dto.linkUrl) ? 'linkUrl' : null,
    sent(dto.cornerShowSeconds) ? 'cornerShowSeconds' : null,
    sent(dto.cornerRepeatMinutes) ? 'cornerRepeatMinutes' : null,
    dto.cornerClosable !== undefined ? 'cornerClosable' : null,
  ].filter((field): field is string => field !== null);
}

const toDate = (value: string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value);

/** "HH:mm" → minutes after midnight; the DTO has already checked the shape. */
export function timeOfDayToMinutes(text: string): number {
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes after midnight → "HH:mm". */
export function minutesToTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The admin "Advertisements" page: list / one / create / edit / delete,
 * every change audited. The video itself lands through AdVideoService
 * (upload + attach); the viewer-facing decisions live in AdDecisionService.
 * Every rule below is also a CHECK on the table, so a row the decision
 * cannot reason about can never exist.
 */
@Injectable()
export class AdsAdminService {
  private readonly logger = new Logger(AdsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly minio: MinioService,
    private readonly storage: StorageService,
  ) {}

  async list(query: AdminAdQueryDto): Promise<StaffAdPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.AdvertisementWhereInput = {
      ...(query.search
        ? { title: { contains: query.search, mode: 'insensitive' } }
        : {}),
      ...(query.format ? { format: query.format } : {}),
      AND: [liveStateWhere(query.status, new Date())],
    };
    const [rows, total] = await Promise.all([
      this.prisma.advertisement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { createdBy: CREATED_BY_SELECT, movies: MOVIES_SELECT },
      }),
      this.prisma.advertisement.count({ where }),
    ]);
    return { items: await this.views(rows), total, page, limit };
  }

  async findOne(id: string): Promise<StaffAdView> {
    return (await this.views([await this.findRow(id)]))[0];
  }

  async create(
    dto: CreateAdvertisementDto,
    actor: AuthenticatedUser,
  ): Promise<StaffAdView> {
    const format = dto.format ?? AdvertisementFormat.VIDEO;
    const corner = format === AdvertisementFormat.CORNER;
    const { fields, movieIds } = await this.resolveFields(
      {
        title: dto.title,
        description: dto.description ?? null,
        // A new ad starts OFF: it has no video yet, and an ad without one
        // cannot be switched on (resolveFields below).
        isActive: dto.isActive ?? false,
        startsAt: toDate(dto.startsAt),
        endsAt: toDate(dto.endsAt),
        dailyStartTime: dto.dailyStartTime ?? null,
        dailyEndTime: dto.dailyEndTime ?? null,
        tzOffsetMinutes: dto.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES,
        targetType: dto.targetType ?? AdvertisementTargetType.ALL,
        movieIds: dto.movieIds ?? [],
        priority: dto.priority ?? 0,
        isSkippable: dto.isSkippable ?? false,
        skipAfterSeconds: dto.skipAfterSeconds ?? null,
        frequencyLimitMinutes: dto.frequencyLimitMinutes ?? null,
        maxImpressionsPerUserPerDay: dto.maxImpressionsPerUserPerDay ?? null,
      },
      {
        format,
        // A new video ad plays before the movie unless the form says
        // otherwise; a corner picture never has a slot.
        playsBeforeMovie: corner ? false : (dto.playsBeforeMovie ?? true),
        playsAtBreaks: corner ? false : (dto.playsAtBreaks ?? false),
        linkUrl: dto.linkUrl ?? null,
        cornerShowSeconds: corner
          ? dto.cornerShowSeconds === undefined
            ? DEFAULT_CORNER_SHOW_SECONDS
            : dto.cornerShowSeconds
          : null,
        cornerRepeatMinutes: dto.cornerRepeatMinutes ?? null,
        cornerClosable: dto.cornerClosable ?? true,
      },
      mismatchedFields(format, dto),
      { videoKey: null, durationSeconds: null, imageKey: null },
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.advertisement.create({
        data: {
          ...fields,
          format,
          createdById: actor.id,
          movies: { create: movieIds.map((movieId) => ({ movieId })) },
        },
        include: { createdBy: CREATED_BY_SELECT, movies: MOVIES_SELECT },
      });
      await this.audit.record({
        action: 'advertisement.create',
        actor,
        target: { type: 'advertisement', id: row.id, label: row.title },
        after: advertisementSnapshot({ ...row, movieIds }),
        tx,
      });
      return row;
    });
    return (await this.views([created]))[0];
  }

  async update(
    id: string,
    dto: UpdateAdvertisementDto,
    actor: AuthenticatedUser,
  ): Promise<StaffAdView> {
    const before = await this.findRow(id);
    const beforeMovieIds = before.movies.map((row) => row.movieId);

    // Absent = keep the stored value; null = clear it (the DTO already
    // refused null for the fields that cannot be empty).
    const pick = <T>(value: T | undefined, stored: T): T =>
      value === undefined ? stored : value;

    const { fields, movieIds } = await this.resolveFields(
      {
        title: pick(dto.title, before.title),
        description: pick(dto.description, before.description),
        isActive: pick(dto.isActive, before.isActive),
        startsAt:
          dto.startsAt === undefined ? before.startsAt : toDate(dto.startsAt),
        endsAt: dto.endsAt === undefined ? before.endsAt : toDate(dto.endsAt),
        dailyStartTime:
          dto.dailyStartTime === undefined
            ? before.dailyStartMinutes === null
              ? null
              : minutesToTimeOfDay(before.dailyStartMinutes)
            : dto.dailyStartTime,
        dailyEndTime:
          dto.dailyEndTime === undefined
            ? before.dailyEndMinutes === null
              ? null
              : minutesToTimeOfDay(before.dailyEndMinutes)
            : dto.dailyEndTime,
        tzOffsetMinutes:
          dto.tzOffsetMinutes === undefined || dto.tzOffsetMinutes === null
            ? before.tzOffsetMinutes
            : dto.tzOffsetMinutes,
        targetType: pick(dto.targetType, before.targetType),
        movieIds: pick(dto.movieIds, beforeMovieIds),
        priority:
          dto.priority === undefined || dto.priority === null
            ? before.priority
            : dto.priority,
        isSkippable: pick(dto.isSkippable, before.isSkippable),
        skipAfterSeconds: pick(dto.skipAfterSeconds, before.skipAfterSeconds),
        frequencyLimitMinutes: pick(
          dto.frequencyLimitMinutes,
          before.frequencyLimitMinutes,
        ),
        maxImpressionsPerUserPerDay: pick(
          dto.maxImpressionsPerUserPerDay,
          before.maxImpressionsPerUserPerDay,
        ),
      },
      {
        format: before.format,
        playsBeforeMovie: pick(dto.playsBeforeMovie, before.playsBeforeMovie),
        playsAtBreaks: pick(dto.playsAtBreaks, before.playsAtBreaks),
        linkUrl: pick(dto.linkUrl, before.linkUrl),
        cornerShowSeconds: pick(
          dto.cornerShowSeconds,
          before.cornerShowSeconds,
        ),
        cornerRepeatMinutes: pick(
          dto.cornerRepeatMinutes,
          before.cornerRepeatMinutes,
        ),
        cornerClosable: pick(dto.cornerClosable, before.cornerClosable),
      },
      mismatchedFields(before.format, dto),
      before,
    );

    const after = await this.prisma.$transaction(async (tx) => {
      const row = await tx.advertisement.update({
        where: { id },
        data: {
          ...fields,
          // The SELECTED list is replaced whole, like a draw's off-sale
          // numbers: nothing is ever edited in place.
          movies: {
            deleteMany: {},
            create: movieIds.map((movieId) => ({ movieId })),
          },
        },
        include: { createdBy: CREATED_BY_SELECT, movies: MOVIES_SELECT },
      });
      const added = movieIds.filter((m) => !beforeMovieIds.includes(m)).length;
      const removed = beforeMovieIds.filter(
        (m) => !movieIds.includes(m),
      ).length;
      await this.audit.record({
        action: 'advertisement.update',
        actor,
        target: { type: 'advertisement', id, label: row.title },
        before: advertisementSnapshot({ ...before, movieIds: beforeMovieIds }),
        after: advertisementSnapshot({ ...row, movieIds }),
        metadata: { movieIdsAdded: added, movieIdsRemoved: removed },
        tx,
      });
      return row;
    });
    return (await this.views([after]))[0];
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const before = await this.findRow(id);
    await this.prisma.advertisement.delete({ where: { id } });
    await this.audit.record({
      action: 'advertisement.delete',
      actor,
      target: { type: 'advertisement', id, label: before.title },
      before: advertisementSnapshot({
        ...before,
        movieIds: before.movies.map((row) => row.movieId),
      }),
    });
    // Every package the ad ever had, a half-uploaded staging file and every
    // corner picture; prefix deletes, like a movie's. The row is gone first so a decision
    // racing this delete can no longer pick the ad; a storage hiccup after
    // that leaves orphan objects, never a half-deleted ad.
    for (const prefix of [
      `${this.storage.adPrefix(id)}/`,
      `${this.storage.adStagingPrefix(id)}/`,
      `${this.storage.adImagePrefix(id)}/`,
    ]) {
      await this.minio.deleteByPrefix(prefix).catch((error: unknown) => {
        this.logger.warn(
          `Ad ${id}: could not delete ${prefix} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  async findRow(id: string): Promise<AdRow> {
    const row = await this.prisma.advertisement.findUnique({
      where: { id },
      include: { createdBy: CREATED_BY_SELECT, movies: MOVIES_SELECT },
    });
    if (!row) {
      throw adError(
        HttpStatus.NOT_FOUND,
        ADS_ERRORS.NOT_FOUND,
        'Advertisement not found',
      );
    }
    return row;
  }

  /**
   * The cross-field rules, on the MERGED row (create and update both land
   * here, so a patch cannot sidestep a rule by leaving a field out).
   */
  private async resolveFields(
    input: {
      title: string;
      description: string | null;
      isActive: boolean;
      startsAt: Date | null;
      endsAt: Date | null;
      dailyStartTime: string | null;
      dailyEndTime: string | null;
      tzOffsetMinutes: number;
      targetType: AdvertisementTargetType;
      movieIds: string[];
      priority: number;
      isSkippable: boolean;
      skipAfterSeconds: number | null;
      frequencyLimitMinutes: number | null;
      maxImpressionsPerUserPerDay: number | null;
    },
    kind: FormatInput,
    mismatched: string[],
    stored: Pick<Advertisement, 'videoKey' | 'durationSeconds' | 'imageKey'>,
  ): Promise<{ fields: ResolvedFields; movieIds: string[] }> {
    const corner = kind.format === AdvertisementFormat.CORNER;
    if (mismatched.length > 0) {
      throw adBadRequest(
        ADS_ERRORS.FORMAT_MISMATCH,
        corner
          ? 'A corner picture has no video settings.'
          : 'A video ad has no corner-picture settings.',
        { fields: mismatched },
      );
    }
    const title = input.title.trim();
    if (!title) {
      throw adBadRequest(ADS_ERRORS.TITLE_REQUIRED, 'Enter the title.');
    }
    if (
      input.startsAt &&
      input.endsAt &&
      input.startsAt.getTime() >= input.endsAt.getTime()
    ) {
      throw adBadRequest(
        ADS_ERRORS.WINDOW_INVALID,
        'The end must be after the start.',
      );
    }
    if ((input.dailyStartTime === null) !== (input.dailyEndTime === null)) {
      throw adBadRequest(
        ADS_ERRORS.DAILY_WINDOW_INVALID,
        'Fill in both daily hours, or leave both empty.',
      );
    }
    const dailyStartMinutes =
      input.dailyStartTime === null
        ? null
        : timeOfDayToMinutes(input.dailyStartTime);
    const dailyEndMinutes =
      input.dailyEndTime === null
        ? null
        : timeOfDayToMinutes(input.dailyEndTime);
    if (dailyStartMinutes !== null && dailyStartMinutes === dailyEndMinutes) {
      throw adBadRequest(
        ADS_ERRORS.DAILY_WINDOW_INVALID,
        'The daily hours cannot start and end at the same time.',
      );
    }

    let movieIds: string[] = [];
    if (input.targetType === AdvertisementTargetType.SELECTED) {
      movieIds = [...new Set(input.movieIds)];
      if (movieIds.length === 0) {
        throw adBadRequest(
          ADS_ERRORS.TARGET_MOVIES_REQUIRED,
          'Choose at least one movie, or play before all movies.',
        );
      }
      if (movieIds.length > AD_LIMITS.movies) {
        throw adBadRequest(
          ADS_ERRORS.TARGET_MOVIES_REQUIRED,
          `At most ${AD_LIMITS.movies} movies.`,
        );
      }
      const existing = new Set(
        (
          await this.prisma.movie.findMany({
            where: { id: { in: movieIds } },
            select: { id: true },
          })
        ).map((row) => row.id),
      );
      const missing = movieIds.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        throw adBadRequest(
          ADS_ERRORS.TARGET_MOVIE_NOT_FOUND,
          'A chosen movie does not exist any more.',
          { movieIds: missing },
        );
      }
    }

    let skipAfterSeconds: number | null = null;
    if (input.isSkippable && !corner) {
      if (input.skipAfterSeconds === null) {
        throw adBadRequest(
          ADS_ERRORS.SKIP_AFTER_REQUIRED,
          'Enter when skipping is allowed.',
        );
      }
      if (
        stored.durationSeconds !== null &&
        input.skipAfterSeconds >= stored.durationSeconds
      ) {
        throw adBadRequest(
          ADS_ERRORS.SKIP_AFTER_TOO_LONG,
          'Skip-after must be shorter than the video.',
          { durationSeconds: stored.durationSeconds },
        );
      }
      skipAfterSeconds = input.skipAfterSeconds;
    }

    if (!corner && !kind.playsBeforeMovie && !kind.playsAtBreaks) {
      throw adBadRequest(
        ADS_ERRORS.SLOTS_REQUIRED,
        'Choose where the video plays: before the movie, at breaks, or both.',
      );
    }

    let linkUrl: string | null = null;
    let cornerShowSeconds: number | null = null;
    let cornerRepeatMinutes: number | null = null;
    let cornerClosable = true;
    if (corner) {
      if (kind.linkUrl !== null) {
        if (!AD_LINK_PATTERN.test(kind.linkUrl)) {
          throw adBadRequest(
            ADS_ERRORS.LINK_INVALID,
            'Enter a full web address starting with http:// or https://.',
          );
        }
        linkUrl = kind.linkUrl;
      }
      cornerShowSeconds = kind.cornerShowSeconds;
      cornerRepeatMinutes = kind.cornerRepeatMinutes;
      if (cornerShowSeconds === null) {
        // "Until closed": it needs the ✕, and it cannot come back.
        if (cornerRepeatMinutes !== null) {
          throw adBadRequest(
            ADS_ERRORS.CORNER_TIMING_INVALID,
            'A picture that stays until it is closed cannot come back.',
          );
        }
      } else {
        cornerClosable = kind.cornerClosable;
        if (
          cornerRepeatMinutes !== null &&
          cornerRepeatMinutes * 60 <= cornerShowSeconds
        ) {
          throw adBadRequest(
            ADS_ERRORS.CORNER_TIMING_INVALID,
            'It must be gone longer than it shows: make "comes back every" longer than "show for".',
          );
        }
      }
    }

    if (input.isActive && corner && !stored.imageKey) {
      throw adBadRequest(
        ADS_ERRORS.IMAGE_REQUIRED,
        'A corner ad without a picture cannot be switched on. Upload one first.',
      );
    }
    if (input.isActive && !corner && !stored.videoKey) {
      throw adBadRequest(
        ADS_ERRORS.VIDEO_REQUIRED,
        'An ad without a video cannot be switched on. Upload one first.',
      );
    }

    return {
      fields: {
        title,
        description: input.description,
        isActive: input.isActive,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        dailyStartMinutes,
        dailyEndMinutes,
        tzOffsetMinutes: input.tzOffsetMinutes,
        targetType: input.targetType,
        priority: input.priority,
        isSkippable: corner ? false : input.isSkippable,
        skipAfterSeconds,
        frequencyLimitMinutes: input.frequencyLimitMinutes,
        maxImpressionsPerUserPerDay: input.maxImpressionsPerUserPerDay,
        playsBeforeMovie: corner ? false : kind.playsBeforeMovie,
        playsAtBreaks: corner ? false : kind.playsAtBreaks,
        linkUrl,
        cornerShowSeconds,
        cornerRepeatMinutes,
        cornerClosable,
      },
      movieIds,
    };
  }

  /** The wire shape: a fresh signed URL, the selected titles as cards, all-time counters. */
  async views(rows: AdRow[]): Promise<StaffAdView[]> {
    if (rows.length === 0) return [];
    const now = new Date();
    const refs: TitleRef[] = rows.flatMap((row) =>
      row.movies.map((m) => ({ type: 'MOVIE' as const, id: m.movieId })),
    );
    const [cards, visible, counters] = await Promise.all([
      loadTitleCards(this.prisma, refs, false),
      loadVisibleTitleKeys(this.prisma, refs),
      this.counters(rows.map((row) => row.id)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      isActive: row.isActive,
      liveState: adLiveStateOf(row, now),
      videoUrl: row.videoKey
        ? this.minio.signedPlaybackUrl(row.videoKey)
        : null,
      durationSeconds: row.durationSeconds,
      videoBytes: row.videoBytes,
      targetType: row.targetType,
      targetMovies: row.movies.map(({ movieId }) => {
        const key = titleKey('MOVIE', movieId);
        const card = cards.get(key);
        return {
          id: movieId,
          title: card?.title ?? null,
          imageUrl: this.minio.imageUrl(
            card?.posterUrl ?? card?.thumbnailUrl ?? null,
          ),
          isVisible: visible.has(key),
          missing: !card,
        };
      }),
      priority: row.priority,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      dailyStartTime:
        row.dailyStartMinutes === null
          ? null
          : minutesToTimeOfDay(row.dailyStartMinutes),
      dailyEndTime:
        row.dailyEndMinutes === null
          ? null
          : minutesToTimeOfDay(row.dailyEndMinutes),
      tzOffsetMinutes: row.tzOffsetMinutes,
      isSkippable: row.isSkippable,
      skipAfterSeconds: row.skipAfterSeconds,
      frequencyLimitMinutes: row.frequencyLimitMinutes,
      maxImpressionsPerUserPerDay: row.maxImpressionsPerUserPerDay,
      format: row.format,
      playsBeforeMovie: row.playsBeforeMovie,
      playsAtBreaks: row.playsAtBreaks,
      imageUrl: row.imageKey ? this.minio.playbackUrl(row.imageKey) : null,
      imageBytes: row.imageBytes,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      linkUrl: row.linkUrl,
      cornerShowSeconds: row.cornerShowSeconds,
      cornerRepeatMinutes: row.cornerRepeatMinutes,
      cornerClosable: row.cornerClosable,
      counters: counters.get(row.id) ?? { ...EMPTY_COUNTERS },
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /** All-time counters of a page of ads (impressions, and the corner's showings / taps / closes), one groupBy. */
  private async counters(ids: string[]): Promise<Map<string, StaffAdCounters>> {
    const groups = await this.prisma.advertisementPlayback.groupBy({
      by: ['advertisementId', 'status', 'placement'],
      where: { advertisementId: { in: ids }, startedAt: { not: null } },
      _count: { _all: true },
      _sum: { repeatCount: true, clickCount: true },
    });
    const out = new Map<string, StaffAdCounters>();
    for (const group of groups) {
      const counters = out.get(group.advertisementId) ?? { ...EMPTY_COUNTERS };
      const plays = group._count._all;
      const corner = group.placement === AdvertisementPlacement.CORNER;
      counters.impressions += plays;
      if (group.status === AdvertisementPlaybackStatus.COMPLETED)
        counters.completions += plays;
      if (group.status === AdvertisementPlaybackStatus.SKIPPED) {
        if (corner) counters.closes += plays;
        else counters.skips += plays;
      }
      if (corner) {
        counters.shows += plays + (group._sum.repeatCount ?? 0);
        counters.clicks += group._sum.clickCount ?? 0;
      }
      out.set(group.advertisementId, counters);
    }
    return out;
  }
}

/** The list filter as a where clause — the same reading as adLiveStateOf. */
function liveStateWhere(
  status: AdLiveState | undefined,
  now: Date,
): Prisma.AdvertisementWhereInput {
  const hasMedia: Prisma.AdvertisementWhereInput = {
    OR: [
      { format: AdvertisementFormat.VIDEO, videoKey: { not: null } },
      { format: AdvertisementFormat.CORNER, imageKey: { not: null } },
    ],
  };
  switch (status) {
    case undefined:
      return {};
    case 'NO_VIDEO':
      return {
        OR: [
          { format: AdvertisementFormat.VIDEO, videoKey: null },
          { format: AdvertisementFormat.CORNER, imageKey: null },
        ],
      };
    case 'OFF':
      return { AND: [hasMedia, { isActive: false }] };
    case 'ENDED':
      return { AND: [hasMedia, { isActive: true, endsAt: { lte: now } }] };
    case 'SCHEDULED':
      return {
        AND: [
          hasMedia,
          { isActive: true, startsAt: { gt: now } },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      };
    case 'LIVE':
      return {
        AND: [
          hasMedia,
          { isActive: true },
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      };
  }
}
