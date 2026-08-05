import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { access, readdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import {
  MovieStatus,
  UploadStatus,
  VideoStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import { VideosService } from '../videos/videos.service';
import { ProcessingService } from '../processing/processing.service';
import {
  SubtitlesService,
  EXTENSION_TO_FORMAT,
} from '../subtitles/subtitles.service';
import type { InitUploadDto } from './dto/init-upload.dto';
import type { ValidateExternalBundleDto } from './dto/validate-external-bundle.dto';

// 5 MB — small enough that one chunk still finishes comfortably within the
// server's request timeout on a throttled/mobile connection, and a failed
// chunk only costs 5 MB of retried work instead of 16.
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

// The externally-pre-transcoded bundle's folder structure is a fixed
// contract (see the admin upload-external page) — these are the only
// rendition names it recognizes when deriving what to publish.
const KNOWN_RENDITIONS = ['240p', '360p', '480p', '720p', '1080p'];
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass']);

// Filenames the other PC is expected to use for its subtitle tracks (e.g.
// "english.vtt", "myanmar.vtt") — mapped to ISO codes where recognized, else
// the filename stem itself is used as the language code.
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  myanmar: 'my',
  burmese: 'my',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  spanish: 'es',
  french: 'fr',
  hindi: 'hi',
};

interface BundleStructure {
  renditions: string[];
  subtitlePaths: string[];
  errors: string[];
}

type CompleteUploadResult =
  | { videoId: string; status: VideoStatus }
  | { relativePath: string; status: UploadStatus };

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly videosService: VideosService,
    private readonly processingService: ProcessingService,
    private readonly subtitlesService: SubtitlesService,
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
    const movie = await this.prisma.movie.findUnique({
      where: { id: dto.movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    // relativePath is part of the match — without this, two different files
    // in an externally-transcoded bundle sharing a bare filename (every
    // rendition's playlist is named "index.m3u8") would collide and resume
    // against the wrong session. `relativePath ?? null` keeps the classic
    // single-file flow's existing behavior exactly as it was: those
    // sessions only ever match other relativePath-less requests.
    const existing = await this.prisma.uploadSession.findFirst({
      where: {
        movieId: dto.movieId,
        filename: dto.filename,
        fileSize: BigInt(dto.filesize),
        relativePath: dto.relativePath ?? null,
        status: UploadStatus.IN_PROGRESS,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return {
        uploadId: existing.id,
        chunkSize: existing.chunkSize,
        totalChunks: existing.totalChunks,
        uploadedChunks: await this.listUploadedChunks(existing.id),
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
        relativePath: dto.relativePath,
        tempDir: '', // filled in below once we know the id
      },
    });

    const tempDir = this.storageService.uploadSessionDir(session.id);
    await this.storageService.ensureDir(tempDir);
    await this.prisma.uploadSession.update({
      where: { id: session.id },
      data: { tempDir },
    });

    return {
      uploadId: session.id,
      chunkSize: DEFAULT_CHUNK_SIZE,
      totalChunks,
      uploadedChunks: [] as number[],
    };
  }

  async saveChunk(
    uploadId: string,
    chunkNumber: number,
    buffer: Buffer,
  ): Promise<void> {
    const session = await this.getActiveSessionOrThrow(uploadId);

    if (chunkNumber < 0 || chunkNumber >= session.totalChunks) {
      throw new BadRequestException(
        `chunkNumber must be between 0 and ${session.totalChunks - 1}`,
      );
    }

    await writeFile(
      this.storageService.chunkPath(uploadId, chunkNumber),
      buffer,
    );
  }

  async getStatus(uploadId: string) {
    const session = await this.getSessionOrThrow(uploadId);
    const uploadedChunks = await this.listUploadedChunks(uploadId);
    const remainingChunks = session.totalChunks - uploadedChunks.length;

    return {
      uploadedChunks,
      remainingChunks,
      totalChunks: session.totalChunks,
      status: session.status,
    };
  }

  /**
   * The chunk files a completed `writeFile` in `saveChunk` already leaves on
   * disk ARE the record of what's been received — no separate bookkeeping
   * needed. This replaced a Postgres `Int[]` column that used to get pushed
   * to on every single chunk: each push rewrote the entire (growing) array
   * for the row, making every chunk progressively more expensive than the
   * last as the upload went on. Listing files here instead makes a chunk
   * write O(1) regardless of how many chunks came before it, and removes a
   * second source of truth that could drift from the actual files (e.g. if
   * the process died between the file write and the old DB update).
   */
  private async listUploadedChunks(uploadId: string): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(this.storageService.uploadSessionDir(uploadId));
    } catch {
      return []; // session dir not created yet, or already cleaned up after completion
    }
    return entries
      .filter((name) => name.startsWith('chunk_'))
      .map((name) => Number(name.slice('chunk_'.length)))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  }

  /**
   * A retry landing while a previous completeUpload() attempt for the same
   * uploadId is still running (e.g. the client retrying after a slow MinIO
   * push looked like a timeout) must never start a second concurrent
   * merge — two mergeChunks() calls writing the same temp file at once
   * would corrupt it. Single-flight: a call that arrives mid-flight joins
   * the same in-flight promise instead of starting its own.
   */
  private readonly completingUploads = new Map<
    string,
    Promise<CompleteUploadResult>
  >();

  async completeUpload(uploadId: string): Promise<CompleteUploadResult> {
    const inFlight = this.completingUploads.get(uploadId);
    if (inFlight) return inFlight;

    const promise = this.runCompleteUpload(uploadId).finally(() => {
      this.completingUploads.delete(uploadId);
    });
    this.completingUploads.set(uploadId, promise);
    return promise;
  }

  /**
   * Merge chunks -> save original video -> update video status -> start
   * FFmpeg processing. Unless this session has a `relativePath` (the
   * externally-pre-transcoded bundle flow) — then it merges the chunks and
   * uploads the result straight to `videos/<movieId>/<relativePath>` in
   * MinIO, using the exact same key convention `StorageService`'s helpers
   * already produce, and stops there: no `Video` row, no transcoding. This
   * is what lets one chunked-upload mechanism serve both flows.
   */
  private async runCompleteUpload(
    uploadId: string,
  ): Promise<CompleteUploadResult> {
    const session = await this.getActiveSessionOrThrow(uploadId);

    const uploadedCount = (await this.listUploadedChunks(uploadId)).length;
    if (uploadedCount < session.totalChunks) {
      throw new BadRequestException(
        `Upload incomplete: ${uploadedCount}/${session.totalChunks} chunks received`,
      );
    }

    if (session.relativePath) {
      return this.completeExternalAssetUpload(
        uploadId,
        session.movieId,
        session.relativePath,
        session.totalChunks,
      );
    }

    const extension = extname(session.filename) || '.mp4';
    const originalPath = this.storageService.originalVideoPath(
      session.movieId,
      extension,
    );
    await this.storageService.ensureDir(
      this.storageService.videoDir(session.movieId),
    );
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
    void this.processingService.processVideo(
      video.id,
      session.movieId,
      originalPath,
    );

    return { videoId: video.id, status: video.status };
  }

  private async completeExternalAssetUpload(
    uploadId: string,
    movieId: string,
    relativePath: string,
    totalChunks: number,
  ): Promise<{ relativePath: string; status: UploadStatus }> {
    const tempPath = join(
      this.storageService.uploadSessionDir(uploadId),
      'merged',
    );
    await this.mergeChunks(uploadId, totalChunks, tempPath);

    await this.minioService.uploadFile(
      `videos/${movieId}/${relativePath}`,
      tempPath,
    );

    await this.prisma.uploadSession.update({
      where: { id: uploadId },
      data: { status: UploadStatus.COMPLETED },
    });
    await this.cleanupChunks(uploadId);

    return { relativePath, status: UploadStatus.COMPLETED };
  }

  /**
   * Cross-checks the admin frontend's own checklist of uploaded files
   * against what's actually in MinIO before allowing Publish — a real
   * server-side check, not a rubber stamp on the client's word — and also
   * confirms the bundle matches the fixed folder-structure contract (see
   * parseBundleStructure()), so a missing original/master/rendition is
   * caught here rather than surfacing as a confusing failure at publish.
   */
  async validateExternalBundle(
    movieId: string,
    dto: ValidateExternalBundleDto,
  ) {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    const results = await Promise.all(
      dto.relativePaths.map(async (relativePath) => ({
        relativePath,
        exists: await this.minioService.objectExists(
          `videos/${movieId}/${relativePath}`,
        ),
      })),
    );
    const missing = results.filter((r) => !r.exists).map((r) => r.relativePath);

    const { errors: structureErrors } = this.parseBundleStructure(
      dto.relativePaths,
    );

    return {
      missing,
      structureErrors,
      valid: missing.length === 0 && structureErrors.length === 0,
    };
  }

  /**
   * Runs automatically once the admin's bundle upload finishes — never runs
   * ffmpeg. The admin uploads one root folder (see parseBundleStructure()
   * for the fixed contract this expects); this derives which renditions and
   * subtitles actually exist from the uploaded relativePaths, re-validates
   * all of it server-side (never trusts the client's last upload-progress
   * state alone), then creates the Video row directly in the READY state
   * using the exact same `hlsMasterKey()`/`originalObjectKey()` helpers the
   * transcode-based flow already uses — the reason streaming
   * (`GET /videos/:movieId/stream`) needs zero changes to serve this video.
   *
   * The movie itself only ever moves to READY_TO_PUBLISH here (or FAILED if
   * the bundle turns out incomplete) — never PUBLISHED. Publishing is
   * always a separate, explicit admin action (see MoviesService.update()),
   * matching the bulk-upload flow's status lifecycle.
   */
  async finalizeExternalUpload(
    movieId: string,
    dto: ValidateExternalBundleDto,
  ) {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    const { renditions, subtitlePaths, errors } = this.parseBundleStructure(
      dto.relativePaths,
    );
    if (errors.length > 0) {
      await this.markMovieFailed(movieId);
      throw new BadRequestException(
        `Cannot finalize — invalid bundle structure: ${errors.join('; ')}`,
      );
    }

    const originalKey = this.storageService.originalObjectKey(movieId, '.mp4');
    const masterKey = this.storageService.hlsMasterKey(movieId);
    const requiredKeys = [
      originalKey,
      masterKey,
      ...renditions.map(
        (r) =>
          `${this.storageService.hlsRenditionKeyPrefix(movieId, r)}/index.m3u8`,
      ),
      ...subtitlePaths.map((p) => `videos/${movieId}/${p}`),
    ];

    const existence = await Promise.all(
      requiredKeys.map(async (key) => ({
        key,
        exists: await this.minioService.objectExists(key),
      })),
    );
    const missing = existence.filter((e) => !e.exists).map((e) => e.key);
    if (missing.length > 0) {
      await this.markMovieFailed(movieId);
      throw new BadRequestException(
        `Cannot finalize — missing required files: ${missing.join(', ')}`,
      );
    }

    const video = await this.videosService.create({
      movieId,
      originalFilename: 'original.mp4',
      originalPath: originalKey,
    });

    await this.videosService.markReady(video.id, {
      duration: null,
      resolution: null,
      hlsMasterPath: masterKey,
      renditions: renditions.map((resolution) => ({
        resolution,
        playlistPath: `${this.storageService.hlsRenditionKeyPrefix(movieId, resolution)}/index.m3u8`,
      })),
    });

    for (const relativePath of subtitlePaths) {
      const filename = basename(relativePath);
      const extension = extname(filename).toLowerCase();
      const stem = filename.slice(0, filename.length - extension.length);
      const code = LANGUAGE_NAME_TO_CODE[stem.toLowerCase()];

      await this.subtitlesService.createFromExistingKey({
        videoId: video.id,
        language: code ?? stem.toLowerCase(),
        label: stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase(),
        format: EXTENSION_TO_FORMAT[extension],
        objectKey: `videos/${movieId}/${relativePath}`,
      });
    }

    await this.prisma.movie.update({
      where: { id: movieId },
      data: { status: MovieStatus.READY_TO_PUBLISH },
    });

    return { videoId: video.id, status: VideoStatus.READY };
  }

  private async markMovieFailed(movieId: string): Promise<void> {
    await this.prisma.movie.update({
      where: { id: movieId },
      data: { status: MovieStatus.FAILED },
    });
  }

  /**
   * The fixed folder-structure contract the other PC's output must follow:
   *   original.mp4, hls/master.m3u8, hls/<resolution>/index.m3u8 (for any
   *   of the known renditions), subtitles/<name>.<srt|vtt|ass> (optional).
   * relativePaths already carry the "hls/" prefix for the master playlist
   * and every rendition — see stripDirectoryRoot()/the admin page, which
   * maps the single selected root folder onto this exact key convention so
   * `StorageService`'s existing helpers keep producing the right MinIO keys.
   */
  private parseBundleStructure(relativePaths: string[]): BundleStructure {
    const set = new Set(relativePaths);
    const errors: string[] = [];

    if (!set.has('original.mp4')) errors.push('original.mp4 is missing');
    if (!set.has('hls/master.m3u8')) errors.push('master.m3u8 is missing');

    const renditions = KNOWN_RENDITIONS.filter((r) =>
      set.has(`hls/${r}/index.m3u8`),
    );
    if (renditions.length === 0) {
      errors.push(
        'no valid rendition folder (240p, 360p, 480p, 720p, or 1080p) with an index.m3u8 was found',
      );
    }

    const subtitlePaths = relativePaths.filter(
      (p) =>
        p.startsWith('subtitles/') &&
        SUBTITLE_EXTENSIONS.has(extname(p).toLowerCase()),
    );

    return { renditions, subtitlePaths, errors };
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
      throw new BadRequestException(
        'Only a failed or stuck video can be reprocessed',
      );
    }

    if (!video.originalPath) {
      throw new BadRequestException(
        'No original file was recorded for this video — a new upload is required',
      );
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

  private async mergeChunks(
    uploadId: string,
    totalChunks: number,
    destination: string,
  ): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const output = createWriteStream(destination);
      output.on('error', rejectPromise);
      output.on('finish', () => resolvePromise());

      const appendChunk = (index: number) => {
        if (index >= totalChunks) {
          output.end();
          return;
        }
        const chunkStream = createReadStream(
          this.storageService.chunkPath(uploadId, index),
        );
        chunkStream.on('error', rejectPromise);
        chunkStream.on('end', () => appendChunk(index + 1));
        chunkStream.pipe(output, { end: false });
      };

      appendChunk(0);
    });
  }

  private async cleanupChunks(uploadId: string): Promise<void> {
    await rm(this.storageService.uploadSessionDir(uploadId), {
      recursive: true,
      force: true,
    });
  }

  private async getSessionOrThrow(uploadId: string) {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id: uploadId },
    });
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
