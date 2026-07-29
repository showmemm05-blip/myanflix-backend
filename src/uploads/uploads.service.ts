import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { access, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { UploadStatus, VideoStatus } from '../generated/prisma/client';
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

  /**
   * Resumable: an in-progress session for the exact same movie/filename/size
   * means the client is re-attempting an upload that never finished (a
   * dropped connection, a closed tab, a retry) rather than starting a new
   * one — reuse it and hand back what's already been received so the caller
   * can skip those chunks, instead of silently starting over from zero every
   * time and abandoning whatever was already sent.
   */
  async initUpload(dto: InitUploadDto) {
    const movie = await this.prisma.movie.findUnique({ where: { id: dto.movieId } });
    if (!movie) throw new NotFoundException('Movie not found');

    const existing = await this.prisma.uploadSession.findFirst({
      where: {
        movieId: dto.movieId,
        filename: dto.filename,
        fileSize: BigInt(dto.filesize),
        status: UploadStatus.IN_PROGRESS,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return {
        uploadId: existing.id,
        chunkSize: existing.chunkSize,
        totalChunks: existing.totalChunks,
        uploadedChunks: [...existing.uploadedChunks].sort((a, b) => a - b),
      };
    }

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
      uploadedChunks: [] as number[],
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

  /**
   * Retries transcoding for a movie whose video already failed — or whose
   * video is stuck at PROCESSING because whatever was working on it died
   * (a crash, a restart, a redeploy) — without the client re-uploading the
   * original. A transcode failure (a bad codec edge case, an OOM, a dropped
   * connection to the storage server mid-rendition) shouldn't cost the user
   * a multi-GB re-upload from their own browser just to try again, and a
   * genuinely stuck video shouldn't require waiting out a timeout either.
   *
   * PROCESSING is only accepted when ProcessingService confirms this exact
   * process isn't actually still working on it — that's the one reliable
   * way to tell "orphaned" apart from "genuinely still running," since two
   * concurrent processVideo() runs for the same movie would race on the
   * same scratch files and DB rows.
   *
   * The original is normally already archived on the storage server by the
   * time transcoding starts (that's the very first step in processVideo()),
   * so this just pulls it back down to local scratch disk and re-runs the
   * same pipeline — processVideo() itself skips re-archiving the original,
   * and skips re-transcoding any rendition, that's already there (see
   * MinioService.objectExists()), so a retry only redoes whatever tier was
   * actually in flight or never started.
   */
  async reprocessVideo(movieId: string) {
    const video = await this.videosService.findLatestForMovie(movieId);
    if (!video) throw new NotFoundException('No video found for this movie');

    if (video.status === VideoStatus.PROCESSING) {
      if (this.processingService.isActivelyProcessing(video.id)) {
        throw new ConflictException(
          'This video is actively processing right now — wait for it to finish, or restart the backend first if you believe it is stuck.',
        );
      }
      // Status says PROCESSING but nothing in this process is actually
      // working on it — orphaned. Safe to reprocess immediately.
    } else if (video.status !== VideoStatus.FAILED) {
      throw new BadRequestException('Only a failed or stuck video can be reprocessed');
    }

    if (!video.originalPath) {
      throw new BadRequestException('No original file was recorded for this video — a new upload is required');
    }

    const inputPath = await this.resolveOriginalForReprocessing(movieId, video);

    // Fire-and-forget, matching the exact same pattern completeUpload() uses
    // to kick off processing after a normal upload.
    void this.processingService.processVideo(video.id, movieId, inputPath);

    return { videoId: video.id, status: VideoStatus.PROCESSING };
  }

  /**
   * A failed Video's originalPath is either still a local scratch path (the
   * failure happened before/at archiving, so cleanupScratch() never got a
   * chance to remove it) or already a MinIO object key (archiving
   * succeeded; a later rendition or ffmpeg step is what failed) — in which
   * case it needs to be pulled back down before ffmpeg can read it again.
   */
  private async resolveOriginalForReprocessing(
    movieId: string,
    video: { originalPath: string; originalFilename: string },
  ): Promise<string> {
    if (await this.pathExistsLocally(video.originalPath)) {
      return video.originalPath;
    }

    const extension = extname(video.originalFilename) || '.mp4';
    const localPath = this.storageService.originalVideoPath(movieId, extension);
    await this.storageService.ensureDir(this.storageService.videoDir(movieId));
    await this.minioService.downloadFile(video.originalPath, localPath);
    return localPath;
  }

  private async pathExistsLocally(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
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
