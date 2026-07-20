import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Central place that knows the on-disk layout under STORAGE_PATH:
 *
 *   storage/
 *     uploads/<uploadId>/chunk_<n>      (transient, deleted after merge)
 *     videos/<movieId>/original.<ext>
 *     videos/<movieId>/hls/master.m3u8
 *     videos/<movieId>/hls/<resolution>/index.m3u8 + segments
 */
@Injectable()
export class StorageService {
  readonly root: string;

  constructor(configService: ConfigService) {
    const configuredPath = configService.get<string>('STORAGE_PATH') ?? './storage';
    this.root = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  uploadSessionDir(uploadId: string): string {
    return join(this.root, 'uploads', uploadId);
  }

  chunkPath(uploadId: string, chunkNumber: number): string {
    return join(this.uploadSessionDir(uploadId), `chunk_${chunkNumber}`);
  }

  videoDir(movieId: string): string {
    return join(this.root, 'videos', movieId);
  }

  originalVideoPath(movieId: string, extension: string): string {
    return join(this.videoDir(movieId), `original${extension}`);
  }

  hlsDir(movieId: string): string {
    return join(this.videoDir(movieId), 'hls');
  }

  imagesDir(): string {
    return join(this.root, 'images');
  }

  imagePath(imageId: string, extension: string): string {
    return join(this.imagesDir(), `${imageId}${extension}`);
  }

  /** Path clients will be served under, e.g. /storage/videos/<id>/hls/master.m3u8 */
  toPublicPath(absolutePath: string): string {
    const relative = absolutePath.slice(this.root.length).replace(/\\/g, '/');
    return `/storage${relative.startsWith('/') ? '' : '/'}${relative}`;
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
