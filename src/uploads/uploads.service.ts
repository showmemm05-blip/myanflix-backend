import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  access,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import {
  MovieStatus,
  UploadStatus,
  VideoStatus,
  type Prisma,
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
import { ImageStoreService } from '../images/image-store.service';
import { TmdbLookupService } from '../tmdb/tmdb-lookup.service';
import {
  SubtitlesService,
  EXTENSION_TO_FORMAT,
} from '../subtitles/subtitles.service';
import {
  DIRECT_UPLOAD_MOVIE_STATUSES,
  MOVIE_REPLACE_RESOURCE_TYPE,
  REPLACEABLE_MOVIE_STATUSES,
  ResourceUploadTypeRegistry,
  SUBTITLE_RELATIVE_PREFIX,
  directUploadRefusalMessage,
} from './resource-upload-type.registry';
import {
  describeBytes,
  maxOpenSessionsPerMovie,
  minFreeDiskBytes,
} from './upload-limits';
import { ABANDONED_SESSION_AGE_MS } from './multipart-upload.service';
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

// The movie states the CLASSIC single-file flow (no relativePath: one
// original, transcoded here by ffmpeg) may start an upload for. A movie
// born through POST /movies is DRAFT until its transcode publishes it, and
// a failed transcode puts it back to DRAFT — so DRAFT is this flow's
// working state the way UPLOADING is the bundle flow's. Anything live
// (PUBLISHED, READY_TO_PUBLISH) or ARCHIVED is refused: a new video for a
// live title goes through the audited replace flow (M-22).
const CLASSIC_UPLOAD_MOVIE_STATUSES: readonly MovieStatus[] = [
  MovieStatus.DRAFT,
  MovieStatus.UPLOADING,
  MovieStatus.FAILED,
];

// The image byte caps and their coded errors moved to ImageStoreService with
// the image code itself (the TMDB module stores pictures through it too).
// Re-exported so the controller and every existing importer keep their path.
export {
  FRAME_IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_TOO_LARGE_CODE,
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_CODE,
  IMAGE_UPLOAD_UNSUPPORTED_TYPE_MESSAGE,
  imageUploadByteLimit,
  imageUploadTooLargeMessage,
} from '../images/image-store.service';

/** The exact byte length chunk `chunkNumber` of a session must have: the chunk size, or the remainder for the last one. */
export function expectedChunkSize(
  session: {
    fileSize: bigint | number;
    chunkSize: number;
    totalChunks: number;
  },
  chunkNumber: number,
): number {
  if (chunkNumber < session.totalChunks - 1) return session.chunkSize;
  return (
    Number(session.fileSize) - (session.totalChunks - 1) * session.chunkSize
  );
}

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

/** The 201 body of POST /uploads/:movieId/finalize-replace. */
export interface FinalizeReplaceResult {
  videoId: string;
  status: VideoStatus;
  renditions: string[];
  subtitles: number;
  durationSeconds: number | null;
  copiedObjects: number;
  deletedObjects: number;
}

// How many staged objects are copied to their final keys at once during a
// replace. A rendition can be ~900 segments; each copy is a server-side
// CopyObject (no bytes through this process), so this bounds MinIO's
// concurrent work rather than our memory.
const REPLACE_COPY_CONCURRENCY = 8;

// The bundle folder that holds the HLS package (master, <tier>/ folders).
// On a replace everything under it is re-rooted into the versioned package
// folder — see replaceDestinationKey; the original and subtitles/ are not.
const HLS_RELATIVE_PREFIX = 'hls/';

// The master is the one file a player fetches FIRST and the cache server
// re-fetches after 10 s; it is copied strictly after everything else so a
// player can only ever see a master whose every referenced file already
// exists — see runFinalizeReplace step 4.
const MASTER_RELATIVE_PATH = `${HLS_RELATIVE_PREFIX}master.m3u8`;

// Bytes of randomness behind a replace's package tag (hex-encoded: 8 chars,
// 2^32 values). A tag only has to differ from the handful of packages one
// title has ever had, so a collision with a still-live folder — which would
// merely fall back to overwriting keys in place, never to data loss — is
// not a case worth a lookup.
const HLS_VERSION_TAG_BYTES = 4;

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
    private readonly imageStore: ImageStoreService,
    private readonly tmdbLookup: TmdbLookupService,
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
   *
   * `actor` is the staff member on the request: a bundle-file session is
   * recorded under their name the moment it opens (M-22), the same way
   * MultipartUploadService.initMultipart records its sessions.
   */
  async initUpload(actor: AuthenticatedUser, dto: InitUploadDto) {
    const movie = await this.prisma.movie.findUnique({
      where: { id: dto.movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');

    // State gate (M-22): a bundle file (relativePath) lands on the title's
    // live keys, so only a placeholder still being filled may take one; the
    // classic flow additionally accepts the DRAFT a fresh movie is born in.
    const allowedStatuses = dto.relativePath
      ? DIRECT_UPLOAD_MOVIE_STATUSES
      : CLASSIC_UPLOAD_MOVIE_STATUSES;
    if (!allowedStatuses.includes(movie.status)) {
      throw new ConflictException(directUploadRefusalMessage(movie.status));
    }
    // Size budget (M-23): the same ceiling the presigned and multipart
    // routes apply, so no flow is the one without a limit.
    this.resourceTypes.assertFileSizeAllowed(
      MOVIE_RESOURCE_TYPE,
      dto.filesize,
      dto.relativePath ?? dto.filename,
    );

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

    // One login opening sessions by the hundred is the only way to get past
    // the per-write disk checks' intent (each session would still be
    // refused chunk by chunk, but the rows and folders pile up) — a movie
    // never legitimately has more than a few open at once (M-23).
    await this.assertOpenSessionCapNotReached(dto.movieId);

    // The chunks and the merged file both land on THIS host's disk (the one
    // Postgres shares) and are on it TOGETHER at the merge (the chunks are
    // only deleted afterwards), so the session's peak is twice the file. A
    // session the disk could not hold at that peak is refused before its
    // first chunk rather than failing with ENOSPC halfway (M-23). This is
    // the room at THIS moment; saveChunk and the merge check again, so
    // sessions opened side by side cannot overdraw it between them.
    await this.assertScratchDiskHasRoom(2 * dto.filesize);

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

    // A bundle file lands on the title's live keys with no further staff
    // step until finalize, so the session itself is the act worth a row —
    // one per file, never per chunk (M-22). The classic flow's row is
    // movie.upload at complete, where its Video row is born.
    if (dto.relativePath) {
      await this.audit.record({
        action: 'movie.upload_chunked',
        actor,
        target: { type: 'movie', id: dto.movieId, label: movie.title },
        metadata: {
          uploadId: session.id,
          relativePath: dto.relativePath,
          key: this.bundleKey(dto.movieId, dto.relativePath),
          fileSize: dto.filesize,
          totalChunks,
          ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
        },
      });
    }

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

    // Every chunk is exactly chunkSize long except the last, which is the
    // remainder — so the bytes on disk can never add up to more than the
    // filesize the session was opened for (M-23). The admin slices the file
    // with the chunkSize initUpload() returned, so a real client always
    // matches; only a tampered or buggy request does not.
    const expected = expectedChunkSize(session, chunkNumber);
    if (buffer.length !== expected) {
      throw new BadRequestException(
        `Chunk ${chunkNumber} is ${buffer.length} bytes — expected exactly ${expected}`,
      );
    }

    // The room initUpload saw is not reserved: every other open session
    // (and ffmpeg, and Postgres) has been writing to the same disk since.
    // One statfs per chunk keeps every write above the reserve, so N
    // sessions that each passed init cannot fill the disk between them —
    // the write that would is refused with 507 instead (M-23).
    await this.assertScratchDiskHasRoom(buffer.length);

    // Written under a temporary name and renamed into place only once the
    // write has finished. A crash, restart or I/O error mid-write leaves a
    // `chunk_<n>.<id>.part`, which listUploadedChunks() ignores
    // ("<n>.<id>.part" is not a number), so a resume re-sends that chunk
    // instead of trusting a short file. The rename is atomic on one
    // filesystem. The temporary name is unique per request: two overlapping
    // requests for the same chunk (a retry after a timeout while the first
    // is still writing) each write and rename their own file, and the last
    // rename simply replaces the first — the same bytes, no ENOENT.
    const finalPath = this.storageService.chunkPath(uploadId, chunkNumber);
    const partPath = `${finalPath}.${randomUUID()}.part`;
    try {
      await writeFile(partPath, buffer);
      await rename(partPath, finalPath);
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 507 when the scratch disk could not take `bytes` more and still keep
   * UPLOAD_MIN_FREE_DISK_BYTES spare. Measured at STORAGE_PATH, the volume
   * every chunk and merged file is written to, at the moment of the call —
   * which is why it runs before every write that matters (init for the
   * session's peak, each chunk, the merge), not once. Fail-open when the
   * space cannot be read at all (a missing directory on a fresh checkout,
   * an unsupported filesystem): that is a logged oddity, not a reason to
   * block every upload — the ENOSPC such a write would hit is the same one
   * it always hit.
   */
  private async assertScratchDiskHasRoom(bytes: number): Promise<void> {
    let free: number;
    try {
      const stats = await statfs(this.storageService.root);
      free = Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      this.logger.warn(
        `Could not read the free space under ${this.storageService.root}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const reserve = minFreeDiskBytes();
    if (free < bytes + reserve) {
      throw new HttpException(
        `Not enough free disk space on the server to write ${bytes} more bytes (${free} bytes free, ${describeBytes(reserve)} must stay spare) — contact an administrator`,
        HttpStatus.INSUFFICIENT_STORAGE,
      );
    }
  }

  /**
   * 409 when `movieId` already has UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE
   * chunked sessions open. Only sessions younger than the abandoned-session
   * window count: an older IN_PROGRESS row is one whose chunks the cleanup
   * sweep has (or will have) removed, and it never resumes.
   */
  private async assertOpenSessionCapNotReached(movieId: string): Promise<void> {
    const cap = maxOpenSessionsPerMovie();
    const open = await this.prisma.uploadSession.count({
      where: {
        movieId,
        status: UploadStatus.IN_PROGRESS,
        createdAt: { gte: new Date(Date.now() - ABANDONED_SESSION_AGE_MS) },
      },
    });
    if (open >= cap) {
      throw new ConflictException(
        `This movie already has ${open} uploads in progress (the limit is ${cap}) — finish or wait for them before starting another`,
      );
    }
  }

  /**
   * The chunk files a completed `writeFile` + rename in `saveChunk` already
   * leaves on disk ARE the record of what's been received — no separate bookkeeping
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

    // The state gate again, at the moment the bytes would actually land
    // (M-22): a session lives up to 48 h, and the title can have been
    // finalized or published since init. A late complete would otherwise
    // write onto live keys (bundle) or start a transcode over a live
    // package (classic). Such a session is dead — its chunks go too.
    const movie = await this.prisma.movie.findUnique({
      where: { id: session.movieId },
      select: { title: true, seriesId: true, status: true },
    });
    const allowedStatuses = session.relativePath
      ? DIRECT_UPLOAD_MOVIE_STATUSES
      : CLASSIC_UPLOAD_MOVIE_STATUSES;
    if (!movie || !allowedStatuses.includes(movie.status)) {
      await this.prisma.uploadSession.update({
        where: { id: uploadId },
        data: { status: UploadStatus.FAILED },
      });
      await this.cleanupChunks(uploadId);
      if (!movie) throw new NotFoundException('Movie not found');
      throw new ConflictException(directUploadRefusalMessage(movie.status));
    }

    // The merge writes a second copy of the whole file next to the chunks
    // (they are removed only afterwards) — refuse it while that copy would
    // eat into the reserve, instead of letting ENOSPC do it (M-23).
    await this.assertScratchDiskHasRoom(Number(session.fileSize));

    if (session.relativePath) {
      return this.completeExternalAssetUpload(
        uploadId,
        session.movieId,
        session.relativePath,
        session.totalChunks,
        session.fileSize,
      );
    }

    // The title's previous file can still be transcoding in this process:
    // the classic gate admits DRAFT, and a movie stays DRAFT for the whole
    // of its transcode (only the Video row reads PROCESSING). A second
    // complete now would merge onto the very scratch file ffmpeg is
    // reading and — the prefix clear below — pull the package out from
    // under that run. 409 before the merge; the session stays resumable.
    const latest = await this.videosService.findLatestForMovie(session.movieId);
    if (latest && this.processingService.isActivelyProcessing(latest.id)) {
      throw new ConflictException(
        'This movie is still being transcoded — wait for it to finish before completing a new upload',
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
    await this.assertMergedSize(uploadId, originalPath, session.fileSize);

    // A fresh file for this title. Whatever an earlier attempt left under
    // videos/<movieId>/ — an archived original, finished renditions, a
    // replaced hls/v-<tag>/ package — goes first: the pipeline resumes per
    // tier on object existence, so it would otherwise keep the OLD file's
    // tiers next to the new file's (a mixed package) or skip the new file
    // altogether (STR-003). Reprocess never comes through here; it re-feeds
    // the same original and relies on exactly that resume. Runs before
    // anything durable changes, so a storage error leaves the session
    // resumable and a retried complete simply repeats it.
    await this.minioService.deleteByPrefix(
      `${this.storageService.videoKeyPrefix(session.movieId)}/`,
    );

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
    await this.audit.record({
      action: 'movie.upload',
      actor,
      target: {
        type: 'movie',
        id: session.movieId,
        label: movie.title,
      },
      metadata: {
        flow: 'classic',
        uploadId,
        videoId: video.id,
        filename: session.filename,
        fileSize: Number(session.fileSize),
        ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
      },
    });

    // Kick off transcoding without blocking the HTTP response. The pipeline
    // records its own failures; the catch is the belt-and-braces for
    // anything that still escapes it, because an unhandled rejection here
    // would take the whole API process down (STR-009).
    void this.processingService
      .processVideo(video.id, session.movieId, originalPath)
      .catch((error: unknown) =>
        this.logger.error(
          `Transcode of video ${video.id} (movie ${session.movieId}) escaped the pipeline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

    return { videoId: video.id, status: video.status };
  }

  private async completeExternalAssetUpload(
    uploadId: string,
    movieId: string,
    relativePath: string,
    totalChunks: number,
    fileSize: bigint | number,
  ): Promise<{ relativePath: string; status: UploadStatus }> {
    const tempPath = join(
      this.storageService.uploadSessionDir(uploadId),
      'merged',
    );
    await this.mergeChunks(uploadId, totalChunks, tempPath);
    await this.assertMergedSize(uploadId, tempPath, fileSize);

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

      // { publish: false }: the master is rebuilt ONCE below, with every
      // track, instead of once per track.
      const created = await this.subtitlesService.createFromExistingKey(
        {
          videoId: video.id,
          language,
          label,
          format: EXTENSION_TO_FORMAT[extension],
          objectKey: this.bundleKey(movieId, relativePath),
        },
        { publish: false },
      );
      createdSubtitles.push({ id: created.id, language, label });
    }
    // Errors are logged and swallowed inside, exactly as the per-track
    // publish always did.
    if (subtitlePaths.length > 0) {
      await this.subtitlesService.publishQuietly(video.id);
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

    // The upload is finished and recorded. Only now, and only on this branch
    // (not on a replay, not when the status flip was skipped), are the
    // film's details looked up on TMDB — in the background.
    this.startTmdbLookup(movieId, actor);

    return { videoId: video.id, status: VideoStatus.READY };
  }

  /**
   * Starts the TMDB lookup of a movie whose folder upload just finished
   * (docs/movie-details-tmdb-2026-11-06/PLAN.md 2.12) and returns at once.
   * Deliberately NOT awaited: the upload's answer never waits for TMDB, and
   * nothing TMDB does — down, slow, a wrong key, a bug in the lookup — can
   * fail or change an upload that has already succeeded. The lookup decides
   * by itself whether there is anything to do (it does nothing for an
   * episode, while TMDB_API_KEY is missing, or for a movie that is already
   * linked) and its promise never rejects; the catch below and the try
   * around it are only the last line behind that promise.
   */
  private startTmdbLookup(movieId: string, actor: AuthenticatedUser): void {
    const logFailure = (error: unknown) =>
      this.logger.error(
        `The TMDB lookup of movie ${movieId} could not be started`,
        error instanceof Error ? error.stack : String(error),
      );
    try {
      void this.tmdbLookup.afterUpload(movieId, actor).catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  }

  // ---------------------------------------------------------------------
  // REPLACE — a new transcoder bundle for a title that already has a video.
  //
  // Three routes, deliberately separate from finalize:
  // finalize's status guard ("a live title is never unpublished or failed
  // from here") and its single-flight stay untouched, and a "replace" flag
  // on finalize would have had to bypass that very guard. The invariants
  // every method below keeps:
  //   - the Movie row and Movie.status are NEVER written;
  //   - the old Video row keeps serving /videos/:movieId/stream until the
  //     swap (the new bundle stages under temp/video-replace/<movieId>/, a
  //     prefix the cache server denies and nothing can sign);
  //   - a failure BEFORE the swap leaves MinIO's final keys and the DB
  //     untouched and cleans the staging;
  //   - the new HLS package lands in a FRESH folder,
  //     videos/<movieId>/hls/v-<tag>/, never over the old keys: every cache
  //     server keeps a segment for 7 days by full path, so a bundle written
  //     over the old keys played the NEW playlist with OLD cached segments
  //     wherever the transcoder reused a segment name. A fresh folder is
  //     what makes the title play the new bundle the moment the swap ends,
  //     and what lets the stale-delete remove the whole previous package.
  //     The original and the subtitle sources keep their un-versioned keys:
  //     the original is never served, and a source is cached for 10 s only;
  //   - watch history / resume positions are keyed by movieId and are not
  //     touched — it is the same title.
  // ---------------------------------------------------------------------

  /** `temp/video-replace/<movieId>/` — with the trailing slash a prefix listing/delete needs. */
  private stagingPrefix(movieId: string): string {
    return `${this.storageService.videoReplaceStagingPrefix(movieId)}/`;
  }

  private stagingKey(movieId: string, relativePath: string): string {
    return this.storageService.videoReplaceStagingKey(movieId, relativePath);
  }

  private assertReplaceable(movie: { status: MovieStatus }): void {
    if (!REPLACEABLE_MOVIE_STATUSES.includes(movie.status)) {
      throw new ConflictException(
        `Cannot replace the video of a ${movie.status} movie — only a PUBLISHED, READY_TO_PUBLISH or FAILED title can have its video replaced`,
      );
    }
  }

  private assertNotActivelyProcessing(video: { id: string } | null): void {
    if (video && this.processingService.isActivelyProcessing(video.id)) {
      throw new ConflictException(
        'This video is being transcoded right now — wait for it to finish before replacing it',
      );
    }
  }

  /**
   * Opens a replace: confirms the movie may be replaced and hands the admin
   * the resourceType + staging prefix its presign-batch / multipart uploads
   * will use. The one side effect is clearing the staging prefix, so a file
   * left by an earlier aborted attempt can never satisfy the validation of
   * this one. Nothing durable changes (no Movie/Video write, no status
   * change), so nothing is audited — the audit row belongs to the swap.
   */
  async beginReplace(
    movieId: string,
    actor: AuthenticatedUser,
  ): Promise<{
    movieId: string;
    resourceType: string;
    stagingPrefix: string;
  }> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { id: true, status: true, title: true, seriesId: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    this.assertReplaceable(movie);
    this.assertNotActivelyProcessing(
      await this.videosService.findLatestForMovie(movieId),
    );

    const stagingPrefix = this.stagingPrefix(movieId);
    await this.minioService.deleteByPrefix(stagingPrefix);
    this.logger.log(
      `Video replace opened for movie ${movieId} (${movie.status}) — staging ${stagingPrefix}`,
    );
    // Who opened a replace on which title — the one trace of an attempt
    // that is later abandoned instead of swapped (M-22).
    await this.audit.record({
      action: 'movie.video_replace_begin',
      actor,
      target: { type: 'movie', id: movieId, label: movie.title },
      metadata: {
        flow: 'replace',
        movieStatus: movie.status,
        stagingPrefix,
        ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
      },
    });
    return {
      movieId,
      resourceType: MOVIE_REPLACE_RESOURCE_TYPE,
      stagingPrefix,
    };
  }

  /**
   * Best-effort abandon — the admin calls it when the operator removes the
   * folder or closes the dialog mid-upload. Only the staging goes; the
   * title's real files were never touched.
   */
  async cancelReplace(
    movieId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { id: true, title: true, seriesId: true },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    const stagingPrefix = this.stagingPrefix(movieId);
    await this.minioService.deleteByPrefix(stagingPrefix);
    await this.audit.record({
      action: 'movie.video_replace_cancel',
      actor,
      target: { type: 'movie', id: movieId, label: movie.title },
      metadata: {
        flow: 'replace',
        stagingPrefix,
        ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
      },
    });
  }

  /** Single-flight per movie, exactly like finalizingMovies. */
  private readonly replacingMovies = new Map<
    string,
    Promise<FinalizeReplaceResult>
  >();

  /**
   * Swaps a fully-staged replacement bundle in for the title's current
   * video. Validates the staged files (same structure + existence checks as
   * finalize, against the STAGING keys), copies them to their final keys —
   * the HLS package into a fresh videos/<movieId>/hls/v-<tag>/ folder —
   * with the master last, rewrites the Video row in place, only then
   * deletes whatever old object the new bundle does not carry (which is the
   * whole previous package), and recreates its Subtitle rows exactly as
   * finalize creates them. Parallel calls for one movie join a single run.
   */
  async finalizeReplace(
    movieId: string,
    dto: ValidateExternalBundleDto,
    actor: AuthenticatedUser,
  ): Promise<FinalizeReplaceResult> {
    const inFlight = this.replacingMovies.get(movieId);
    if (inFlight) return inFlight;

    const promise = this.runFinalizeReplace(movieId, dto, actor).finally(() => {
      this.replacingMovies.delete(movieId);
    });
    this.replacingMovies.set(movieId, promise);
    return promise;
  }

  private async runFinalizeReplace(
    movieId: string,
    dto: ValidateExternalBundleDto,
    actor: AuthenticatedUser,
  ): Promise<FinalizeReplaceResult> {
    // 0. Gate. The movie's status is read once and never written.
    const movie = await this.prisma.movie.findUnique({
      where: { id: movieId },
    });
    if (!movie) throw new NotFoundException('Movie not found');
    this.assertReplaceable(movie);
    const video = await this.videosService.findLatestForMovie(movieId);
    this.assertNotActivelyProcessing(video);

    const stagingPrefix = this.stagingPrefix(movieId);

    // 1. Structure. A rejected bundle costs nothing but its staging.
    const { originalPath, renditions, subtitlePaths, errors } =
      this.parseBundleStructure(dto.relativePaths);
    if (errors.length > 0 || originalPath === null) {
      await this.minioService.deleteByPrefix(stagingPrefix);
      throw new BadRequestException(
        `Cannot replace — invalid bundle structure: ${errors.join('; ')}`,
      );
    }

    // 2. Every file must actually be STAGED — the required ones AND every
    // segment the client listed. The client's own upload bookkeeping is
    // never trusted, same as finalize; and checking the segments here, not
    // in the copy, is what keeps step 4 from starting a swap it cannot
    // finish (a missing segment used to surface as a copy failure halfway,
    // the one path that leaves old and new files mixed). ONE listing of the
    // staging prefix (one request per 1,000 keys) answers "is it there" for
    // every file and carries each size for the copy in step 4 — instead of
    // a HEAD per file here and another inside every copy.
    const toCheck = Array.from(
      new Set([
        originalPath,
        MASTER_RELATIVE_PATH,
        ...renditions.map((r) => `hls/${r}/index.m3u8`),
        ...subtitlePaths,
        ...dto.relativePaths,
      ]),
    );
    const stagedSizes = new Map<string, number | undefined>();
    for (const object of await this.minioService.listObjects(stagingPrefix)) {
      stagedSizes.set(object.key, object.size);
    }
    const missing = toCheck
      .filter(
        (relativePath) =>
          !stagedSizes.has(this.stagingKey(movieId, relativePath)),
      )
      .sort();
    if (missing.length > 0) {
      await this.minioService.deleteByPrefix(stagingPrefix);
      throw new BadRequestException(
        `Cannot replace — missing staged files: ${missing.join(', ')}`,
      );
    }

    // 3. Snapshot before anything is written: the title's current keys (so
    // step 7 can delete exactly the stale ones) and the rows for the audit.
    const videoPrefix = `${this.storageService.videoKeyPrefix(movieId)}/`;
    const subtitlePrefix = `${this.storageService.subtitleSourcePrefix(movieId)}/`;
    const oldKeys = new Set<string>([
      ...(await this.minioService.listKeys(videoPrefix)),
      ...(await this.minioService.listKeys(subtitlePrefix)),
    ]);
    const oldSubtitles = video
      ? await this.prisma.subtitle.findMany({
          where: { videoId: video.id },
          select: {
            id: true,
            language: true,
            label: true,
            format: true,
            objectKey: true,
            isDefault: true,
          },
        })
      : [];
    const before = {
      video: video
        ? {
            id: video.id,
            status: video.status,
            originalFilename: video.originalFilename,
            originalPath: video.originalPath,
            hlsMasterPath: video.hlsMasterPath,
            renditions: video.renditions,
            duration: video.duration,
            resolution: video.resolution,
            failureReason: video.failureReason,
          }
        : null,
      subtitles: oldSubtitles,
      movieDuration: movie.duration,
    };

    // 4. Copy staged -> final. The HLS package (hls/**) goes into a FRESH
    // videos/<movieId>/hls/v-<tag>/ folder — see replaceDestinationKey for
    // why it can never go over the old keys — while the original and the
    // subtitle sources take the SAME key the "movie" registry entry gives a
    // fresh upload (subtitles leave videos/ for subtitles/<movieId>/). The
    // old package is untouched until step 6 points the row at the new one,
    // so the title keeps playing throughout; the master goes last so a
    // player can only see a master whose every referenced file already
    // exists. This is the ONE step that can leave a partial state — see the
    // catch (a retry mints a new tag, and the half-written folder is swept
    // as stale by the retry's own step 7, being none of ITS final keys).
    const versionTag = this.hlsVersionTag();
    const newFinalKeys = new Set<string>();
    let copiedObjects = 0;
    const copyOne = async (relativePath: string) => {
      const destination = this.replaceDestinationKey(
        movieId,
        relativePath,
        versionTag,
      );
      const sourceKey = this.stagingKey(movieId, relativePath);
      try {
        // The size from step 2's listing saves copyObject its own HEAD; a
        // listing without a size (never expected) falls back to that HEAD.
        await this.minioService.copyObject(
          sourceKey,
          destination,
          stagedSizes.get(sourceKey),
        );
      } catch (error) {
        throw new ReplaceCopyError(destination, error);
      }
      newFinalKeys.add(destination);
      copiedObjects++;
    };
    try {
      // Phases are awaited one after another: a pool over one sorted list
      // only TENDS to keep the order, and a rendition playlist landing before
      // the segments it names would hand a viewer mid-playback a 404.
      for (const phase of this.swapPhases(dto.relativePaths)) {
        await runPool(phase, REPLACE_COPY_CONCURRENCY, copyOne);
      }
      await copyOne(MASTER_RELATIVE_PATH);
    } catch (error) {
      const failedKey =
        error instanceof ReplaceCopyError ? error.key : '(unknown)';
      const message =
        error instanceof ReplaceCopyError
          ? error.causeMessage
          : error instanceof Error
            ? error.message
            : String(error);
      // Nothing the viewer can reach has changed: the new package lives in
      // its own hls/v-<tag>/ folder, so the OLD package is intact and the
      // Video row still points at it — the title keeps playing and no
      // status is touched (marking it FAILED here would be a self-inflicted
      // outage). What is left is a half-written v-<tag>/ folder nobody
      // references; it is swept so an abandoned attempt leaves no orphan.
      // The staging is KEPT so a retried finalize-replace re-runs the copy
      // into a fresh folder. The original and subtitle SOURCES phase 1 may
      // already have overwritten in place are the new bundle's: they feed
      // re-processing and the subtitle rows, never playback.
      const failureReason = `replace interrupted during copy at ${failedKey}: ${message}`;
      const halfWrittenPackage = `${this.storageService.hlsPackagePrefix(movieId, versionTag)}/`;
      try {
        await this.minioService.deleteByPrefix(halfWrittenPackage);
      } catch (sweepError) {
        this.logger.warn(
          `Could not sweep the half-written package ${halfWrittenPackage}: ${sweepError instanceof Error ? sweepError.message : String(sweepError)}`,
        );
      }
      this.logger.error(
        `Video replace for movie ${movieId} interrupted after ${copiedObjects} object(s): ${failureReason}`,
      );
      await this.audit.record({
        action: 'movie.video_replace',
        actor,
        target: { type: 'movie', id: movieId, label: movie.title },
        before,
        metadata: {
          flow: 'replace',
          outcome: 'interrupted',
          failedKey,
          copiedObjects,
          stagingPrefix,
          ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
        },
      });
      throw new BadGatewayException(failureReason);
    }

    // 5. Runtime from the HLS now at the FINAL (versioned) master key. Never
    // throws.
    const masterKey = this.storageService.hlsMasterKey(movieId, versionTag);
    const durationSeconds =
      await this.videoDurationService.recoverHlsDurationSeconds(masterKey);

    // 6. The Video row, rewritten IN PLACE so its id (the subtitles' FK,
    // SubtitleManager's videoId) stays stable and "latest row = served row"
    // keeps holding; created only when the title never had one. The old
    // Subtitle rows go in the same transaction. hlsMasterPath and every
    // playlistPath point into the versioned package — this row is the only
    // record of which package is live (playback, diagnosis and the subtitle
    // publisher all read the paths from here, never rebuild them).
    const originalKey = this.bundleKey(movieId, originalPath);
    const videoData = {
      status: VideoStatus.READY,
      originalFilename: basename(originalPath),
      originalPath: originalKey,
      hlsMasterPath: masterKey,
      renditions: renditions.map((resolution) => ({
        resolution,
        playlistPath: `${this.storageService.hlsRenditionKeyPrefix(movieId, resolution, versionTag)}/index.m3u8`,
      })) as unknown as Prisma.InputJsonValue,
      resolution: null,
      duration: durationSeconds,
      failureReason: null,
    };
    const savedVideo = await this.prisma.$transaction(async (tx) => {
      const row = video
        ? await tx.video.update({ where: { id: video.id }, data: videoData })
        : await tx.video.create({ data: { movieId, ...videoData } });
      await tx.subtitle.deleteMany({ where: { videoId: row.id } });
      return row;
    });

    // 7. Delete what the new bundle does not carry: the WHOLE previous HLS
    // package (its master, every rendition, its subs/* renditions — none of
    // those keys is reused, because the new package sits in its own v-<tag>
    // folder; a second replace sweeps the previous v-<tag> folder the same
    // way), the old original when its extension changed, and every old
    // subtitle SOURCE the bundle does not re-supply (bundle-uploaded and
    // single-uploaded alike — the rows are replaced below the same way).
    // Strictly AFTER step 6: the row now points at the new package, so a
    // viewer asking for /stream from here on gets the new master. Deleting
    // first left the title pointing at missing keys for the length of the
    // delete batches — and until an admin retried, if the process died in
    // between (STR-002). A failure here is a storage leak, not a broken
    // title: logged, counted, and the swap goes on.
    const staleKeys = [...oldKeys].filter((key) => !newFinalKeys.has(key));
    let deletedObjects = 0;
    try {
      await this.minioService.deleteKeys(staleKeys);
      deletedObjects = staleKeys.length;
    } catch (error) {
      this.logger.warn(
        `Video replace for movie ${movieId}: could not delete ${staleKeys.length} stale object(s) — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // 8. New Subtitle rows, derived exactly as finalize derives them. Once
    // they all exist, ONE publish rewrites the (new) master with the
    // subtitle group, writing the renditions BESIDE it — videos/<id>/hls/v-<tag>/subs/<newId>.{vtt,
    // m3u8} — because HlsSubtitlesService derives their keys from the row's
    // hlsMasterPath just written in step 6, and the master names them by
    // the relative URI `subs/<id>.m3u8`.
    const createdSubtitles: Array<{
      id: string;
      language: string;
      label: string;
    }> = [];
    for (const relativePath of subtitlePaths) {
      const filename = basename(relativePath);
      const extension = extname(filename).toLowerCase();
      const stem = filename.slice(0, filename.length - extension.length);
      const code = LANGUAGE_NAME_TO_CODE[stem.toLowerCase()];
      const language = code ?? stem.toLowerCase();
      const label = stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();

      const created = await this.subtitlesService.createFromExistingKey(
        {
          videoId: savedVideo.id,
          language,
          label,
          format: EXTENSION_TO_FORMAT[extension],
          objectKey: this.bundleKey(movieId, relativePath),
        },
        { publish: false },
      );
      createdSubtitles.push({ id: created.id, language, label });
    }
    // One publish with the complete set, so the live master is never
    // rewritten with a partial subtitle list. Errors are swallowed inside.
    if (subtitlePaths.length > 0) {
      await this.subtitlesService.publishQuietly(savedVideo.id);
    }

    // 9. Movie.duration, guarded by `duration = 0` in the predicate exactly
    // like finalize/backfill — a human-entered runtime is never overwritten.
    // The seconds are returned so the admin can show them either way.
    if (durationSeconds !== null) {
      try {
        await this.videoDurationService.fillMovieDurationIfUnknown(
          movieId,
          durationSeconds,
        );
      } catch (error) {
        this.logger.warn(
          `Could not fill duration for movie ${movieId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // 10. Staging is spent. Best-effort: the cleanup sweep catches leftovers.
    try {
      await this.minioService.deleteByPrefix(stagingPrefix);
    } catch (error) {
      this.logger.warn(
        `Video replace for movie ${movieId}: staging ${stagingPrefix} not cleared — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // 11. One audit row for the swap. No realtime emit: RealtimeGateway has
    // no movie/video event.
    const current = await this.prisma.movie.findUnique({
      where: { id: movieId },
      select: { duration: true },
    });
    await this.audit.record({
      action: 'movie.video_replace',
      actor,
      target: { type: 'movie', id: movieId, label: movie.title },
      before,
      after: {
        video: {
          id: savedVideo.id,
          status: VideoStatus.READY,
          originalFilename: videoData.originalFilename,
          originalPath: originalKey,
          hlsMasterPath: masterKey,
          renditions: videoData.renditions,
          duration: durationSeconds,
          resolution: null,
          failureReason: null,
        },
        subtitles: createdSubtitles,
        movieDuration: current?.duration ?? movie.duration,
      },
      metadata: {
        flow: 'replace',
        outcome: 'replaced',
        renditions,
        subtitles: createdSubtitles,
        durationSeconds,
        copiedObjects,
        deletedObjects,
        stagingPrefix,
        hlsPackagePrefix: this.storageService.hlsPackagePrefix(
          movieId,
          versionTag,
        ),
        ...(movie.seriesId ? { seriesId: movie.seriesId } : {}),
      },
    });

    this.logger.log(
      `Video replaced for movie ${movieId} into hls/v-${versionTag}: ${copiedObjects} object(s) copied, ${deletedObjects} stale object(s) deleted, ${createdSubtitles.length} subtitle track(s)`,
    );

    return {
      videoId: savedVideo.id,
      status: VideoStatus.READY,
      renditions,
      subtitles: createdSubtitles.length,
      durationSeconds,
      copiedObjects,
      deletedObjects,
    };
  }

  /**
   * The copy phases of step 4, master excluded (it is copied on its own
   * afterwards). Each phase is fully written before the next starts, so a
   * playlist can only ever name files that already exist at their final
   * keys:
   *   1. segments, subtitle sources, the original — nothing points at them
   *      yet, so they can land in any order;
   *   2. the rendition playlists (hls/<r>/index.m3u8), which name phase 1;
   *   and then the master, which names phase 2, strictly last.
   */
  private swapPhases(relativePaths: string[]): string[][] {
    const isRenditionPlaylist = (path: string) =>
      path.startsWith(HLS_RELATIVE_PREFIX) && path.endsWith('/index.m3u8');
    const rest = relativePaths.filter((path) => path !== MASTER_RELATIVE_PATH);
    return [
      rest.filter((path) => !isRenditionPlaylist(path)),
      rest.filter(isRenditionPlaylist),
    ].filter((phase) => phase.length > 0);
  }

  /** Deletes a replace's `hls/v-<tag>/` package when `hlsMasterPath` points into one; a no-op for the un-versioned layout. */
  private async sweepVersionedPackage(
    hlsMasterPath: string | null,
  ): Promise<void> {
    if (!hlsMasterPath || !hlsMasterPath.includes('/hls/v-')) return;
    const prefix = hlsMasterPath.slice(0, hlsMasterPath.lastIndexOf('/') + 1);
    try {
      await this.minioService.deleteByPrefix(prefix);
    } catch (error) {
      this.logger.warn(
        `Could not sweep the replaced package ${prefix} before reprocessing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The tag naming one replace's package folder, minted ONCE per
   * finalize-replace: 8 lowercase hex characters from the CSPRNG. An
   * instance method rather than a free function so a test can pin it.
   */
  private hlsVersionTag(): string {
    return randomBytes(HLS_VERSION_TAG_BYTES).toString('hex');
  }

  /**
   * The final key one staged bundle file is copied to during a replace.
   *
   * hls/** is re-rooted into videos/<movieId>/hls/v-<tag>/** instead of
   * the videos/<movieId>/hls/** a first upload uses. Every cache server
   * keeps a segment for 7 days BY FULL PATH and a transcoder names segments
   * the same way every run (720p/segment_000.ts ...), so a bundle copied
   * over the old keys was served as the new playlist with week-old cached
   * segments; a folder no one has ever fetched from has nothing cached.
   * The same package shape sits one level deeper, so the master's relative
   * URIs, the videos/<movieId>/hls signing scope and the cache server's
   * rules all hold unchanged.
   *
   * Everything else — the original and the subtitle sources — keeps the
   * registry key a fresh upload would get: the original is never served
   * through the cache, and a subtitle source is cached for 10 s only.
   */
  private replaceDestinationKey(
    movieId: string,
    relativePath: string,
    versionTag: string,
  ): string {
    if (!relativePath.startsWith(HLS_RELATIVE_PREFIX)) {
      return this.bundleKey(movieId, relativePath);
    }
    return `${this.storageService.hlsPackagePrefix(movieId, versionTag)}/${relativePath.slice(HLS_RELATIVE_PREFIX.length)}`;
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
   * POST /uploads/image: checks, resizes and stores one staff-uploaded image
   * and returns its public URL. The work itself lives in ImageStoreService
   * (byte cap, magic-byte check, artwork resize, the image.upload audit
   * row) so a picture fetched from TMDB goes through exactly the same code;
   * a staff upload passes no options and is stored as it always was.
   */
  saveImage(
    purpose: ImagePurpose,
    originalFilename: string,
    buffer: Buffer,
    actor: AuthenticatedUser,
  ): Promise<string> {
    return this.imageStore.save(purpose, originalFilename, buffer, actor);
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
    } else if (video.status === VideoStatus.READY) {
      // A READY row whose master playlist is gone from the store is
      // functionally FAILED — /stream would hand out a link to nothing —
      // and the playback diagnosis suggests exactly this action for it.
      // One HEAD, evaluated only for a READY video, so a genuinely playable
      // title still gets the 400 below rather than a surprise transcode.
      const masterPresent =
        video.hlsMasterPath !== null &&
        (await this.minioService.objectExists(video.hlsMasterPath));
      if (masterPresent) {
        throw new BadRequestException(
          'Only a failed or stuck video can be reprocessed',
        );
      }
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

    // A replace leaves the live package in its own hls/v-<tag>/ folder,
    // while ProcessingService always writes the un-versioned hls/ package
    // (its per-tier resume depends on those fixed keys). Sweep the versioned
    // folder first, or it would outlive the row that pointed at it. Best
    // effort: a sweep failure is a storage leak, not a reason to refuse the
    // repair the admin asked for.
    await this.sweepVersionedPackage(video.hlsMasterPath);

    // Fire-and-forget, matching the exact same pattern completeUpload() uses
    // to kick off processing after a normal upload — catch included, so an
    // escaped rejection is a log line, never a dead process (STR-009).
    void this.processingService
      .processVideo(video.id, movieId, inputPath)
      .catch((error: unknown) =>
        this.logger.error(
          `Transcode of video ${video.id} (movie ${movieId}) escaped the pipeline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );

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
   * failure happened before/at archiving — ProcessingService keeps that
   * only copy on purpose, see its cleanupScratch, STR-004) or already a
   * MinIO object key (archiving succeeded; a later rendition or ffmpeg step
   * is what failed) — in which case it needs to be pulled back down before
   * ffmpeg can read it again.
   */
  private async resolveOriginalForReprocessing(
    movieId: string,
    video: { originalPath: string; originalFilename: string },
  ): Promise<string> {
    if (await this.pathExistsLocally(video.originalPath)) {
      return video.originalPath;
    }

    // A kept local original is swept after 24 h; the row then names a path
    // that is gone and was never a key the store could answer for — a
    // clear 400, not downloadFile's NoSuchKey 500. Scratch paths are
    // absolute (StorageService.root), object keys never are.
    if (isAbsolute(video.originalPath)) {
      throw new BadRequestException(
        'The original file is no longer on the server — a new upload is required',
      );
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
        chunkStream.on('error', (error) => {
          // Release the destination's file handle too — otherwise a missing
          // or unreadable chunk left it open until garbage collection.
          output.destroy();
          rejectPromise(error);
        });
        chunkStream.on('end', () => appendChunk(index + 1));
        chunkStream.pipe(output, { end: false });
      };

      appendChunk(0);
    });
  }

  /**
   * The merged file must be exactly the size the session was opened for
   * before it is uploaded or transcoded. Every chunk was length-checked on
   * arrival, so a mismatch means a chunk file changed on disk afterwards
   * (a truncated file from a crash, disk trouble) — refuse it clearly
   * instead of shipping a corrupt original. Resuming cannot fix it (every
   * chunk already counts as received), so the session is closed as FAILED
   * and its files removed; the admin starts the upload again.
   */
  private async assertMergedSize(
    uploadId: string,
    path: string,
    expected: bigint | number,
  ): Promise<void> {
    const { size } = await stat(path);
    if (size === Number(expected)) return;

    await rm(path, { force: true }).catch(() => undefined);
    await this.prisma.uploadSession.update({
      where: { id: uploadId },
      data: { status: UploadStatus.FAILED },
    });
    await this.cleanupChunks(uploadId);
    throw new BadRequestException(
      `The joined file is ${size} bytes but the upload was opened for ${Number(expected)} bytes — a piece of it was damaged on the server. Start this upload again.`,
    );
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

/** A copy that failed mid-swap, carrying the FINAL key it was writing. */
class ReplaceCopyError extends Error {
  readonly causeMessage: string;
  constructor(
    readonly key: string,
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`copy to ${key} failed: ${causeMessage}`);
    this.name = 'ReplaceCopyError';
    this.causeMessage = causeMessage;
  }
}

/**
 * Runs `work` over `items` with at most `concurrency` in flight — the same
 * shape as MinioService.uploadDirectory's worker pool. The first failure
 * rejects the whole pool; workers already past their `next++` finish their
 * current item, nothing new starts.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        await work(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}
