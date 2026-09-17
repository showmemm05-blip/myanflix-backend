import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { SubtitleFormat } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { subtitleSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { HlsSubtitlesService } from './hls-subtitles.service';
import type { SubtitlePublishResult } from './hls-subtitles.service';
import type { CreateSubtitleDto } from './dto/create-subtitle.dto';
import type { UpdateSubtitleDto } from './dto/update-subtitle.dto';

export const EXTENSION_TO_FORMAT: Record<string, SubtitleFormat> = {
  '.srt': SubtitleFormat.SRT,
  '.vtt': SubtitleFormat.VTT,
  '.ass': SubtitleFormat.ASS,
};

@Injectable()
export class SubtitlesService {
  private readonly logger = new Logger(SubtitlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
    private readonly hlsSubtitlesService: HlsSubtitlesService,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreateSubtitleDto,
    originalFilename: string,
    buffer: Buffer,
    actor: AuthenticatedUser,
  ) {
    const video = await this.prisma.video.findUnique({
      where: { id: dto.videoId },
    });
    if (!video) throw new NotFoundException('Video not found');

    // Format is derived server-side from the actual file extension, not
    // trusted from client input — same reasoning as content-type detection
    // everywhere else in the storage layer.
    const extension = extname(originalFilename).toLowerCase();
    const format = EXTENSION_TO_FORMAT[extension];
    if (!format) {
      throw new BadRequestException(
        'Subtitle file must be .srt, .vtt, or .ass',
      );
    }

    // Generated up front so the filename (the subtitle id, not the language —
    // a video can have more than one track per language) is known before the
    // row exists.
    //
    // The key is foldered by the OWNING MOVIE, which is why the movie is
    // resolved here rather than only for the audit row below: a title's
    // sources are then one prefix delete, and one `subtitles/<movieId>`
    // scope signs every track the stream response hands out — exactly like
    // the bulk bundle flow, which writes its operator-named files into the
    // same folder.
    const id = randomUUID();
    const objectKey = this.storageService.subtitleSourceKey(
      video.movieId,
      `${id}${extension}`,
    );
    await this.minioService.uploadBuffer(objectKey, buffer);

    if (dto.isDefault) {
      await this.clearExistingDefault(dto.videoId);
    }

    const subtitle = await this.prisma.subtitle.create({
      data: {
        id,
        videoId: dto.videoId,
        language: dto.language,
        label: dto.label,
        format,
        objectKey,
        isDefault: dto.isDefault ?? false,
      },
    });

    await this.publishQuietly(dto.videoId);

    await this.audit.record({
      action: 'subtitle.upload',
      actor,
      target: { type: 'subtitle', id: subtitle.id, label: subtitle.label },
      after: subtitleSnapshot(subtitle),
      metadata: {
        movieId: video.movieId,
        videoId: subtitle.videoId,
        originalFilename,
      },
    });

    return subtitle;
  }

  /**
   * For a subtitle file that's already sitting in storage under its final
   * key (the externally-pre-transcoded bundle flow uploads it there via the
   * same chunked mechanism as everything else) — just records the row, no
   * upload involved. Always non-default: the admin can promote one via the
   * existing setDefault() once the movie is published.
   *
   * The key is whatever that flow built —
   * `subtitles/<movieId>/<operator's own filename>`, the same folder
   * create() writes into, so both ingest paths land in one namespace and
   * remove() below can delete either of them without knowing which flow
   * produced it.
   */
  async createFromExistingKey(data: {
    videoId: string;
    language: string;
    label: string;
    format: SubtitleFormat;
    objectKey: string;
  }) {
    const subtitle = await this.prisma.subtitle.create({
      data: {
        videoId: data.videoId,
        language: data.language,
        label: data.label,
        format: data.format,
        objectKey: data.objectKey,
        isDefault: false,
      },
    });

    await this.publishQuietly(data.videoId);

    return subtitle;
  }

  findAllForVideo(videoId: string) {
    return this.prisma.subtitle.findMany({
      where: { videoId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(id: string, dto: UpdateSubtitleDto, actor: AuthenticatedUser) {
    const subtitle = await this.assertExists(id);

    if (dto.isDefault) {
      await this.clearExistingDefault(subtitle.videoId, id);
    }

    const updated = await this.prisma.subtitle.update({
      where: { id },
      data: {
        language: dto.language,
        label: dto.label,
        isDefault: dto.isDefault,
      },
    });

    // label and language are literally the NAME=/LANGUAGE= a player shows in
    // its menu, so a metadata edit has to reach the manifest too.
    await this.publishQuietly(subtitle.videoId);

    await this.audit.record({
      action: 'subtitle.update',
      actor,
      target: { type: 'subtitle', id, label: updated.label },
      before: subtitleSnapshot(subtitle),
      after: subtitleSnapshot(updated),
      metadata: await this.ownerIds(subtitle.videoId),
    });

    return updated;
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const subtitle = await this.assertExists(id);
    const video = await this.prisma.video.findUnique({
      where: { id: subtitle.videoId },
      select: { movieId: true },
    });

    await this.prisma.subtitle.delete({ where: { id } });

    await this.audit.record({
      action: 'subtitle.delete',
      actor,
      target: { type: 'subtitle', id, label: subtitle.label },
      before: subtitleSnapshot(subtitle),
      metadata: {
        movieId: video?.movieId ?? null,
        videoId: subtitle.videoId,
      },
    });

    // Manifest FIRST, objects only once it succeeded. The re-publish is
    // best-effort (see publishQuietly), so deleting the objects up front and
    // then failing to rewrite the master would leave the master permanently
    // advertising a rendition whose .m3u8/.vtt are gone — players stall on
    // the subtitle load, and nothing retries but a manual republish. In this
    // order the same failure leaves an unreferenced object instead, which is
    // inert and gets swept up by the next publish for this video.
    //
    // The row is already deleted, so the rewrite re-derives the group without
    // it — and deleting the last track removes the whole subtitle group (and
    // the SUBTITLES= attributes) rather than leaving a dangling URI.
    const republished = await this.publishQuietly(subtitle.videoId);
    if (video && republished) {
      await this.hlsSubtitlesService.unpublishSubtitle(video.movieId, id);
    }

    // The uploaded SOURCE file — previously left behind on every delete, so
    // a title that had its tracks replaced a few times kept paying for every
    // .srt ever uploaded to it, with no row left to find them by. Last, and
    // best-effort for the same reason as unpublishSubtitle(): nothing serves
    // it any more once the row is gone, so a failure here is inert storage
    // rather than a broken manifest.
    try {
      await this.minioService.deleteObject(subtitle.objectKey);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not delete subtitle source ${subtitle.objectKey}: ${reason}`,
      );
    }
  }

  /** Atomically claims "default" for this subtitle, unsetting any other default for the same video in the same transaction. */
  async setDefault(id: string, actor: AuthenticatedUser) {
    const subtitle = await this.assertExists(id);

    await this.prisma.$transaction([
      this.prisma.subtitle.updateMany({
        where: { videoId: subtitle.videoId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.subtitle.update({ where: { id }, data: { isDefault: true } }),
    ]);

    await this.publishQuietly(subtitle.videoId);

    const updated = await this.prisma.subtitle.findUniqueOrThrow({
      where: { id },
    });

    await this.audit.record({
      action: 'subtitle.set_default',
      actor,
      target: { type: 'subtitle', id, label: updated.label },
      before: subtitleSnapshot(subtitle),
      after: subtitleSnapshot(updated),
      metadata: await this.ownerIds(subtitle.videoId),
    });

    return updated;
  }

  /** `{ movieId, videoId }` for an audit row — the movie a track belongs to is one hop away. */
  private async ownerIds(
    videoId: string,
  ): Promise<{ movieId: string | null; videoId: string }> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { movieId: true },
    });
    return { movieId: video?.movieId ?? null, videoId };
  }

  /**
   * Re-runs the publish for the movie this subtitle belongs to — the
   * backfill path for rows that predate manifest publishing. Deliberately
   * the same routine the write paths use rather than a one-off script, and
   * safe to call repeatedly (the master rewrite is idempotent).
   */
  async republish(id: string): Promise<SubtitlePublishResult> {
    const subtitle = await this.assertExists(id);
    return this.hlsSubtitlesService.publishForVideo(subtitle.videoId);
  }

  /** Same backfill, addressed by movie — useful when no subtitle id is at hand. */
  republishForMovie(movieId: string): Promise<SubtitlePublishResult> {
    return this.hlsSubtitlesService.publishForMovie(movieId);
  }

  /**
   * Publishing is a projection of the database into the storage layer, not
   * part of the write itself: a storage hiccup must not fail (or worse,
   * half-undo) an admin's subtitle edit. It is logged and left to the next
   * publish — or an explicit republish — to converge.
   *
   * Returns whether the manifest is now known to reflect the database, which
   * `remove()` needs before it is safe to delete the published objects. A
   * `skipped` publish still counts: it means no master advertises them.
   */
  private async publishQuietly(videoId: string): Promise<boolean> {
    try {
      const result = await this.hlsSubtitlesService.publishForVideo(videoId);
      if (result.skipped) {
        this.logger.log(
          `Subtitle renditions not published for video ${videoId}: ${result.skipped}`,
        );
      }
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not publish subtitle renditions for video ${videoId}: ${reason}`,
      );
      return false;
    }
  }

  private async clearExistingDefault(
    videoId: string,
    excludeId?: string,
  ): Promise<void> {
    await this.prisma.subtitle.updateMany({
      where: {
        videoId,
        isDefault: true,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  private async assertExists(id: string) {
    const subtitle = await this.prisma.subtitle.findUnique({ where: { id } });
    if (!subtitle) throw new NotFoundException('Subtitle not found');
    return subtitle;
  }
}
