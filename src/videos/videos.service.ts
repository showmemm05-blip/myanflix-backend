import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, VideoStatus, type Prisma, type Video } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
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

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
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
    return this.prisma.video.findFirst({ where: { movieId }, orderBy: { createdAt: 'desc' } });
  }

  markProcessing(id: string): Promise<Video> {
    return this.prisma.video.update({
      where: { id },
      data: { status: VideoStatus.PROCESSING },
    });
  }

  markReady(
    id: string,
    data: { duration: number; resolution: string; hlsMasterPath: string; renditions: RenditionInfo[] },
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
   * Resolves the streaming playlist for a movie, enforcing that premium
   * titles require either a completed purchase or staff access.
   */
  async getStreamInfo(movieId: string, userId: string, role: Role): Promise<{ playlistUrl: string }> {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId } });
    if (!movie) throw new NotFoundException('Movie not found');

    if (movie.isPremium && role === Role.USER) {
      const purchase = await this.prisma.purchase.findUnique({
        where: { userId_movieId: { userId, movieId } },
      });
      if (!purchase) {
        throw new ForbiddenException('Purchase this movie to start streaming');
      }
    }

    const video = await this.findLatestForMovie(movieId);
    if (!video || video.status !== VideoStatus.READY || !video.hlsMasterPath) {
      throw new NotFoundException('This movie is not ready for streaming yet');
    }

    return { playlistUrl: this.storageService.toPublicPath(video.hlsMasterPath) };
  }

  /** Upserts the caller's watch progress for a movie — feeds analytics (views, completion rate). */
  async recordWatchProgress(userId: string, movieId: string, progress: number, lastPosition: number) {
    const movie = await this.prisma.movie.findUnique({ where: { id: movieId }, select: { id: true } });
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
        include: { movie: { select: { id: true, title: true, posterUrl: true, duration: true } } },
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
    if (!video) throw new NotFoundException('No video uploaded for this movie yet');

    return {
      id: video.id,
      status: video.status,
      failureReason: video.failureReason,
      duration: video.duration,
      resolution: video.resolution,
      hlsMasterPath: video.hlsMasterPath ? this.storageService.toPublicPath(video.hlsMasterPath) : null,
      renditions: video.renditions,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    };
  }
}
