import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

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

  /** Uploads a single local file to `key`, creating/configuring the bucket first if needed. */
  async uploadFile(key: string, localFilePath: string): Promise<void> {
    await this.putObject(key, await readFile(localFilePath), extname(localFilePath));
  }

  /** Uploads in-memory bytes straight to `key` — no local disk involved at all (e.g. poster/cover images from multer's memory storage). */
  async uploadBuffer(key: string, buffer: Buffer): Promise<void> {
    await this.putObject(key, buffer, extname(key));
  }

  private async putObject(key: string, body: Buffer, extension: string): Promise<void> {
    await this.ensureBucket();
    const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Uploads every file in `localDir` (non-recursive — HLS rendition dirs are flat) under `keyPrefix`. */
  async uploadDirectory(localDir: string, keyPrefix: string): Promise<void> {
    const entries = await readdir(localDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => this.uploadFile(`${keyPrefix}/${entry.name}`, join(localDir, entry.name))),
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
