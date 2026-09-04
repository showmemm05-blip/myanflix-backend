import { Injectable, Logger } from '@nestjs/common';
import { Prisma, VideoStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import {
  firstVariantUri,
  resolveRelativeKey,
  totalDurationFromMediaPlaylist,
} from '../subtitles/hls-subtitle-manifest';
import { normaliseDurationSeconds, secondsToMinutes } from './duration.util';

/** Project pagination law: no single call ever touches more than 100 rows. */
export const BACKFILL_MAX_LIMIT = 100;

export interface BackfillFailure {
  movieId: string;
  reason: string;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  failed: BackfillFailure[];
  remaining: number;
}

const READY_HLS_VIDEO = {
  status: VideoStatus.READY,
  hlsMasterPath: { not: null },
} satisfies Prisma.VideoWhereInput;

/** A movie whose runtime is still the unknown sentinel but which has an HLS tree to read it from. */
const UNKNOWN_RUNTIME_WITH_READY_HLS = {
  duration: 0,
  videos: { some: READY_HLS_VIDEO },
} satisfies Prisma.MovieWhereInput;

/**
 * Recovers a title's runtime from the HLS it actually streams and stores it
 * where — and only where — nothing is stored yet.
 *
 * The externally pre-transcoded bundle flow never probes its files, so every
 * bulk-uploaded title used to be born with Movie.duration 0 (the unknown
 * sentinel) and Video.duration null, and nothing ever filled them in. The
 * rendition playlist is the exact answer: the transcoder writes VOD
 * playlists, so the sum of its EXTINFs is the runtime the viewer plays, and
 * reading it costs a few KB from MinIO instead of streaming a multi-GB
 * original through ffprobe.
 *
 * PRECEDENCE: human > automatic. Every write here is an updateMany guarded
 * by `duration = 0` / `duration IS NULL` in the database predicate, so a
 * value an admin typed (EditMovieDialog, the single-upload form) or one the
 * browser probe sent at placeholder time is never overwritten, and running
 * any of this twice is a no-op.
 */
@Injectable()
export class VideoDurationService {
  private readonly logger = new Logger(VideoDurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * Sum of the first variant playlist's EXTINFs, in whole seconds, or null.
   * Never throws — a runtime problem must never fail the finalize or the
   * backfill loop that asked for it.
   */
  async recoverHlsDurationSeconds(masterKey: string): Promise<number | null> {
    try {
      const master = await this.minioService.readText(masterKey);
      const uri = firstVariantUri(master);
      if (!uri || /^https?:/i.test(uri)) return null;

      const variant = await this.minioService.readText(
        resolveRelativeKey(masterKey, uri),
      );
      return normaliseDurationSeconds(totalDurationFromMediaPlaylist(variant));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not recover a runtime for ${masterKey} (${reason})`,
      );
      return null;
    }
  }

  /**
   * Writes the runtime onto the movie only if it is still unknown. Returns
   * whether a row changed — false both when the seconds are unusable and
   * when a human (or an earlier probe) already filled the field.
   */
  async fillMovieDurationIfUnknown(
    movieId: string,
    seconds: number,
  ): Promise<boolean> {
    const minutes = secondsToMinutes(seconds);
    if (minutes === null) return false;

    const { count } = await this.prisma.movie.updateMany({
      where: { id: movieId, duration: 0 },
      data: { duration: minutes },
    });
    return count > 0;
  }

  /** Same rule for Video.duration (seconds), whose unknown sentinel is null. */
  async fillVideoDurationIfUnknown(
    videoId: string,
    seconds: number,
  ): Promise<boolean> {
    const normalised = normaliseDurationSeconds(seconds);
    if (normalised === null) return false;

    const { count } = await this.prisma.video.updateMany({
      where: { id: videoId, duration: null },
      data: { duration: normalised },
    });
    return count > 0;
  }

  /**
   * Admin-triggered repair for titles that predate runtime capture: every
   * movie still at duration 0 with a READY HLS video, oldest first, capped at
   * 100 per call. Idempotent by construction (see the class doc) — clicking
   * it again is safe, and `remaining` tells the admin whether to.
   */
  async backfill(limit: number): Promise<BackfillResult> {
    const take = Math.min(
      Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 0)),
      BACKFILL_MAX_LIMIT,
    );

    const movies = await this.prisma.movie.findMany({
      where: UNKNOWN_RUNTIME_WITH_READY_HLS,
      orderBy: { createdAt: 'asc' },
      take,
      select: {
        id: true,
        videos: {
          where: READY_HLS_VIDEO,
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, hlsMasterPath: true },
        },
      },
    });

    let updated = 0;
    const failed: BackfillFailure[] = [];

    for (const movie of movies) {
      const video = movie.videos[0];
      if (!video?.hlsMasterPath) {
        // Unreachable given the where clause, but the type says it can be.
        failed.push({
          movieId: movie.id,
          reason: 'no READY video with a master playlist',
        });
        continue;
      }

      const seconds = await this.recoverHlsDurationSeconds(video.hlsMasterPath);
      if (seconds === null) {
        failed.push({
          movieId: movie.id,
          reason: 'no readable EXTINF in the first variant playlist',
        });
        continue;
      }

      await this.fillVideoDurationIfUnknown(video.id, seconds);
      if (await this.fillMovieDurationIfUnknown(movie.id, seconds)) updated++;
    }

    const remaining = await this.prisma.movie.count({
      where: UNKNOWN_RUNTIME_WITH_READY_HLS,
    });

    return { scanned: movies.length, updated, failed, remaining };
  }
}
