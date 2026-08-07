import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccessType,
  Role,
  VideoStatus,
  type Prisma,
  type Video,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
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

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
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

  findById(id: string): Promise<Video | null> {
    return this.prisma.video.findUnique({ where: { id } });
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
   */
  async getStreamInfo(
    movieId: string,
    userId: string,
    role: Role,
  ): Promise<{ playlistUrl: string; subtitles: SubtitleInfo[] }> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      include: { series: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    if (role === Role.USER) {
      // Episodes inherit access from the parent series — one active
      // subscription unlocks every episode, including ones added later. The
      // episode's own accessType is irrelevant by design.
      const accessType = movie.series
        ? movie.series.accessType
        : movie.accessType;

      if (accessType === AccessType.SUBSCRIPTION) {
        const activeSubscription = await this.prisma.userSubscription.findFirst({
          where: { userId, expiresAt: { gt: new Date() } },
        });
        if (!activeSubscription) {
          throw new ForbiddenException(
            'An active subscription is required to start streaming',
          );
        }
      }
    }

    const video = await this.findLatestForMovie(movieId);
    if (!video || video.status !== VideoStatus.READY || !video.hlsMasterPath) {
      throw new NotFoundException('This movie is not ready for streaming yet');
    }

    const subtitles = await this.prisma.subtitle.findMany({
      where: { videoId: video.id },
    });

    return {
      playlistUrl: this.minioService.publicUrl(video.hlsMasterPath),
      subtitles: subtitles.map((s) => ({
        id: s.id,
        language: s.language,
        label: s.label,
        format: s.format,
        isDefault: s.isDefault,
        url: this.minioService.publicUrl(s.objectKey),
      })),
    };
  }

  /** Upserts the caller's watch progress for a movie — feeds analytics (views, completion rate). */
  async recordWatchProgress(
    userId: string,
    movieId: string,
    progress: number,
    lastPosition: number,
  ) {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { id: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    return this.prisma.watchHistory.upsert({
      where: { userId_movieId: { userId, movieId } },
      create: { userId, movieId, progress, lastPosition },
      update: { progress, lastPosition },
    });
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
        posterUrl: h.movie.posterUrl,
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
        ? this.minioService.publicUrl(video.hlsMasterPath)
        : null,
      renditions: video.renditions,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    };
  }
}
