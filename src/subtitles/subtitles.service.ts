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
import { SubtitleFormat } from '../generated/prisma/client';
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
    private readonly hlsSubtitlesService: HlsSubtitlesService,
  ) {}

  async create(
    dto: CreateSubtitleDto,
    originalFilename: string,
    buffer: Buffer,
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

    // Generated up front so the object key (keyed by subtitle id, not
    // language — a video can have more than one track per language) is
    // known before the row exists.
    const id = randomUUID();
    const objectKey = `subtitles/${id}/original${extension}`;
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

    return subtitle;
  }

  /**
   * For a subtitle file that's already sitting in storage under its final
   * key (the externally-pre-transcoded bundle flow uploads it there via the
   * same chunked mechanism as everything else) — just records the row, no
   * upload involved. Always non-default: the admin can promote one via the
   * existing setDefault() once the movie is published.
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

  async update(id: string, dto: UpdateSubtitleDto) {
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

    return updated;
  }

  async remove(id: string): Promise<void> {
    const subtitle = await this.assertExists(id);
    const video = await this.prisma.video.findUnique({
      where: { id: subtitle.videoId },
      select: { movieId: true },
    });

    await this.prisma.subtitle.delete({ where: { id } });

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
  }

  /** Atomically claims "default" for this subtitle, unsetting any other default for the same video in the same transaction. */
  async setDefault(id: string) {
    const subtitle = await this.assertExists(id);

    await this.prisma.$transaction([
      this.prisma.subtitle.updateMany({
        where: { videoId: subtitle.videoId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.subtitle.update({ where: { id }, data: { isDefault: true } }),
    ]);

    await this.publishQuietly(subtitle.videoId);

    return this.prisma.subtitle.findUniqueOrThrow({ where: { id } });
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
