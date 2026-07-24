import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { UploadStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { ProcessingService } from '../processing/processing.service';
import type { InitUploadDto } from './dto/init-upload.dto';

// 5 MB — small enough that one chunk still finishes comfortably within the
// server's request timeout on a throttled/mobile connection, and a failed
// chunk only costs 5 MB of retried work instead of 16.
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly videosService: VideosService,
    private readonly processingService: ProcessingService,
  ) {}

  async initUpload(dto: InitUploadDto) {
    const movie = await this.prisma.movie.findUnique({ where: { id: dto.movieId } });
    if (!movie) throw new NotFoundException('Movie not found');

    const totalChunks = Math.ceil(dto.filesize / DEFAULT_CHUNK_SIZE);

    const session = await this.prisma.uploadSession.create({
      data: {
        movieId: dto.movieId,
        filename: dto.filename,
        fileSize: BigInt(dto.filesize),
        chunkSize: DEFAULT_CHUNK_SIZE,
        totalChunks,
        tempDir: '', // filled in below once we know the id
      },
    });

    const tempDir = this.storageService.uploadSessionDir(session.id);
    await this.storageService.ensureDir(tempDir);
    await this.prisma.uploadSession.update({ where: { id: session.id }, data: { tempDir } });

    return {
      uploadId: session.id,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks,
    };
  }

  async saveChunk(uploadId: string, chunkNumber: number, buffer: Buffer): Promise<void> {
    const session = await this.getActiveSessionOrThrow(uploadId);

    if (chunkNumber < 0 || chunkNumber >= session.totalChunks) {
      throw new BadRequestException(
        `chunkNumber must be between 0 and ${session.totalChunks - 1}`,
      );
    }

    await writeFile(this.storageService.chunkPath(uploadId, chunkNumber), buffer);

    if (!session.uploadedChunks.includes(chunkNumber)) {
      await this.prisma.uploadSession.update({
        where: { id: uploadId },
        data: { uploadedChunks: { push: chunkNumber } },
      });
    }
  }

  async getStatus(uploadId: string) {
    const session = await this.getSessionOrThrow(uploadId);
    const uploadedChunks = [...session.uploadedChunks].sort((a, b) => a - b);
    const remainingChunks = session.totalChunks - uploadedChunks.length;

    return { uploadedChunks, remainingChunks, totalChunks: session.totalChunks, status: session.status };
  }

  /** Merge chunks -> save original video -> update video status -> start FFmpeg processing. */
  async completeUpload(uploadId: string) {
    const session = await this.getActiveSessionOrThrow(uploadId);

    if (session.uploadedChunks.length < session.totalChunks) {
      throw new BadRequestException(
        `Upload incomplete: ${session.uploadedChunks.length}/${session.totalChunks} chunks received`,
      );
    }

    const extension = extname(session.filename) || '.mp4';
    const originalPath = this.storageService.originalVideoPath(session.movieId, extension);
    await this.storageService.ensureDir(this.storageService.videoDir(session.movieId));
    await this.mergeChunks(uploadId, session.totalChunks, originalPath);

    const video = await this.videosService.create({
      movieId: session.movieId,
      originalFilename: session.filename,
      originalPath,
    });

    await this.prisma.uploadSession.update({
      where: { id: uploadId },
      data: { status: UploadStatus.COMPLETED },
    });

    await this.cleanupChunks(uploadId);

    // Kick off transcoding without blocking the HTTP response.
    void this.processingService.processVideo(video.id, session.movieId, originalPath);

    return { videoId: video.id, status: video.status };
  }

  /** Uploads a poster/cover image straight to the storage server (no local disk involved) and returns its public URL. */
  async saveImage(originalFilename: string, buffer: Buffer): Promise<string> {
    const extension = extname(originalFilename) || '.jpg';
    const key = this.storageService.imageObjectKey(randomUUID(), extension);
    await this.minioService.uploadBuffer(key, buffer);
    return this.minioService.publicUrl(key);
  }

  private async mergeChunks(uploadId: string, totalChunks: number, destination: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const output = createWriteStream(destination);
      output.on('error', rejectPromise);
      output.on('finish', () => resolvePromise());

      const appendChunk = (index: number) => {
        if (index >= totalChunks) {
          output.end();
          return;
        }
        const chunkStream = createReadStream(this.storageService.chunkPath(uploadId, index));
        chunkStream.on('error', rejectPromise);
        chunkStream.on('end', () => appendChunk(index + 1));
        chunkStream.pipe(output, { end: false });
      };

      appendChunk(0);
    });
  }

  private async cleanupChunks(uploadId: string): Promise<void> {
    await rm(this.storageService.uploadSessionDir(uploadId), { recursive: true, force: true });
  }

  private async getSessionOrThrow(uploadId: string) {
    const session = await this.prisma.uploadSession.findUnique({ where: { id: uploadId } });
    if (!session) throw new NotFoundException('Upload session not found');
    return session;
  }

  private async getActiveSessionOrThrow(uploadId: string) {
    const session = await this.getSessionOrThrow(uploadId);
    if (session.status !== UploadStatus.IN_PROGRESS) {
      throw new BadRequestException('This upload session is no longer active');
    }
    return session;
  }
}
