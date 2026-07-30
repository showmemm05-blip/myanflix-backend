import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { SubtitleFormat } from '../generated/prisma/client';
import type { CreateSubtitleDto } from './dto/create-subtitle.dto';
import type { UpdateSubtitleDto } from './dto/update-subtitle.dto';

export const EXTENSION_TO_FORMAT: Record<string, SubtitleFormat> = {
  '.srt': SubtitleFormat.SRT,
  '.vtt': SubtitleFormat.VTT,
  '.ass': SubtitleFormat.ASS,
};

@Injectable()
export class SubtitlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  async create(dto: CreateSubtitleDto, originalFilename: string, buffer: Buffer) {
    const video = await this.prisma.video.findUnique({ where: { id: dto.videoId } });
    if (!video) throw new NotFoundException('Video not found');

    // Format is derived server-side from the actual file extension, not
    // trusted from client input — same reasoning as content-type detection
    // everywhere else in the storage layer.
    const extension = extname(originalFilename).toLowerCase();
    const format = EXTENSION_TO_FORMAT[extension];
    if (!format) {
      throw new BadRequestException('Subtitle file must be .srt, .vtt, or .ass');
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

    return this.prisma.subtitle.create({
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
  }

  /**
   * For a subtitle file that's already sitting in storage under its final
   * key (the externally-pre-transcoded bundle flow uploads it there via the
   * same chunked mechanism as everything else) — just records the row, no
   * upload involved. Always non-default: the admin can promote one via the
   * existing setDefault() once the movie is published.
   */
  createFromExistingKey(data: {
    videoId: string;
    language: string;
    label: string;
    format: SubtitleFormat;
    objectKey: string;
  }) {
    return this.prisma.subtitle.create({
      data: {
        videoId: data.videoId,
        language: data.language,
        label: data.label,
        format: data.format,
        objectKey: data.objectKey,
        isDefault: false,
      },
    });
  }

  findAllForVideo(videoId: string) {
    return this.prisma.subtitle.findMany({ where: { videoId }, orderBy: { createdAt: 'asc' } });
  }

  async update(id: string, dto: UpdateSubtitleDto) {
    const subtitle = await this.assertExists(id);

    if (dto.isDefault) {
      await this.clearExistingDefault(subtitle.videoId, id);
    }

    return this.prisma.subtitle.update({
      where: { id },
      data: { language: dto.language, label: dto.label, isDefault: dto.isDefault },
    });
  }

  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.subtitle.delete({ where: { id } });
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

    return this.prisma.subtitle.findUniqueOrThrow({ where: { id } });
  }

  private async clearExistingDefault(videoId: string, excludeId?: string): Promise<void> {
    await this.prisma.subtitle.updateMany({
      where: { videoId, isDefault: true, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      data: { isDefault: false },
    });
  }

  private async assertExists(id: string) {
    const subtitle = await this.prisma.subtitle.findUnique({ where: { id } });
    if (!subtitle) throw new NotFoundException('Subtitle not found');
    return subtitle;
  }
}
