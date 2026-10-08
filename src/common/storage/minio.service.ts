import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OWN_KEY_PREFIXES } from './media-taxonomy';
import { requestHostContext } from './request-host.context';
import { quantizedExpiry, scopeForKey, signScope } from './stream-signature';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NoSuchKey,
  NotFound,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

// Multipart tuning for streamed file uploads. Memory held per upload is
// roughly UPLOAD_PART_SIZE * UPLOAD_QUEUE_SIZE (~32 MB), regardless of how
// large the file itself is — that bound is the whole point of streaming.
const UPLOAD_PART_SIZE = 8 * 1024 * 1024; // S3's minimum part size is 5 MB
const UPLOAD_QUEUE_SIZE = 4; // parts uploaded concurrently within one file

// Ceiling on how many files upload at once in uploadDirectory(). An HLS
// rendition can be ~900 segments for a feature-length movie; uploading them
// all concurrently is what previously spiked memory on the backend VPS.
const DIRECTORY_UPLOAD_CONCURRENCY = 4;

// Lifetime of a signed playback link when STREAM_URL_TTL_SECONDS is unset:
// 4 hours (M-21) — longer than any one sitting, short enough that a link
// pasted into a chat group dies the same afternoon; the players already
// fetch a fresh link on 410. Mirrors the default in config/env.validation.ts.
const DEFAULT_STREAM_URL_TTL_SECONDS = 14_400;

// Without these, the AWS SDK's default HTTP handler has no timeout at all —
// a stalled connection to MinIO (a dropped packet, a brief network blip)
// hangs the request forever instead of failing and retrying. A multipart
// upload's individual part requests are at most UPLOAD_PART_SIZE, so
// REQUEST_TIMEOUT_MS only has to cover one part, not the whole file —
// generous even on a slow connection without masking a genuinely stalled one.
const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

// Only needs to cover "issue -> that part/file's PUT lands," not an entire
// upload's lifetime — URLs are handed out just-in-time (see
// MultipartUploadService's sliding-window part issuance), so this is
// generous even on a slow connection with several retries, not a ceiling on
// how long an upload as a whole can take.
const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 60;

// readText() exists for playlists and subtitle sources — a few KB, a few
// hundred KB at the outside. 16 MB is far above any real one and far below
// what would hurt the API container if a staff upload put something huge at
// a key the finalize path reads whole (M-24).
export const READ_TEXT_MAX_BYTES = 16 * 1024 * 1024;

// Backstop beneath the application-level cleanup cron (see
// UploadCleanupService) — if that cron is ever down or buggy, MinIO itself
// still reclaims an abandoned multipart upload's part storage on its own.
const ABANDONED_MULTIPART_LIFECYCLE_DAYS = 7;

// The S3 API caps a single CopyObject at 5 GiB; a larger source (a big
// archived original) has to be streamed through this process instead — see
// copyObject().
const SINGLE_COPY_MAX_BYTES = 5 * 1024 * 1024 * 1024;

// DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH_SIZE = 1000;

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  // Original (pre-transcode) uploads — archived as-is, not served to viewers.
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  // Poster/cover images.
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // Subtitle files.
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.ass': 'text/x-ssa',
  // Book originals — archived under documents/books/, converted page-by-page
  // to the WebPs that are actually served.
  '.pdf': 'application/pdf',
};

/**
 * Talks to the storage server (MinIO, or any S3-compatible endpoint) —
 * entirely configured through env vars, so pointing this at a real VPS
 * instead of the local Docker MinIO is a config change, not a code change.
 */
@Injectable()
export class MinioService {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: S3Client;
  /**
   * A second client used ONLY for signing presigned URLs handed to the
   * browser (direct-to-MinIO uploads — see MultipartUploadService). Signing
   * binds the URL's signature to whatever endpoint this client is
   * configured with; `client` above is configured with MINIO_ENDPOINT, the
   * backend's own internal/Docker-network address, which the browser can't
   * reach and which wouldn't validate once the request actually arrives via
   * the public write-side proxy anyway. MINIO_PUBLIC_ENDPOINT is that
   * proxy's public address — falls back to MINIO_ENDPOINT so local dev
   * (no proxy in front of MinIO) keeps working with one env var.
   */
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  /**
   * Whether STREAM_PUBLIC_BASE_URL names a real, reachable cache address.
   *
   * Off (the default), playbackUrl() derives the host from the request — the
   * right call on a dev machine that hops networks, where any configured host
   * goes stale on the next hop. On a split deployment that assumption breaks:
   * the API and the cache server live on different hosts, so the host a client
   * used to reach the API is precisely the one place the streams are NOT.
   * Setting this to true makes the configured base authoritative.
   */
  private readonly streamBaseIsPublic: boolean;
  /**
   * Shared with the cache server's nginx (STREAM_SIGNING_SECRET on both
   * sides) — signedPlaybackUrl() mints the path token secure_link verifies.
   * Env validation refuses to boot without one; the `?? ''` only keeps unit
   * specs that mock ConfigService constructing the service.
   */
  private readonly streamSigningSecret: string;
  /** How long a signed playback link stays valid (STREAM_URL_TTL_SECONDS). */
  private readonly streamUrlTtlSeconds: number;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('MINIO_BUCKET') ?? 'movies';
    this.streamBaseIsPublic =
      String(
        this.configService.get<string>('STREAM_PUBLIC_BASE_URL_IS_PUBLIC') ??
          '',
      ).toLowerCase() === 'true';
    this.streamSigningSecret =
      this.configService.get<string>('STREAM_SIGNING_SECRET') ?? '';
    const ttl = Number(this.configService.get('STREAM_URL_TTL_SECONDS'));
    this.streamUrlTtlSeconds =
      Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_STREAM_URL_TTL_SECONDS;
    const credentials = {
      accessKeyId: this.configService.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretAccessKey: this.configService.get<string>('MINIO_SECRET_KEY') ?? '',
    };
    this.client = new S3Client({
      endpoint: this.configService.get<string>('MINIO_ENDPOINT'),
      region: 'us-east-1', // required by the SDK; ignored by MinIO
      credentials,
      // MinIO (and the cache server proxying to it) expect /<bucket>/<key>
      // paths, not <bucket>.<host> virtual-hosted addressing.
      forcePathStyle: true,
      // Newer AWS SDK v3 versions default to attaching a flexible-checksum
      // header to write requests, which MinIO rejects outright with
      // "NotImplemented" (confirmed for real against local MinIO). This
      // fixes it for ordinary object operations (PutObject/UploadPart/
      // multipart) — matching what every write against MinIO already
      // worked fine without before the SDK's default changed. It does NOT
      // fix a small set of bucket-config "safety" operations
      // (PutBucketCors, PutBucketLifecycleConfiguration) whose middleware
      // marks a checksum as unconditionally required regardless of this
      // setting — see ensureLifecycle()'s doc comment for how those are
      // handled instead.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      }),
      maxAttempts: MAX_ATTEMPTS,
    });
    this.presignClient = new S3Client({
      endpoint:
        this.configService.get<string>('MINIO_PUBLIC_ENDPOINT') ??
        this.configService.get<string>('MINIO_ENDPOINT'),
      region: 'us-east-1',
      credentials,
      forcePathStyle: true,
      // Presigning embeds whatever checksum behavior the client is
      // configured for into the signed request — must match `client`
      // above, or a browser PUT built from this URL would carry a checksum
      // scheme MinIO rejects the same way.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Playback URL for an object key — points at the cache server, never at
   * MinIO directly, so end users always go through the caching layer (and
   * so the storage server's own uplink isn't what's serving every viewer).
   */
  publicUrl(objectKey: string): string {
    const base = this.configService.get<string>('STREAM_PUBLIC_BASE_URL') ?? '';
    return `${base.replace(/\/$/, '')}/${this.bucket}/${objectKey}`;
  }

  /**
   * Playback URL built from the hostname the CURRENT request used to reach
   * the API, keeping only the cache server's protocol/port from
   * STREAM_PUBLIC_BASE_URL. The host machine hops between networks, so a
   * hard-coded LAN IP goes stale on every hop — while the host the client
   * is already talking to is correct by construction (localhost stays
   * localhost, a phone's LAN IP stays that LAN IP). Falls back to
   * publicUrl() outside a request context. Only for per-response playback
   * fields — PERSISTED urls (saveImage) must keep using publicUrl(), or a
   * request-specific host would be baked into the database.
   */
  playbackUrl(objectKey: string): string {
    return `${this.playbackBase()}/${this.bucket}/${objectKey}`;
  }

  /**
   * Playback URL carrying the cache server's access token in its PATH:
   *
   *   <base>/s/<expires>/<signature>/<bucket>/<objectKey>
   *
   * Same host rules as playbackUrl(); what differs is that the cache server
   * refuses the request unless the token checks out (nginx secure_link, see
   * cacheserver/nginx/templates/default.conf.template) or has expired. The
   * token signs the key's SCOPE — `videos/<id>/hls`, a chapter's `pages`,
   * a subtitle's folder — not the object, so the relative URIs inside a
   * playlist (`720p/index.m3u8`, `segment_007.ts`) resolve to URLs the same
   * token covers and the player needs nothing beyond the master URL. The
   * expiry is hour-quantised (see quantizedExpiry) so a client refetching
   * the stream mid-session gets the identical URL back. Throws
   * StreamKeyNotSignable for a key outside every scope — images stay on
   * playbackUrl()/imageUrl(), originals and PDFs are never handed out.
   */
  signedPlaybackUrl(objectKey: string): string {
    return `${this.playbackBase()}${this.signedPlaybackPath(objectKey)}`;
  }

  /**
   * The PATH half of signedPlaybackUrl() — `/s/<expires>/<signature>/
   * <bucket>/<objectKey>` — with no origin in front of it. Exists for the
   * playback diagnosis, which fetches the exact token a client would receive
   * but through the backend's own route to the cache server
   * (STREAM_INTERNAL_BASE_URL) rather than the request-derived host, which
   * inside a container is the container itself. Same StreamKeyNotSignable
   * rule as the full URL.
   */
  signedPlaybackPath(objectKey: string): string {
    const scope = scopeForKey(objectKey);
    const expires = quantizedExpiry(
      Math.floor(Date.now() / 1000),
      this.streamUrlTtlSeconds,
    );
    const signature = signScope(scope, expires, this.streamSigningSecret);
    return `/s/${expires}/${signature}/${this.bucket}/${objectKey}`;
  }

  /**
   * The `<protocol>://<host>:<port>` this request's playback URLs hang off
   * (see playbackBase()). Public only so a server-side probe can report the
   * origin a client would be sent to; persisted URLs must keep using
   * publicUrl().
   */
  playbackBaseUrl(): string {
    return this.playbackBase();
  }

  /**
   * `<protocol>://<host>:<port>` every playback URL hangs off — no trailing
   * slash. Host resolution, in order: the configured base verbatim when it
   * is marked public, else the current request's hostname with the base's
   * protocol/port, else the configured base (outside any request).
   */
  private playbackBase(): string {
    const base = (
      this.configService.get<string>('STREAM_PUBLIC_BASE_URL') ?? ''
    ).replace(/\/$/, '');
    // A deployment whose cache server has an address of its own — a separate
    // VPS, a CDN hostname — sets STREAM_PUBLIC_BASE_URL_IS_PUBLIC=true, and
    // the configured base is then used verbatim. Deriving the host would
    // point every stream at whichever host serves the API, which on a split
    // deployment is the one machine with no cache server on it.
    if (this.streamBaseIsPublic) return base;

    const ctx = requestHostContext.getStore();
    if (!ctx?.hostname) return base;

    let protocol = 'http';
    let port = '8080';
    try {
      const parsed = new URL(base);
      protocol = parsed.protocol.replace(/:$/, '') || protocol;
      if (parsed.port) port = parsed.port;
    } catch {
      // Malformed/absent env base — keep the defaults above.
    }
    return `${protocol}://${ctx.hostname}:${port}`;
  }

  /**
   * Read-time repair for a PERSISTED image URL (poster/cover/thumbnail/
   * logo). Unlike playback URLs — which are derived per request from an
   * object key and never stored — image URLs were baked into the database
   * as absolute URLs by saveImage(), carrying whatever host the machine
   * happened to have at upload time. Every network hop silently broke every
   * one of them: the bytes are fine, only the hostname went stale.
   *
   * So the host is discarded and re-derived here, at read time, exactly the
   * way streams already do it: recover the object key from the stored URL
   * (keyFromPublicUrl only looks at the bucket path segment, so a
   * stale-host URL resolves just as well as a fresh one) and rebuild it via
   * playbackUrl(). A URL that isn't one of ours — tmdb, picsum, anything
   * external — has no key to recover and is passed through untouched.
   *
   * Strictly a derivation: nothing is written back, saveImage() keeps
   * persisting publicUrl(), and the stored value stays exactly as it was.
   */
  imageUrl(url: string | null | undefined): string | null {
    // `?? null` normalizes undefined; an empty string is left as-is rather
    // than turned into null, so a response field's shape never changes.
    if (!url) return url ?? null;
    const key = this.ownImageKey(url);
    if (!key) return url;
    return this.playbackUrl(key);
  }

  /**
   * The canonical form to PERSIST — the same object addressed by the
   * configured public base rather than by whichever host happened to ask.
   *
   * Reads re-host image URLs per request, and a client that echoes a fetched
   * record straight back on save (the admin does exactly this when you edit a
   * series without touching its artwork) would otherwise write that one
   * request's host into the database. Normalising on the way in makes writes
   * idempotent: the row keeps a stable address no matter who saved it.
   */
  canonicalImageUrl<T extends string | null | undefined>(url: T): T {
    if (!url) return url;
    const key = this.ownImageKey(url);
    return (key ? this.publicUrl(key) : url) as T;
  }

  /**
   * The key IF this URL addresses an object of ours, else null.
   *
   * keyFromPublicUrl() ignores the host on purpose — that host-blindness is
   * what lets a URL baked with a long-dead LAN IP still be repaired. The cost
   * is that it would also claim `https://some-cdn.com/movies/poster.jpg`
   * purely because its first path segment matches the bucket name, and rewrite
   * it to a MinIO object that does not exist. Requiring one of our own key
   * prefixes closes that hole while keeping stale hosts repairable.
   */
  private ownImageKey(url: string): string | null {
    const key = this.keyFromPublicUrl(url);
    if (!key) return null;
    return OWN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
      ? key
      : null;
  }

  /**
   * Uploads a single local file to `key`, creating/configuring the bucket
   * first if needed. Streams from disk rather than reading the file into
   * memory — fs.readFile() cannot read anything larger than 2 GiB at all
   * (a hard Node limit, independent of available RAM), which movie files
   * routinely exceed. Multipart also means a dropped part retries on its
   * own instead of failing the whole multi-GB transfer.
   */
  async uploadFile(key: string, localFilePath: string): Promise<void> {
    await this.ensureBucket();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localFilePath),
        ContentType: this.contentTypeFor(extname(localFilePath)),
      },
      partSize: UPLOAD_PART_SIZE,
      queueSize: UPLOAD_QUEUE_SIZE,
    });
    await upload.done();
  }

  /** Uploads in-memory bytes straight to `key` — no local disk involved at all (e.g. poster/cover images from multer's memory storage). */
  async uploadBuffer(key: string, buffer: Buffer): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: this.contentTypeFor(extname(key)),
      }),
    );
  }

  /**
   * Reads a small text object fully into memory — playlists and subtitle
   * files only. downloadFile() streams to disk because it exists for
   * multi-GB originals; a master.m3u8 that has to be read, rewritten and
   * written back is a few hundred bytes, and a local temp file for it would
   * be pure ceremony.
   */
  async readText(
    key: string,
    maxBytes: number = READ_TEXT_MAX_BYTES,
  ): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`Object "${key}" has no body`);
    // A playlist or subtitle source is kilobytes; anything near the cap is
    // not one. Refused BEFORE the body is buffered, so a staff-uploaded
    // multi-hundred-MB "subtitle" can never be pulled whole into memory.
    if (
      typeof response.ContentLength === 'number' &&
      response.ContentLength > maxBytes
    ) {
      (response.Body as Readable).destroy();
      throw new Error(
        `Object "${key}" is ${response.ContentLength} bytes — larger than the ${maxBytes}-byte limit for a text object`,
      );
    }
    return response.Body.transformToString('utf-8');
  }

  /**
   * A private object as a Node stream, for the API to pipe to an authorised
   * caller (bank screenshots — a class the cache server must never serve).
   * Streams rather than buffers so a multi-megabyte PNG never sits whole in
   * memory per request. `null` when the key does not exist, so the route
   * can answer 404 instead of leaking an S3 error shape.
   */
  async getObjectStream(key: string): Promise<{
    stream: Readable;
    contentType: string;
    contentLength: number | null;
  } | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      return {
        stream: response.Body as Readable,
        contentType: response.ContentType ?? this.contentTypeForKey(key),
        contentLength: response.ContentLength ?? null,
      };
    } catch (error) {
      if (error instanceof NoSuchKey || error instanceof NotFound) return null;
      throw error;
    }
  }

  /**
   * The first `length` bytes of an object. Ranged deliberately: the callers
   * that need this are probing the head of a multi-megabyte media segment for
   * a few bytes of header, and pulling the whole object to read them would
   * cost megabytes per call. A shorter object simply returns in full.
   */
  async readBytes(key: string, length: number): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${Math.max(0, length - 1)}`,
      }),
    );
    if (!response.Body) throw new Error(`Object "${key}" has no body`);
    return Buffer.from(await response.Body.transformToByteArray());
  }

  private contentTypeFor(extension: string): string {
    return CONTENT_TYPES[extension] ?? 'application/octet-stream';
  }

  /** Public wrapper so callers building a key (e.g. the presign-batch endpoint) can infer its content type without duplicating CONTENT_TYPES. */
  contentTypeForKey(key: string): string {
    return this.contentTypeFor(extname(key));
  }

  /**
   * A presigned URL for a single direct PUT — used for files below the
   * multipart threshold (HLS playlists, subtitles, segments). No server-side
   * state is created; the browser either lands the object or it doesn't.
   */
  async getPresignedPutUrl(
    key: string,
    contentLength?: number,
  ): Promise<string> {
    await this.ensureBucket();
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: this.contentTypeForKey(key),
        // Signed into the URL (X-Amz-SignedHeaders gains content-length), so
        // MinIO refuses a PUT whose body is not exactly this long: the size
        // the staff browser declared is the size that can land (M-23).
        ...(contentLength !== undefined
          ? { ContentLength: contentLength }
          : {}),
      }),
      { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS },
    );
  }

  /** Starts a real S3/MinIO multipart upload for `key` and returns its UploadId. */
  async createMultipartUpload(key: string): Promise<string> {
    await this.ensureBucket();
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: this.contentTypeForKey(key),
      }),
    );
    if (!result.UploadId)
      throw new Error(`MinIO did not return an UploadId for "${key}"`);
    return result.UploadId;
  }

  /** A presigned URL for one part of an in-progress multipart upload. */
  async getPresignedUploadPartUrl(
    key: string,
    minioUploadId: string,
    partNumber: number,
    contentLength?: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: minioUploadId,
        PartNumber: partNumber,
        // Same signed-length rule as getPresignedPutUrl: one part can only
        // ever be as long as the session's part size says (M-23).
        ...(contentLength !== undefined
          ? { ContentLength: contentLength }
          : {}),
      }),
      { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS },
    );
  }

  /**
   * The parts MinIO has actually, durably received for this multipart
   * upload — the sole source of truth for resume (see
   * MultipartUploadSession's doc comment in schema.prisma). Never cached or
   * mirrored into Postgres; always queried fresh.
   */
  async listUploadedParts(
    key: string,
    minioUploadId: string,
  ): Promise<{ partNumber: number; etag: string; size: number }[]> {
    const parts: { partNumber: number; etag: string; size: number }[] = [];
    let partNumberMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: minioUploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber == null || !part.ETag || part.Size == null)
          continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }
      partNumberMarker = page.IsTruncated
        ? page.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker);
    return parts;
  }

  /** Finalizes a multipart upload — MinIO assembles the object server-side from parts already in the bucket, no local temp file involved. */
  async completeMultipartUpload(
    key: string,
    minioUploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: minioUploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  /** Best-effort — an upload that's already gone (completed, previously aborted, or lifecycle-expired) is the expected outcome for a cleanup sweep, not a failure. */
  async abortMultipartUpload(
    key: string,
    minioUploadId: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: minioUploadId,
        }),
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (!name.includes('NoSuchUpload')) throw error;
    }
  }

  /** Every multipart upload MinIO currently has open for this bucket — used by the cleanup cron's reverse sweep to catch sessions whose DB row was never written (e.g. a crash between CreateMultipartUploadCommand and the Prisma insert). */
  async listInProgressMultipartUploads(): Promise<
    { key: string; uploadId: string; initiated: Date | undefined }[]
  > {
    const uploads: {
      key: string;
      uploadId: string;
      initiated: Date | undefined;
    }[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        uploads.push({
          key: upload.Key,
          uploadId: upload.UploadId,
          initiated: upload.Initiated,
        });
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return uploads;
  }

  /** One HEAD on `key`: its metadata, or null when the object does not exist. */
  private async headObject(
    key: string,
  ): Promise<HeadObjectCommandOutput | null> {
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  /** Whether `key` already exists — lets a reprocess/retry skip re-uploading bytes that are already archived. */
  async objectExists(key: string): Promise<boolean> {
    return (await this.headObject(key)) !== null;
  }

  /**
   * Size in bytes of `key`, or null when it doesn't exist OR the HEAD
   * carries no Content-Length — used to record a book PDF's size after its
   * browser-direct upload lands. (Kept exactly as it always behaved;
   * objectStat below reports a missing length as 0 instead.)
   */
  async objectSize(key: string): Promise<number | null> {
    const head = await this.headObject(key);
    return head?.ContentLength ?? null;
  }

  /**
   * Size and ETag of `key` from one HEAD, or null when it doesn't exist.
   * The ETag is what lets the book conversion tell "the same PDF again"
   * from "a new file at the same key" BEFORE it downloads anything (M-9) —
   * downloadFile() returns the same value, so the two can be compared.
   */
  async objectStat(
    key: string,
  ): Promise<{ size: number; etag: string | null } | null> {
    const head = await this.headObject(key);
    if (!head) return null;
    return {
      size: head.ContentLength ?? 0,
      etag: head.ETag?.replace(/"/g, '') || null,
    };
  }

  /** Deletes a single object — a no-op (not an error) if it's already gone, matching S3-compatible delete semantics. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Deletes every object under `prefix` — e.g. a movie's whole
   * `videos/<movieId>/` tree (the archived original plus every generated
   * rendition, playlist and published subtitle) when the movie is deleted.
   *
   * ONE call is not a whole entity: the taxonomy splits sources from
   * generated output, so an entity's storage spans a FIXED, deterministic
   * set of prefixes and the caller must sweep all of them. A movie is
   * `videos/<movieId>/` AND `subtitles/<movieId>/` (its uploaded subtitle
   * source files, which no longer live under the video prefix); a book is
   * `books/<bookId>/` AND `documents/books/<bookId>/`. MoviesService,
   * SeriesService and BooksService each issue the matching pair — dropping
   * one of them is a silent storage leak, not a failure.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  /**
   * Every object key under `prefix`, with its last-modified stamp and size
   * in bytes — the listing half of deleteByPrefix(), paginated the same way
   * (one request per 1,000 keys). Used by the video-replace swap to snapshot
   * a title's current keys before anything is written and to check (and
   * size) every staged file in one walk instead of a HEAD per file, and by
   * the cleanup sweep to age abandoned staging objects.
   */
  async listObjects(prefix: string): Promise<
    {
      key: string;
      lastModified: Date | undefined;
      size: number | undefined;
    }[]
  > {
    const objects: {
      key: string;
      lastModified: Date | undefined;
      size: number | undefined;
    }[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        objects.push({
          key: object.Key,
          lastModified: object.LastModified,
          size: object.Size,
        });
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return objects;
  }

  /** Just the keys under `prefix` — see listObjects(). */
  async listKeys(prefix: string): Promise<string[]> {
    return (await this.listObjects(prefix)).map((object) => object.key);
  }

  /**
   * Deletes an explicit list of keys in DeleteObjects batches — the
   * counterpart to deleteByPrefix() for callers that already decided WHICH
   * objects go (the swap keeps every key the new bundle carries and removes
   * only the stale rest, which a prefix delete cannot express). A key that is
   * already gone is not an error, matching S3 delete semantics.
   */
  async deleteKeys(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  /**
   * Server-side copy of one object to another key in the same bucket — no
   * bytes pass through this process for anything under the S3 single-copy
   * cap (5 GiB). A larger source (a big archived original) is streamed
   * GetObject -> multipart Upload instead: slower, but bounded memory, like
   * uploadFile(). The content type is re-derived from the DESTINATION key so
   * a staged file lands with the same type a direct upload would have given
   * it. Throws when the source does not exist — the swap must never
   * "succeed" by copying nothing.
   *
   * `knownSize` is the source's size when the caller already has it (the
   * replace swap reads every staged size from one listing) — it skips the
   * HEAD this would otherwise send first. A source that vanished since
   * still fails: the CopyObject / GetObject itself answers 404.
   */
  async copyObject(
    sourceKey: string,
    destinationKey: string,
    knownSize?: number,
  ): Promise<void> {
    const size = knownSize ?? (await this.objectSize(sourceKey));
    if (size === null) {
      throw new Error(`Object "${sourceKey}" does not exist`);
    }

    if (size < SINGLE_COPY_MAX_BYTES) {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          // The SDK contract: `<bucket>/<key>`, URL-encoded per path segment.
          CopySource: `${this.bucket}/${sourceKey
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
          Key: destinationKey,
          ContentType: this.contentTypeForKey(destinationKey),
          MetadataDirective: 'REPLACE',
        }),
      );
      return;
    }

    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: sourceKey }),
    );
    if (!response.Body) throw new Error(`Object "${sourceKey}" has no body`);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: destinationKey,
        Body: response.Body as Readable,
        ContentType: this.contentTypeForKey(destinationKey),
      },
      partSize: UPLOAD_PART_SIZE,
      queueSize: UPLOAD_QUEUE_SIZE,
    });
    await upload.done();
  }

  /** Inverse of publicUrl() — recovers the object key from a URL this service previously produced, or null if it doesn't look like one of ours (e.g. a stale external URL). */
  keyFromPublicUrl(url: string): string | null {
    try {
      const { pathname } = new URL(url);
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] !== this.bucket) return null;
      return parts.slice(1).join('/');
    } catch {
      return null;
    }
  }

  /**
   * Downloads `key` to `localFilePath`, streaming straight to disk — the
   * download-side counterpart to uploadFile()'s streamed upload, so pulling
   * a multi-GB archived original back down for reprocessing never buffers
   * the whole thing in memory either.
   *
   * Returns the ETag (quotes stripped) of the bytes that were actually
   * downloaded — the same response, so it cannot describe a different
   * version than the file on disk. The book conversion uses it to tell a
   * retry of the same PDF from a re-upload at the same key. Null only when
   * the server sends none.
   */
  async downloadFile(
    key: string,
    localFilePath: string,
  ): Promise<{ etag: string | null }> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body as Readable;
    await pipeline(body, createWriteStream(localFilePath));
    return { etag: response.ETag?.replace(/"/g, '') || null };
  }

  /** Uploads every file in `localDir` (non-recursive — HLS rendition dirs are flat) under `keyPrefix`. */
  async uploadDirectory(localDir: string, keyPrefix: string): Promise<void> {
    const entries = await readdir(localDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());

    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= files.length) return;
        const { name } = files[index];
        await this.uploadFile(`${keyPrefix}/${name}`, join(localDir, name));
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(DIRECTORY_UPLOAD_CONCURRENCY, files.length) },
        worker,
      ),
    );
  }

  /**
   * The bucket check runs once per process and is shared by every caller.
   * A FAILED check is not remembered: the cached promise is dropped on
   * rejection, so the next upload retries instead of every upload failing
   * until the API restarts (a storage hiccup right after a deploy used to
   * break uploads for good).
   */
  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.initializeBucket().catch((error: unknown) => {
        this.bucketReady = null;
        throw error;
      });
    }
    return this.bucketReady;
  }

  private async initializeBucket(): Promise<void> {
    await this.createBucketIfMissing();
    // Idempotent — safe to re-attempt every process start. Best-effort: a
    // failure here must never block the bucket itself from being usable,
    // since this is a defense-in-depth backstop, not a correctness
    // requirement (see its own doc comment).
    await this.ensureLifecycle();
  }

  /**
   * CORS for direct browser->MinIO PUTs is NOT configured here — confirmed
   * empirically against a real MinIO instance that `PutBucketCorsCommand`
   * is unusable against MinIO at all: the AWS SDK v3 bakes
   * `requestChecksumRequired: true` into this command's own middleware
   * (unconditionally, not affected by `requestChecksumCalculation` client
   * config), and MinIO rejects the resulting checksum header/query param
   * with a hard `501 NotImplemented` regardless of how the request is
   * constructed (tried both a direct `.send()` and a presigned-URL +
   * manual `fetch()` with a byte-identical body — same rejection either
   * way, since MinIO 501s on seeing the checksum param at all).
   *
   * CORS is configured instead via MinIO's own server-level
   * `MINIO_API_CORS_ALLOW_ORIGIN` env var (see
   * storage-server/docker-compose.yml) — no S3 API call involved at all,
   * so this SDK/MinIO incompatibility never comes up. Confirmed working
   * directly against a live MinIO instance: its default CORS handling
   * already exposes `ETag` (among other headers) to the browser, which is
   * exactly what completing a multipart upload needs to read back from
   * each part's PUT response.
   */

  /**
   * Backstop for abandoned direct-to-MinIO multipart uploads beneath the
   * application-level cleanup cron (UploadCleanupService) — if that cron is
   * ever down, buggy, or simply hasn't run yet, MinIO reclaims the
   * in-progress parts' storage on its own after this many days regardless.
   *
   * Best-effort, deliberately not awaited-and-thrown: `PutBucketLifecycleConfigurationCommand`
   * has the exact same `requestChecksumRequired: true` incompatibility with
   * MinIO as `PutBucketCorsCommand` (confirmed via the same investigation —
   * see the comment above). Unlike CORS, there's no equivalent MinIO
   * server-level env var for lifecycle rules, so this is left as a
   * best-effort attempt that logs a warning and moves on rather than
   * failing bucket initialization — UploadCleanupService's cron is the
   * actual required cleanup mechanism; this was only ever meant to be a
   * backstop beneath it.
   */
  private async ensureLifecycle(): Promise<void> {
    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart-uploads',
                Status: 'Enabled',
                Filter: {},
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: ABANDONED_MULTIPART_LIFECYCLE_DAYS,
                },
              },
            ],
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Could not configure the bucket lifecycle rule (non-fatal — UploadCleanupService's cron remains the primary cleanup mechanism): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      // Only a real "no such bucket" falls through to CreateBucket. Anything
      // else (MinIO unreachable, a timeout, 403) is rethrown as itself
      // rather than masked by a CreateBucket error, and ensureBucket() then
      // lets the next call retry.
      if (!isBucketMissing(error)) throw error;
    }

    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));

    // No bucket policy is set here any more. The bucket used to be made
    // world-readable at creation, which meant every object — HLS, archived
    // originals, subtitle sources, book pages and PDFs — was fetchable by
    // key from MinIO's own port and through the cache server, no matter
    // what the /stream endpoint had decided. Reads are now gated by the
    // cache server's signed path token (signedPlaybackUrl), and the only
    // anonymous read MinIO should allow is the one FROM the cache server's
    // address: that policy is ops state, applied with `mc anonymous
    // set-json` from storage-server/policies/ — see storage-server/README.md.
    this.logger.log(
      `Created bucket "${this.bucket}" (no anonymous policy — see storage-server/policies/)`,
    );
  }
}

/** Whether a HeadBucket error means the bucket does not exist (404 / NotFound / NoSuchBucket). */
function isBucketMissing(error: unknown): boolean {
  if (error instanceof NotFound) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    name === 'NotFound' ||
    name === 'NoSuchBucket' ||
    $metadata?.httpStatusCode === 404
  );
}
