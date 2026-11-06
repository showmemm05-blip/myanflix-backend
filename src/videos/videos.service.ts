import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AccessType,
  MovieStatus,
  Role,
  SeriesStatus,
  VideoStatus,
  type Prisma,
  type Video,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { TrackingService } from '../tracking/tracking.service';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';

export interface CreateVideoInput {
  movieId: string;
  originalFilename: string;
  originalPath: string;
}

export interface RenditionInfo {
  resolution: string;
  playlistPath: string;
}

export interface SubtitleInfo {
  id: string;
  language: string;
  label: string;
  format: string;
  isDefault: boolean;
  url: string;
}

/**
 * One rung of the ladder as something a player can be pointed at: the
 * rendition's OWN media playlist rather than the master. That is what
 * "choose 720p" has to mean on a client whose player cannot be told to hold a
 * video track — hand it a playlist that only has one. `label` is the stored
 * resolution verbatim ("720p"), never re-derived and never translated.
 */
export interface StreamQualityInfo {
  label: string;
  url: string;
}

/**
 * The one publish rule a regular viewer is held to, shared by streaming,
 * watch-progress and the ad decisions (AdDecisionService) so none of
 * them can disagree: the title must be PUBLISHED and, for an episode, so
 * must its show — the same rule as MoviesService.findByIdOrThrow.
 */
export function isHiddenFromViewers(movie: {
  status: MovieStatus;
  seriesId: string | null;
  series: { status: SeriesStatus } | null;
}): boolean {
  return (
    movie.status !== MovieStatus.PUBLISHED ||
    (movie.seriesId !== null && movie.series?.status !== SeriesStatus.PUBLISHED)
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly trackingService: TrackingService,
  ) {}

  create(input: CreateVideoInput): Promise<Video> {
    return this.prisma.video.create({
      data: {
        movieId: input.movieId,
        originalFilename: input.originalFilename,
        originalPath: input.originalPath,
        status: VideoStatus.UPLOADING,
      },
    });
  }

  /** Most recently created video for a movie — the one currently being processed or served. */
  findLatestForMovie(movieId: string): Promise<Video | null> {
    return this.prisma.video.findFirst({
      where: { movieId },
      orderBy: { createdAt: 'desc' },
    });
  }

  markProcessing(id: string): Promise<Video> {
    return this.prisma.video.update({
      where: { id },
      data: { status: VideoStatus.PROCESSING },
    });
  }

  /** Called once the original upload has been archived to the storage server — replaces the (now-deleted) local disk path. */
  updateOriginalPath(id: string, originalPath: string): Promise<Video> {
    return this.prisma.video.update({ where: { id }, data: { originalPath } });
  }

  markReady(
    id: string,
    data: {
      duration: number | null;
      resolution: string | null;
      hlsMasterPath: string;
      renditions: RenditionInfo[];
    },
  ): Promise<Video> {
    return this.prisma.video.update({
      where: { id },
      data: {
        status: VideoStatus.READY,
        duration: data.duration,
        resolution: data.resolution,
        hlsMasterPath: data.hlsMasterPath,
        renditions: data.renditions as unknown as Prisma.InputJsonValue,
        failureReason: null,
      },
    });
  }

  markFailed(id: string, reason: string): Promise<Video> {
    return this.prisma.video.update({
      where: { id },
      data: { status: VideoStatus.FAILED, failureReason: reason },
    });
  }

  /**
   * Resolves the streaming playlist for a movie, enforcing that
   * SUBSCRIPTION-access titles require either an active subscription or
   * staff access. Subtitles are gated by the exact same check (queried
   * after it passes), not a separate rule — a subtitle track is part of the
   * same title.
   *
   * A regular viewer is also held to the publish decision (H-7): the title
   * must be PUBLISHED and, for an episode, so must its show — the same rule
   * as MoviesService.findByIdOrThrow. Anything else answers the same 404 as
   * a missing id, and it is checked before the subscription so a 403 cannot
   * reveal that an unpublished title exists. Staff keep their preview.
   */
  async getStreamInfo(
    movieId: string,
    userId: string,
    role: Role,
  ): Promise<{
    playlistUrl: string;
    qualities: StreamQualityInfo[];
    subtitles: SubtitleInfo[];
  }> {
    // Only the fields the two checks below read: the publish rule
    // (status, seriesId, series.status) and the access rule (accessType,
    // series.accessType) — not the whole movie and series rows.
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: {
        status: true,
        accessType: true,
        seriesId: true,
        series: { select: { status: true, accessType: true } },
      },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    if (role === Role.USER) {
      if (VideosService.isHiddenFromViewers(movie)) {
        throw new NotFoundException('Movie not found');
      }

      // Episodes inherit access from the parent series — one active
      // subscription unlocks every episode, including ones added later. The
      // episode's own accessType is irrelevant by design.
      const accessType = movie.series
        ? movie.series.accessType
        : movie.accessType;

      if (accessType === AccessType.SUBSCRIPTION) {
        const activeSubscription = await this.prisma.userSubscription.findFirst(
          {
            where: { userId, expiresAt: { gt: new Date() } },
          },
        );
        if (!activeSubscription) {
          throw new ForbiddenException(
            'An active subscription is required to start streaming',
          );
        }
      }
    }

    // Loaded only AFTER the checks above passed, so the 404-before-403 order
    // and the subscription gate are unchanged. The latest video and its
    // subtitles come back in one query (they used to be two).
    const video = await this.prisma.video.findFirst({
      where: { movieId },
      orderBy: { createdAt: 'desc' },
      include: { subtitles: true },
    });
    if (!video || video.status !== VideoStatus.READY || !video.hlsMasterPath) {
      throw new NotFoundException('This movie is not ready for streaming yet');
    }
    const subtitles = video.subtitles;

    return {
      // signedPlaybackUrl: follows the host the client called the API on
      // (so streaming survives the machine changing networks) AND carries
      // the expiring path token the cache server insists on — the
      // subscription check above is what earns the token, so it is the
      // only thing standing between an unsubscribed viewer and the bytes.
      playlistUrl: this.minioService.signedPlaybackUrl(video.hlsMasterPath),
      // The same ladder the master adapts between, addressable one rung at a
      // time — this is what lets a client pin a quality. Every rung lives under
      // the master's own `videos/<id>/hls` scope, so it is the same token with
      // one path component swapped; nothing new is signed and the cache server
      // learns nothing.
      qualities: this.buildQualities(video.renditions),
      subtitles: subtitles.map((s) => ({
        id: s.id,
        language: s.language,
        label: s.label,
        format: s.format,
        isDefault: s.isDefault,
        url: this.minioService.signedPlaybackUrl(s.objectKey),
      })),
    };
  }

  /**
   * Turns the stored rendition list into signed, playable rungs.
   *
   * `Video.renditions` is a Json column, so what comes back is whatever was
   * written into it — this mapper is therefore TOTAL: a missing column, a
   * non-array, a malformed entry or a path that cannot be signed each drop out
   * quietly instead of failing the whole playback bootstrap. A title with no
   * usable rungs honestly reports an empty list, and the clients then offer no
   * quality control at all.
   *
   * Sorted best-first HERE because the two producers disagree about order:
   * the transcode path writes RENDITION_TIERS order (1080p→240p) while the
   * bulk-upload path writes KNOWN_RENDITIONS order (240p→1080p). Sorting once,
   * server-side, is what stops every client inventing its own answer.
   */
  private buildQualities(renditions: unknown): StreamQualityInfo[] {
    if (!Array.isArray(renditions)) return [];

    const qualities: StreamQualityInfo[] = [];
    for (const entry of renditions) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        continue;
      }
      const { resolution, playlistPath } = entry as {
        resolution?: unknown;
        playlistPath?: unknown;
      };
      if (typeof resolution !== 'string' || resolution.trim() === '') continue;
      if (typeof playlistPath !== 'string' || playlistPath.trim() === '') {
        continue;
      }

      try {
        qualities.push({
          label: resolution,
          url: this.minioService.signedPlaybackUrl(playlistPath),
        });
      } catch (error: unknown) {
        // A path outside a signable scope throws (StreamKeyNotSignable) — a
        // legacy row, or the LOCAL ffmpeg output path the transcoder holds
        // before the upload rewrites it. One unplayable rung must never cost
        // the viewer the whole stream.
        this.logger.warn(
          `Skipping unsignable rendition "${resolution}" (${playlistPath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // An unparseable label sorts last and, the sort being stable, keeps its
    // place among its own kind.
    const height = (label: string): number => {
      const match = /(\d+)/.exec(label);
      return match ? Number(match[1]) : -1;
    };
    return qualities.sort((a, b) => height(b.label) - height(a.label));
  }

  /**
   * Upserts the caller's watch progress for a movie — feeds analytics
   * (views, completion rate) and, since this is the only heartbeat either
   * client sends, the hour-bucketed WatchActivity log behind "when do people
   * watch".
   *
   * The seconds credited to that log are derived from the position ALREADY
   * STORED versus the one being written, both server-side facts — the client
   * never gets to say how long it watched. Its own response is unchanged.
   *
   * A regular viewer is held to the same publish decision as getStreamInfo
   * (L-45): a title they could not stream answers the same 404 as a missing
   * id, so a heartbeat can neither write progress / watch-activity rows for
   * a draft or archived title nor confirm that its id exists. Staff keep
   * recording against their draft previews.
   */
  async recordWatchProgress(
    userId: string,
    movieId: string,
    progress: number,
    lastPosition: number,
    viewerRole: Role,
  ) {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: {
        id: true,
        status: true,
        seriesId: true,
        series: { select: { status: true } },
      },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    if (viewerRole === Role.USER && VideosService.isHiddenFromViewers(movie)) {
      throw new NotFoundException('Movie not found');
    }

    // Read before the upsert overwrites it — this is the "previous" end of
    // the delta. No row yet means the user is starting from 0.
    const existing = await this.prisma.watchHistory.findUnique({
      where: { userId_movieId: { userId, movieId } },
      select: { lastPosition: true },
    });

    const updated = await this.prisma.watchHistory.upsert({
      where: { userId_movieId: { userId, movieId } },
      create: { userId, movieId, progress, lastPosition },
      update: { progress, lastPosition },
    });

    // Awaited (so the bucket is durable by the time the heartbeat is
    // acknowledged) but never allowed to fail the heartbeat — playback
    // progress is the user's data, watch activity is only ours.
    await this.trackingService
      .recordWatchActivity({
        userId,
        movieId,
        previousPosition: existing?.lastPosition ?? 0,
        nextPosition: lastPosition,
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed to record watch activity: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    return updated;
  }

  /**
   * The caller's own saved position for one title, or null when they have
   * none — what a player needs to resume, without paging through the whole
   * watch history (the mobile app used to read 100 rows to find one, and a
   * title older than those 100 silently restarted at 0:00).
   *
   * Keyed by the caller's id from the access token and the movie id, exactly
   * like the PATCH that writes it: a user can only ever read their own row.
   * One indexed lookup on the (userId, movieId) unique key.
   */
  async getWatchProgress(
    userId: string,
    movieId: string,
  ): Promise<{ position: number; progress: number; updatedAt: Date } | null> {
    const row = await this.prisma.watchHistory.findUnique({
      where: { userId_movieId: { userId, movieId } },
      select: { lastPosition: true, progress: true, updatedAt: true },
    });
    if (!row) return null;
    return {
      position: row.lastPosition,
      progress: row.progress,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * The one publish rule a regular viewer is held to, shared by streaming and
   * watch-progress so the two can never disagree: the title must be
   * PUBLISHED and, for an episode, so must its show — the same rule as
   * MoviesService.findByIdOrThrow.
   */
  private static isHiddenFromViewers(movie: {
    status: MovieStatus;
    seriesId: string | null;
    series: { status: SeriesStatus } | null;
  }): boolean {
    return isHiddenFromViewers(movie);
  }

  /** Watch history for a user (own profile, or an admin viewing any user). */
  async getWatchHistoryForUser(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.watchHistory.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          movie: {
            select: { id: true, title: true, posterUrl: true, duration: true },
          },
        },
      }),
      this.prisma.watchHistory.count({ where: { userId } }),
    ]);

    return {
      items: items.map((h) => ({
        id: h.id,
        movieId: h.movieId,
        movieTitle: h.movie.title,
        posterUrl: this.minioService.imageUrl(h.movie.posterUrl),
        durationMinutes: h.movie.duration,
        progress: h.progress,
        lastPosition: h.lastPosition,
        updatedAt: h.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  /** Latest video (upload/processing) status for a movie — polled by the admin upload UI. */
  async getLatestStatusForMovie(movieId: string) {
    const video = await this.findLatestForMovie(movieId);
    if (!video)
      throw new NotFoundException('No video uploaded for this movie yet');

    return {
      id: video.id,
      status: video.status,
      failureReason: video.failureReason,
      duration: video.duration,
      resolution: video.resolution,
      hlsMasterPath: video.hlsMasterPath
        ? this.minioService.signedPlaybackUrl(video.hlsMasterPath)
        : null,
      renditions: video.renditions,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    };
  }
}
