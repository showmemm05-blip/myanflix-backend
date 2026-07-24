import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Central place that knows two things:
 *  - the LOCAL on-disk scratch layout under STORAGE_PATH, used only
 *    transiently (in-flight chunk uploads, ffmpeg's working directory —
 *    everything here gets deleted once it's no longer needed):
 *
 *      storage/
 *        uploads/<uploadId>/chunk_<n>
 *        videos/<movieId>/original.<ext>   (until archived)
 *        videos/<movieId>/hls/...          (until archived)
 *
 *  - the MinIO object key layout, which is where everything actually ends
 *    up living:
 *
 *      images/<imageId>.<ext>
 *      videos/<movieId>/original.<ext>
 *      videos/<movieId>/hls/master.m3u8
 *      videos/<movieId>/hls/<resolution>/index.m3u8 + segments
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

  /** MinIO object key for a movie's master playlist — mirrors hlsDir()'s local layout, without the local-disk root. */
  hlsMasterKey(movieId: string): string {
    return `videos/${movieId}/hls/master.m3u8`;
  }

  /** MinIO object key for the original (pre-transcode) upload — archived there so it doesn't have to live on local disk. */
  originalObjectKey(movieId: string, extension: string): string {
    return `videos/${movieId}/original${extension}`;
  }

  /** MinIO object key prefix for one rendition's segments + its own playlist. */
  hlsRenditionKeyPrefix(movieId: string, renditionName: string): string {
    return `videos/${movieId}/hls/${renditionName}`;
  }

  /** MinIO object key for a poster/cover image. */
  imageObjectKey(imageId: string, extension: string): string {
    return `images/${imageId}${extension}`;
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
