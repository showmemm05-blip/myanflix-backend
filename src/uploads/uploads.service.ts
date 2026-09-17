import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
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
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { StorageService } from '../common/storage/storage.service';
import { MinioService } from '../common/storage/minio.service';
import type { ImagePurpose } from '../common/storage/media-taxonomy';
import { VideosService } from '../videos/videos.service';
import { VideoDurationService } from '../videos/video-duration.service';
import { ProcessingService } from '../processing/processing.service';
import {
  SubtitlesService,
  EXTENSION_TO_FORMAT,
} from '../subtitles/subtitles.service';
import {
  ResourceUploadTypeRegistry,
  SUBTITLE_RELATIVE_PREFIX,
} from './resource-upload-type.registry';
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

// The bundle's pre-transcode master, at the bundle root. The EXTENSION is
// deliberately not pinned: the operator transcodes from whatever container
// they were given (.mkv is common), and hard-coding ".mp4" here used to
// make such a bundle impossible to finalize at all.
const ORIGINAL_FILENAME_PATTERN = /^original\.[A-Za-z0-9]+$/;

// Every bundle flow below belongs to a movie (a series episode IS a Movie
// row), so they all resolve their object keys through the registry's
// "movie" entry rather than re-deriving the videos/ vs subtitles/ split a
// second time — see ResourceUploadTypeRegistry.buildKey.
const MOVIE_RESOURCE_TYPE = 'movie';

// The only movie states a bundle finalize may act on — the bulk flow's own
// lifecycle (see MovieStatus in prisma/schema.prisma): a movie is UPLOADING
// from the moment its folder is picked, or FAILED after a rejected
// finalize that the admin is retrying. Anything else (PUBLISHED, ARCHIVED,
// DRAFT, PROCESSING) is never touched by finalize; READY_TO_PUBLISH is
// replayed idempotently instead.
const FINALIZABLE_MOVIE_STATUSES: MovieStatus[] = [
  MovieStatus.UPLOADING,
  MovieStatus.FAILED,
];

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
  /** The bundle's `original.<ext>` — null only when `errors` says why. */
  originalPath: string | null;
  renditions: string[];
  subtitlePaths: string[];
  errors: string[];
}

type CompleteUploadResult =
  | { videoId: string; status: VideoStatus }
  | { relativePath: string; status: UploadStatus };

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly minioService: MinioService,
    private readonly videosService: VideosService,
    private readonly videoDurationService: VideoDurationService,
    private readonly processingService: ProcessingService,
    private readonly subtitlesService: SubtitlesService,
    private readonly audit: AuditService,
    private readonly resourceTypes: ResourceUploadTypeRegistry,
  ) {}

  /**
   * The object key one bundle file lands at. Routed through the shared
   * registry so this flow, the presigned flow and the multipart flow can
   * never disagree about where a file goes — in particular a subtitle
   * source, which leaves the bundle's videos/ namespace for subtitles/.
   */
  private bundleKey(movieId: string, relativePath: string): string {
    return this.resourceTypes
      .resolve(MOVIE_RESOURCE_TYPE)
      .buildKey(movieId, relativePath);
  }

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

  async completeUpload(
    uploadId: string,
    actor: AuthenticatedUser,
  ): Promise<CompleteUploadResult> {
    const inFlight = this.completingUploads.get(uploadId);
    if (inFlight) return inFlight;

    const promise = this.runCompleteUpload(uploadId, actor).finally(() => {
      this.completingUploads.delete(uploadId);
    });
    this.completingUploads.set(uploadId, promise);
    return promise;
  }

  /**
   * Merge chunks -> save original video -> update video status -> start
   * FFmpeg processing. Unless this session has a `relativePath` (the
   * externally-pre-transcoded bundle flow) — then it merges the chunks and
   * uploads the result straight to the key ResourceUploadTypeRegistry maps
   * that relativePath onto (the same routing the presigned and multipart
   * flows use), and stops there: no `Video` row, no transcoding. This is
   * what lets one chunked-upload mechanism serve both flows.
   */
  private async runCompleteUpload(
    uploadId: string,
    actor: AuthenticatedUser,
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

    // The "movie uploaded" moment of the classic flow: the file is whole and
    // its Video row exists. The publish that follows the transcode is a
    // separate SYSTEM row written by ProcessingService.
    const movie = await this.prisma.movie.findUnique({
      where: { id: session.movieId },
      select: { title: true, seriesId: true },
    });
    await this.audit.record({
      action: 'movie.upload',
      actor,
      target: {
        type: 'movie',
        id: session.movieId,
        label: movie?.title ?? null,
      },
      metadata: {
        flow: 'classic',
        uploadId,
        videoId: video.id,
        filename: session.filename,
        fileSize: Number(session.fileSize),
        ...(movie?.seriesId ? { seriesId: movie.seriesId } : {}),
      },
    });

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
      this.bundleKey(movieId, relativePath),
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
          this.bundleKey(movieId, relativePath),
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
   * Single-flight per movie, exactly like completingUploads: a finalize
   * that arrives while another for the same movie is still running joins
   * that run instead of inserting a second Video + subtitle set of its own.
   */
  private readonly finalizingMovies = new Map<
    string,
    Promise<{ videoId: string; status: VideoStatus }>
  >();

  /**
   * Runs automatically once the admin's bundle upload finishes — never runs
   * ffmpeg. The admin uploads one root folder (see parseBundleStructure()
   * for the fixed contract this expects); this derives which renditions and
   * subtitles actually exist from the uploaded relativePaths, re-validates
   * all of it server-side (never trusts the client's last upload-progress
   * state alone), then creates the Video row directly in the READY state
   * using the exact same `hlsMasterKey()` helper and the same key routing
   * the upload itself used — the reason streaming
   * (`GET /videos/:movieId/stream`) needs zero changes to serve this video.
   *
   * The movie itself only ever moves to READY_TO_PUBLISH here (or FAILED if
   * the bundle turns out incomplete) — never PUBLISHED. Publishing is
   * always a separate, explicit admin action (see MoviesService.update()),
   * matching the bulk-upload flow's status lifecycle.
   *
   * State guard (the movie's stage is checked before anything is written):
   *   - UPLOADING / FAILED (FINALIZABLE_MOVIE_STATUSES): the only states a
   *     finalize acts on — FAILED is the admin's retry after a rejected
   *     bundle.
   *   - READY_TO_PUBLISH: already finalized. Replayed idempotently — the
   *     existing READY video is returned, nothing is created and no audit
   *     row is recorded (a client retrying after a timeout gets the same
   *     answer it missed, never a duplicate Video/Subtitle set). 409 if the
   *     movie somehow has no READY video.
   *   - Every other status (PUBLISHED, ARCHIVED, DRAFT, PROCESSING): 409,
   *     no writes — a live or archived title is never unpublished or
   *     failed by an upload endpoint.
   * Parallel calls for the same movie join one in-flight run (see
   * finalizingMovies), and the final status flip is a compare-and-set on
   * the status read at the start, so a status an admin changed mid-run is
   * never overwritten.
   */
  async finalizeExternalUpload(
    movieId: string,
    dto: ValidateExternalBundleDto,
    actor: AuthenticatedUser,
  ): Promise<{ videoId: string; status: VideoStatus }> {
    const inFlight = this.finalizingMovies.get(movieId);
    if (inFlight) return inFlight;

    const promise = this.runFinalizeExternalUpload(movieId, dto, actor).finally(
      () => {
        this.finalizingMovies.delete(movieId);
      },
    );
    this.finalizingMovies.set(movieId, promise);
    return promise;
  }

  private async runFinalizeExternalUpload(
    movieId: string,
    dto: ValidateExternalBundleDto,
    actor: AuthenticatedUser,
  ): Promise<{ videoId: string; status: VideoStatus }> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    if (movie.status === MovieStatus.READY_TO_PUBLISH) {
      const existing = await this.videosService.findLatestForMovie(movieId);
      if (existing?.status === VideoStatus.READY) {
        return { videoId: existing.id, status: VideoStatus.READY };
      }
      throw new ConflictException(
        'This movie is already READY_TO_PUBLISH but has no ready video — contact an administrator',
      );
    }
    if (!FINALIZABLE_MOVIE_STATUSES.includes(movie.status)) {
      throw new ConflictException(
        `Cannot finalize — movie is ${movie.status}; finalize only applies to a bundle upload that is UPLOADING or FAILED`,
      );
    }

    const { originalPath, renditions, subtitlePaths, errors } =
      this.parseBundleStructure(dto.relativePaths);
    // originalPath is null only when `errors` already explains why (see
    // parseBundleStructure) — checking it here rather than asserting it
    // away is what gives the key builder below a real string.
    if (errors.length > 0 || originalPath === null) {
      await this.markMovieFailed(movie, actor, errors);
      throw new BadRequestException(
        `Cannot finalize — invalid bundle structure: ${errors.join('; ')}`,
      );
    }

    const originalKey = this.bundleKey(movieId, originalPath);
    const masterKey = this.storageService.hlsMasterKey(movieId);
    const requiredKeys = [
      originalKey,
      masterKey,
      ...renditions.map(
        (r) =>
          `${this.storageService.hlsRenditionKeyPrefix(movieId, r)}/index.m3u8`,
      ),
      // Subtitle SOURCES do not live beside the video assets: the registry
      // routes them to subtitles/<movieId>/<filename>, so this is where
      // they are checked for too.
      ...subtitlePaths.map((p) => this.bundleKey(movieId, p)),
    ];

    const existence = await Promise.all(
      requiredKeys.map(async (key) => ({
        key,
        exists: await this.minioService.objectExists(key),
      })),
    );
    const missing = existence.filter((e) => !e.exists).map((e) => e.key);
    if (missing.length > 0) {
      await this.markMovieFailed(
        movie,
        actor,
        missing.map((key) => `missing ${key}`),
      );
      throw new BadRequestException(
        `Cannot finalize — missing required files: ${missing.join(', ')}`,
      );
    }

    // The master and every rendition playlist were just verified to exist,
    // so the runtime can be read from the HLS the viewer will actually play
    // (the EXTINF sum of the first variant) — a few KB from MinIO, no ffmpeg.
    // Fail-soft by construction: recover never throws, and null simply
    // leaves Video.duration unknown exactly as this flow always did.
    const durationSeconds =
      await this.videoDurationService.recoverHlsDurationSeconds(masterKey);

    const video = await this.videosService.create({
      movieId,
      originalFilename: originalPath,
      originalPath: originalKey,
    });

    await this.videosService.markReady(video.id, {
      duration: durationSeconds,
      resolution: null,
      hlsMasterPath: masterKey,
      renditions: renditions.map((resolution) => ({
        resolution,
        playlistPath: `${this.storageService.hlsRenditionKeyPrefix(movieId, resolution)}/index.m3u8`,
      })),
    });

    // Conditional (guarded by duration = 0 in the DB predicate): a runtime the
    // browser probe sent at placeholder time, or one an admin typed meanwhile,
    // is never overwritten — human > automatic.
    if (durationSeconds !== null) {
      try {
        await this.videoDurationService.fillMovieDurationIfUnknown(
          movieId,
          durationSeconds,
        );
      } catch (error) {
        // The video is already READY; a runtime is cosmetic and the backfill
        // endpoint can fill it later. Never fail a finalize over it.
        this.logger.warn(
          `Could not fill duration for movie ${movieId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const createdSubtitles: Array<Record<string, unknown>> = [];
    for (const relativePath of subtitlePaths) {
      const filename = basename(relativePath);
      const extension = extname(filename).toLowerCase();
      const stem = filename.slice(0, filename.length - extension.length);
      const code = LANGUAGE_NAME_TO_CODE[stem.toLowerCase()];
      const language = code ?? stem.toLowerCase();
      const label = stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();

      const created = await this.subtitlesService.createFromExistingKey({
        videoId: video.id,
        language,
        label,
        format: EXTENSION_TO_FORMAT[extension],
        objectKey: this.bundleKey(movieId, relativePath),
      });
      createdSubtitles.push({ id: created.id, language, label });
    }

    // Compare-and-set on the status read at the start: if an admin moved
    // the movie elsewhere while this ran (PUT /movies/:id accepts any
    // status), that decision wins and the flip is skipped. The Video is
    // kept either way — it is real, READY and already wired into the
    // shared master playlist, so deleting it would leave the title
    // live-but-unplayable.
    const claim = await this.prisma.movie.updateMany({
      where: { id: movieId, status: movie.status },
      data: { status: MovieStatus.READY_TO_PUBLISH },
    });
    const metadata = {
      flow: 'bulk',
      videoId: video.id,
      renditions,
      subtitles: createdSubtitles,
      durationSeconds,
      ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
    };

    if (claim.count === 0) {
      const current = await this.prisma.movie.findUnique({
        where: { id: movieId },
        select: { status: true },
      });
      this.logger.warn(
        `Movie ${movieId} left ${movie.status} while its bundle was being finalized (now ${
          current?.status ?? 'missing'
        }) — video ${video.id} is READY but the status flip to READY_TO_PUBLISH was skipped`,
      );
      await this.audit.record({
        action: 'movie.upload',
        actor,
        target: { type: 'movie', id: movieId, label: movie.title },
        before: { status: movie.status },
        after: { status: current?.status ?? null },
        metadata: { ...metadata, statusFlipSkipped: true },
      });
      return { videoId: video.id, status: VideoStatus.READY };
    }

    // The "movie uploaded" moment of the bulk flow. Publishing stays a
    // separate, explicit PUT /movies/:id — and its own audit row.
    await this.audit.record({
      action: 'movie.upload',
      actor,
      target: { type: 'movie', id: movieId, label: movie.title },
      before: { status: movie.status },
      after: { status: MovieStatus.READY_TO_PUBLISH },
      metadata,
    });

    return { videoId: video.id, status: VideoStatus.READY };
  }

  /**
   * FAILED is a real lifecycle step the admin sees on the movie, so the
   * rejected finalize is filed as a status change with what was wrong.
   * Compare-and-set on the status the finalize started from (only
   * UPLOADING or FAILED can reach here, see FINALIZABLE_MOVIE_STATUSES) —
   * a movie an admin moved elsewhere meanwhile is left alone and nothing
   * is recorded, since nothing changed.
   */
  private async markMovieFailed(
    movie: { id: string; title: string; status: MovieStatus },
    actor: AuthenticatedUser,
    reasons: string[],
  ): Promise<void> {
    const claim = await this.prisma.movie.updateMany({
      where: { id: movie.id, status: movie.status },
      data: { status: MovieStatus.FAILED },
    });
    if (claim.count === 0) return;

    await this.audit.record({
      action: 'movie.status_change',
      actor,
      target: { type: 'movie', id: movie.id, label: movie.title },
      before: { status: movie.status },
      after: { status: MovieStatus.FAILED },
      metadata: { trigger: 'finalize_failed', flow: 'bulk', reasons },
    });
  }

  /**
   * The fixed folder-structure contract the other PC's output must follow:
   *   original.<ext>, hls/master.m3u8, hls/<resolution>/index.m3u8 (for any
   *   of the known renditions), subtitles/<name>.<srt|vtt|ass> (optional).
   * relativePaths already carry the "hls/" prefix for the master playlist
   * and every rendition — see stripDirectoryRoot()/the admin page, which
   * maps the single selected root folder onto this exact contract; where
   * each path then LANDS is ResourceUploadTypeRegistry's decision, not this
   * function's (a subtitle leaves the videos/ namespace, the rest do not).
   */
  private parseBundleStructure(relativePaths: string[]): BundleStructure {
    const set = new Set(relativePaths);
    const errors: string[] = [];

    // Exactly one original, whatever its container. Two would be ambiguous
    // — both map to videos/<movieId>/original.<ext>, so the Video row would
    // record one while the other sat there unreferenced.
    const originals = relativePaths.filter((p) =>
      ORIGINAL_FILENAME_PATTERN.test(p),
    );
    if (originals.length === 0) {
      errors.push('original.<ext> is missing from the bundle root');
    } else if (originals.length > 1) {
      errors.push(
        `the bundle root has more than one original file (${originals.join(', ')}) — exactly one is expected`,
      );
    }

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
        p.startsWith(SUBTITLE_RELATIVE_PREFIX) &&
        SUBTITLE_EXTENSIONS.has(extname(p).toLowerCase()),
    );

    // A subtitle source is stored under its own FILENAME
    // (subtitles/<movieId>/english.vtt), so two tracks sharing a basename
    // would silently overwrite each other and the second Subtitle row would
    // point at the first one's bytes. Caught here, before a single byte is
    // uploaded, rather than after. Compared case-insensitively: the
    // operator's own filesystem cannot hold both spellings anyway, so a
    // difference in case is a rename accident, not two real tracks.
    const firstSeenAt = new Map<string, string>();
    for (const path of subtitlePaths) {
      const filename = basename(path).toLowerCase();
      const firstPath = firstSeenAt.get(filename);
      if (firstPath === undefined) {
        firstSeenAt.set(filename, path);
        continue;
      }
      errors.push(
        `subtitle filenames must be unique — "${path}" and "${firstPath}" would both be stored as ${filename}`,
      );
    }

    return {
      originalPath: originals.length === 1 ? originals[0] : null,
      renditions,
      subtitlePaths,
      errors,
    };
  }

  /**
   * Uploads a still image straight to the storage server (no local disk
   * involved) and returns its public URL. `purpose` decides which folder
   * under images/ it lands in and is validated by UploadImageDto — there is
   * no default, because an image in the wrong folder is invisible to the
   * prefix-based cleanup paths that are supposed to find it later.
   */
  async saveImage(
    purpose: ImagePurpose,
    originalFilename: string,
    buffer: Buffer,
  ): Promise<string> {
    const extension = extname(originalFilename) || '.jpg';
    const key = this.storageService.imageObjectKey(
      purpose,
      randomUUID(),
      extension,
    );
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
  async reprocessVideo(movieId: string, actor: AuthenticatedUser) {
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

    // Synchronous claim before the first await below: the status check
    // above is a read-then-check that every simultaneous request passes
    // while the set is still empty, so the reservation is what makes
    // exactly one of them start the pipeline (see ProcessingService.reserve).
    if (!this.processingService.reserve(video.id)) {
      throw new ConflictException(
        'This video is actively processing right now — wait for it to finish, or restart the backend first if you believe it is stuck.',
      );
    }

    let inputPath: string;
    try {
      inputPath = await this.resolveOriginalForReprocessing(movieId, video);
    } catch (error) {
      this.processingService.release(video.id);
      throw error;
    }

    // Fire-and-forget, matching the exact same pattern completeUpload() uses
    // to kick off processing after a normal upload.
    void this.processingService.processVideo(video.id, movieId, inputPath);

    // Who restarted the pipeline. Its outcome is recorded by ProcessingService
    // as a system row (transcode_complete / transcode_failed).
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { title: true },
    });
    await this.audit.record({
      action: 'movie.reprocess',
      actor,
      target: { type: 'movie', id: movieId, label: movie?.title ?? null },
      metadata: { videoId: video.id, previousVideoStatus: video.status },
    });

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
