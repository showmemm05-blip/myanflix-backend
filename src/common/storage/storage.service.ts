import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  AVATAR_IMAGE_PURPOSE,
  ImagePurpose,
  LOCAL_SCRATCH_ROOT,
  UPLOAD_SCRATCH_ROOT,
} from './media-taxonomy';

/**
 * The ONLY place that builds a path or an object key. The shapes themselves
 * are declared in media-taxonomy.ts — this class is how the rest of the code
 * gets at them, so the local tree and the object tree cannot drift apart.
 *
 *  - the LOCAL on-disk scratch layout, everything transient, all of it under
 *    ONE root (<STORAGE_PATH>/temp/) so the cleanup sweep has a single
 *    directory to walk and an abandoned run cannot hide beside real data:
 *
 *      <STORAGE_PATH>/temp/
 *        uploads/<uploadId>/chunk_<n>            (+ merged, written by the
 *                                                 external-bundle flow)
 *        videos/<movieId>/original.<ext>         (ffmpeg's input)
 *        videos/<movieId>/hls/...                (ffmpeg's output; master
 *                                                 and <tier>/ MUST stay
 *                                                 siblings — ffmpeg writes
 *                                                 the relative variant URIs
 *                                                 that end up in the
 *                                                 uploaded manifest)
 *        documents/books/<b>/<e>/<c>/<runId>/    (pdftoppm + sharp scratch)
 *
 *  - the object key layout, which is where everything actually ends up:
 *
 *      images/<purpose>/<id><ext>                 public, unsigned
 *      images/user/<userId>/<stamp><ext>          public, unsigned
 *      videos/<movieId>/original.<ext>            private source
 *      videos/<movieId>/hls/**                    signed, generated
 *      subtitles/<movieId>/<name><ext>            signed source
 *      documents/books/<b>/<e>/<c>/original.pdf   private source
 *      books/<b>/<e>/<c>/pages/page-NNN.webp      signed, generated
 *
 * Source lives apart from generated output everywhere, with TWO deliberate
 * exceptions that are technical requirements rather than oversights:
 *
 *   1. videos/<movieId>/hls/subs/ holds GENERATED subtitle renditions under
 *      videos/ instead of subtitles/. master.m3u8 names them by RELATIVE URI
 *      (`subs/<id>.m3u8`), and a token signs a PREFIX — so they have to sit
 *      under the same prefix the master was signed with, or the player would
 *      need a second token it has no way to ask for.
 *   2. Generated book pages stay under books/ instead of moving under
 *      images/. images/ is public by key — that is what makes the catalogue
 *      browsable without a token — and a book page is paid content that must
 *      only ever be reachable through a signed link.
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

  /**
   * The one local directory every transient file lives under. The cleanup
   * sweep walks this and nothing else, which is only safe because no
   * long-lived file is ever written outside it.
   */
  get scratchRoot(): string {
    return join(this.root, LOCAL_SCRATCH_ROOT);
  }

  uploadSessionDir(uploadId: string): string {
    return join(this.scratchRoot, UPLOAD_SCRATCH_ROOT, uploadId);
  }

  chunkPath(uploadId: string, chunkNumber: number): string {
    return join(this.uploadSessionDir(uploadId), `chunk_${chunkNumber}`);
  }

  videoDir(movieId: string): string {
    return join(this.scratchRoot, 'videos', movieId);
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

  /**
   * Everything one title owns under videos/ — its original and its whole HLS
   * package. Deleting a movie is this one prefix plus subtitleSourcePrefix().
   */
  videoKeyPrefix(movieId: string): string {
    return `videos/${movieId}`;
  }

  /**
   * MinIO object key for the original (pre-transcode) upload — archived there
   * so it doesn't have to live on local disk. It MUST stay a direct child
   * literally named original.*: the cache server denies that exact shape
   * unsigned in both legacy modes, and it is deliberately unsignable.
   */
  originalObjectKey(movieId: string, extension: string): string {
    return `${this.videoKeyPrefix(movieId)}/original${extension}`;
  }

  /** MinIO object key prefix for one rendition's segments + its own playlist. */
  hlsRenditionKeyPrefix(movieId: string, renditionName: string): string {
    return `videos/${movieId}/hls/${renditionName}`;
  }

  /**
   * MinIO key prefix for the published subtitle renditions — a sibling of
   * the video renditions so the URIs inside master.m3u8 stay relative
   * (`subs/<subtitleId>.m3u8`) and keep working through the cache server
   * whatever host it is reached on — which is also why these GENERATED files
   * live under videos/ rather than subtitles/ (exception 1 in the class
   * comment). Distinct from subtitleSourceKey() below, the uploaded SOURCE
   * file, which no player ever fetches.
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

  /**
   * MinIO key prefix for one movie's uploaded subtitle SOURCE files, from
   * both the single upload and the bulk bundle. Keyed by the OWNING MOVIE
   * rather than by the subtitle id, so a title's sources are one prefix
   * delete and /stream can always sign them.
   */
  subtitleSourcePrefix(movieId: string): string {
    return `subtitles/${movieId}`;
  }

  /**
   * MinIO object key for one uploaded subtitle source. `filename` is the
   * whole leaf name including its extension — `<subtitleId>.srt` for a single
   * upload, the operator's own name for a bulk bundle — because the bundle's
   * filenames are what the operator matches tracks by.
   */
  subtitleSourceKey(movieId: string, filename: string): string {
    return `${this.subtitleSourcePrefix(movieId)}/${filename}`;
  }

  /**
   * MinIO object key for a still image, foldered by what it is FOR. The
   * filename is flat inside the purpose folder because images are uploaded
   * before their owner row exists — there is no owner id to nest under at
   * write time.
   *
   * Everything under images/ is public by key: it carries no signable scope
   * and the cache server serves it without a token, which is what makes the
   * catalogue browsable. Never give a private asset an image purpose.
   */
  imageObjectKey(
    purpose: ImagePurpose,
    imageId: string,
    extension: string,
  ): string {
    return `images/${purpose}/${imageId}${extension}`;
  }

  /**
   * MinIO key prefix for one user's profile pictures. A folder per user is
   * what makes deleting an account a single prefix delete — with a flat
   * `images/avatars/<userId>-<ts>.<ext>` there was no way to reach a user's
   * old avatars at all.
   */
  avatarPrefix(userId: string): string {
    return `images/${AVATAR_IMAGE_PURPOSE}/${userId}`;
  }

  /**
   * MinIO object key for one profile picture. `stamp` is the epoch-ms version
   * of the upload, not a random id: a replaced avatar must land on a NEW key
   * or the cache server would keep serving the old bytes for its full 7 days.
   */
  avatarKey(userId: string, stamp: number, extension: string): string {
    return `${this.avatarPrefix(userId)}/${stamp}${extension}`;
  }

  /**
   * Local scratch dir for one chapter's PDF->WebP conversion (deleted after
   * the run). Nested by book/edition/chapter like every book key, so a
   * half-finished conversion is reachable from the same parent as the
   * chapter it belongs to instead of sitting in a flat pile of chapter ids.
   * Callers add their own per-run subdirectory under this.
   */
  bookScratchDir(bookId: string, editionId: string, chapterId: string): string {
    return join(
      this.scratchRoot,
      'documents',
      'books',
      bookId,
      editionId,
      chapterId,
    );
  }

  /**
   * MinIO key prefix for everything GENERATED for one book — its reader
   * pages. The uploaded PDFs live under bookDocumentPrefix() instead, so
   * deleting a book is two prefix deletes rather than one; that is the price
   * of keeping documents/ uniformly "private source, never served".
   */
  bookPrefix(bookId: string): string {
    return `books/${bookId}`;
  }

  /**
   * MinIO key prefix for one language edition. Nested under the BOOK, not
   * beside it, so deleting a book still reaches every language with a single
   * deleteByPrefix(`books/<bookId>/`).
   */
  bookEditionPrefix(bookId: string, editionId: string): string {
    return `${this.bookPrefix(bookId)}/${editionId}`;
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

  /**
   * MinIO key prefix for one book's uploaded source PDFs. It mirrors the
   * books/ depth exactly — book, edition, chapter — so every level that is
   * one prefix delete on the generated side is one prefix delete here too.
   */
  bookDocumentPrefix(bookId: string): string {
    return `documents/books/${bookId}`;
  }

  /** documents/ prefix for one language edition — mirrors bookEditionPrefix. */
  bookDocumentEditionPrefix(bookId: string, editionId: string): string {
    return `${this.bookDocumentPrefix(bookId)}/${editionId}`;
  }

  /** documents/ prefix for one chapter — mirrors bookChapterPrefix. */
  bookDocumentChapterPrefix(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): string {
    return `${this.bookDocumentEditionPrefix(bookId, editionId)}/${chapterId}`;
  }

  /**
   * MinIO object key of one chapter's uploaded PDF — a chapter is a release.
   * Under documents/, not books/, because it is SOURCE: the whole documents/
   * namespace is denied at the cache and unsignable, so a source PDF cannot
   * be handed out by accident the way a key under books/ could be.
   */
  bookPdfKey(bookId: string, editionId: string, chapterId: string): string {
    return `${this.bookDocumentChapterPrefix(bookId, editionId, chapterId)}/original.pdf`;
  }

  /**
   * MinIO object key of one converted page, numbered WITHIN ITS CHAPTER. The
   * page number is zero-padded to at least three digits (widening for very
   * long chapters) so both key listings and filenames sort in reading order.
   *
   * These are images and they still do NOT live under images/ (exception 2 in
   * the class comment): images/ is public by key, and a book page is paid
   * content that must only ever be reachable through a signed link.
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
