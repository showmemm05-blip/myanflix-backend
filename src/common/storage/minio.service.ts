import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
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

// Without these, the AWS SDK's default HTTP handler has no timeout at all —
// a stalled connection to MinIO (a dropped packet, a brief network blip)
// hangs the request forever instead of failing and retrying. A multipart
// upload's individual part requests are at most UPLOAD_PART_SIZE, so
// REQUEST_TIMEOUT_MS only has to cover one part, not the whole file —
// generous even on a slow connection without masking a genuinely stalled one.
const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

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
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('MINIO_BUCKET') ?? 'movies';
    this.client = new S3Client({
      endpoint: this.configService.get<string>('MINIO_ENDPOINT'),
      region: 'us-east-1', // required by the SDK; ignored by MinIO
      credentials: {
        accessKeyId: this.configService.get<string>('MINIO_ACCESS_KEY') ?? '',
        secretAccessKey: this.configService.get<string>('MINIO_SECRET_KEY') ?? '',
      },
      // MinIO (and the cache server proxying to it) expect /<bucket>/<key>
      // paths, not <bucket>.<host> virtual-hosted addressing.
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      }),
      maxAttempts: MAX_ATTEMPTS,
    });
  }

  get bucketName(): string {
    return this.bucket;
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

  private contentTypeFor(extension: string): string {
    return CONTENT_TYPES[extension] ?? 'application/octet-stream';
  }

  /** Whether `key` already exists — lets a reprocess/retry skip re-uploading bytes that are already archived. */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (error instanceof NotFound) return false;
      throw error;
    }
  }

  /** Deletes a single object — a no-op (not an error) if it's already gone, matching S3-compatible delete semantics. */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Deletes every object under `prefix` — e.g. a movie's whole `videos/<movieId>/` tree (original + every rendition + bundle subtitles) when the movie itself is deleted. */
  async deleteByPrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
        );
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
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
   */
  async downloadFile(key: string, localFilePath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = response.Body as Readable;
    await pipeline(body, createWriteStream(localFilePath));
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
      Array.from({ length: Math.min(DIRECTORY_UPLOAD_CONCURRENCY, files.length) }, worker),
    );
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) this.bucketReady = this.createBucketIfMissing();
    return this.bucketReady;
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch {
      // Doesn't exist yet — fall through and create it.
    }

    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));

    // HLS content is only ever handed out via the /videos/:movieId/stream
    // endpoint, which already checks purchase ownership before returning a
    // URL — public-read on the bucket is what lets the cache server (and
    // MinIO) serve every segment without per-object signing, which HLS's
    // many-small-files structure doesn't support cleanly. See
    // cacheserver/README.md for the full tradeoff.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${this.bucket}/*`] },
      ],
    };
    await this.client.send(
      new PutBucketPolicyCommand({ Bucket: this.bucket, Policy: JSON.stringify(policy) }),
    );
    this.logger.log(`Created bucket "${this.bucket}" with public-read policy`);
  }
}
