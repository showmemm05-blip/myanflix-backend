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
    const configuredPath =
      configService.get<string>('STORAGE_PATH') ?? './storage';
    this.root = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(process.cwd(), configuredPath);
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

  /**
   * MinIO key prefix for the published subtitle renditions — a sibling of
   * the video renditions so the URIs inside master.m3u8 stay relative
   * (`subs/<subtitleId>.m3u8`) and keep working through the cache server
   * whatever host it is reached on. Distinct from `subtitles/<id>/original.*`,
   * which is the uploaded SOURCE file and is never served to a player.
   */
  hlsSubtitleKeyPrefix(movieId: string): string {
    return `videos/${movieId}/hls/subs`;
  }

  /** MinIO key for one published WebVTT track. */
  hlsSubtitleVttKey(movieId: string, subtitleId: string): string {
    return `${this.hlsSubtitleKeyPrefix(movieId)}/${subtitleId}.vtt`;
  }

  /** MinIO key for the single-segment media playlist wrapping that WebVTT. */
  hlsSubtitlePlaylistKey(movieId: string, subtitleId: string): string {
    return `${this.hlsSubtitleKeyPrefix(movieId)}/${subtitleId}.m3u8`;
  }

  /** MinIO object key for a poster/cover image. */
  imageObjectKey(imageId: string, extension: string): string {
    return `images/${imageId}${extension}`;
  }

  /** Local scratch dir for one chapter's PDF->WebP conversion (deleted after the run). */
  bookScratchDir(chapterId: string): string {
    return join(this.root, 'books', chapterId);
  }

  /**
   * MinIO key prefix for one language edition. Nested under the BOOK, not
   * beside it, so deleting a book still reaches every language with a single
   * deleteByPrefix(`books/<bookId>/`).
   */
  bookEditionPrefix(bookId: string, editionId: string): string {
    return `books/${bookId}/${editionId}`;
  }

  /**
   * MinIO key prefix for one chapter, nested inside its edition for the same
   * reason the edition nests inside the book: deleting any level above still
   * reaches everything below it with a single prefix delete.
   */
  bookChapterPrefix(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): string {
    return `${this.bookEditionPrefix(bookId, editionId)}/${chapterId}`;
  }

  /** MinIO object key of one chapter's uploaded PDF — a chapter is a release. */
  bookPdfKey(bookId: string, editionId: string, chapterId: string): string {
    return `${this.bookChapterPrefix(bookId, editionId, chapterId)}/original.pdf`;
  }

  /**
   * MinIO object key of one converted page, numbered WITHIN ITS CHAPTER. The
   * page number is zero-padded to at least three digits (widening for very
   * long chapters) so both key listings and filenames sort in reading order.
   */
  bookPageKey(
    bookId: string,
    editionId: string,
    chapterId: string,
    pageNumber: number,
    totalPages: number,
  ): string {
    const width = Math.max(3, String(totalPages).length);
    const padded = String(pageNumber).padStart(width, '0');
    return `${this.bookChapterPrefix(bookId, editionId, chapterId)}/pages/page-${padded}.webp`;
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
