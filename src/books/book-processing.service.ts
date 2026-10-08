import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { BookType, ChapterStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { bookChapterSnapshot } from '../audit/audit-snapshots';
import { AuditService } from '../audit/audit.service';
import { ConversionSlots } from '../common/concurrency/slots';
import {
  describeBytes,
  maxDocumentUploadBytes,
} from '../uploads/upload-limits';
import { probePdf, renderDpiForPage, renderPdfPageToPng } from './pdf.util';

/**
 * Longest edge caps for the served WebPs. 1600px wide fills a desktop
 * reading column at retina density and downscales cleanly on phones;
 * `withoutEnlargement` below means a small page is never upscaled past
 * what the PDF actually contains.
 */
const MAX_PAGE_WIDTH = 1600;
const MAX_PAGE_HEIGHT = 2600;

/** Text-heavy pages stay legible at 82; photos stay reasonable. */
const WEBP_QUALITY = 82;

/**
 * Pages converted at a time. Rasterising is CPU-bound and this VPS also
 * runs the API + Postgres (the same reason ffmpeg runs at niceness 19), so
 * a wide pool would starve everything else for no wall-clock win.
 */
const PAGE_CONCURRENCY = 2;

/**
 * How many CHAPTERS may convert at the same time across the whole process
 * (M-9). The per-chapter reservation only stops the same chapter starting
 * twice; without this, N chapters started together ran N pdftoppm pools at
 * once on the box that also serves the API and Postgres. Extra starts are
 * accepted (the chapter goes PROCESSING right away) and simply wait their
 * turn. BOOK_CONVERSION_CONCURRENCY overrides it.
 */
const DEFAULT_CONVERSION_CONCURRENCY = 2;

export function conversionConcurrency(): number {
  const raw = Number(process.env.BOOK_CONVERSION_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_CONVERSION_CONCURRENCY;
}

/**
 * The pages/v-<tag>/ folder one SOURCE file converts into (H-23). A pure
 * function of the file's ETag: a retry of the same bytes lands on the same
 * keys and can resume, while a different file always gets a folder no cache
 * server has fetched from, so no reader can be served a cached page of the
 * old file. Without an ETag a run cannot be matched to anything, so it gets
 * a one-off folder (and never resumes — see runPipeline).
 */
export function pagesFolderTag(sourceEtag: string | null): string {
  return sourceEtag
    ? createHash('sha256').update(sourceEtag).digest('hex').slice(0, 16)
    : randomBytes(8).toString('hex');
}

/** The chapter row as the pipeline loads it: with the ids it needs to build keys. */
type ProcessableChapter = Prisma.BookChapterGetPayload<{
  include: {
    edition: {
      select: { id: true; book: { select: { id: true; type: true } } };
    };
  };
}>;

/**
 * PDF -> per-page WebP conversion, per CHAPTER — each chapter is its own
 * release with its own file, so two chapters (and two languages) convert
 * independently and one failing never stalls the rest.
 *
 * The books counterpart of ProcessingService, following its shape: in-process and
 * fire-and-forget (no queue exists in this backend), DB status as the
 * source of truth, an in-memory in-flight set so orphaned PROCESSING rows
 * are distinguishable from live ones, and idempotent resume — a BookPage
 * row is created only after its WebP is uploaded, so a retry skips every
 * page that already has one. Resume applies only to a retry of the SAME
 * source file (BookChapter.pagesSourceEtag): a re-uploaded PDF clears the
 * old pages first and converts from page 1 (H-23).
 *
 * One deliberate improvement over the video pipeline: pages are countable
 * up front, so `processedPages / pageCount` gives the admin REAL progress
 * instead of the elapsed-time estimate the movie upload UI has to fake.
 */
@Injectable()
export class BookProcessingService {
  private readonly logger = new Logger(BookProcessingService.name);

  // See ProcessingService.activeVideoIds for why this is deliberately never
  // persisted: a fresh process starts empty, so a PROCESSING row with no
  // entry here is unambiguously orphaned and safe to retry. Keyed by
  // CHAPTER — every chapter carries its own file and converts on its own.
  private readonly activeChapterIds = new Set<string>();

  /** Process-wide: at most conversionConcurrency() pipelines past the download at once. */
  private readonly slots = new ConversionSlots(conversionConcurrency);

  /** How many chapters are converting right now and how many wait for a slot — for the spec and the log. */
  get conversionLoad(): { active: number; queued: number } {
    return { active: this.slots.active, queued: this.slots.queued };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
    private readonly audit: AuditService,
  ) {}

  isActivelyProcessing(chapterId: string): boolean {
    return this.activeChapterIds.has(chapterId);
  }

  /**
   * Claims the chapter for the caller BEFORE it does any async work —
   * synchronous on purpose: a check-and-add with no await in between
   * cannot interleave with another request, so of N simultaneous start
   * requests exactly one gets `true`. The caller must either hand the
   * chapter to processChapter() (whose finally clears the claim once the
   * run owns it) or release() it on every throw in between — otherwise the
   * chapter stays refused until the process restarts.
   */
  reserve(chapterId: string): boolean {
    if (this.activeChapterIds.has(chapterId)) return false;
    this.activeChapterIds.add(chapterId);
    return true;
  }

  /** Gives a reserve() back when the start request fails before the pipeline takes over. */
  release(chapterId: string): void {
    this.activeChapterIds.delete(chapterId);
  }

  /**
   * Original PDF -> pdftoppm -> sharp -> WebP per page -> MinIO + BookPage
   * rows. Runs in the background; the triggering request does not wait.
   */
  async processChapter(chapterId: string): Promise<void> {
    // Idempotent after a reserve(); the finally is what releases it.
    this.activeChapterIds.add(chapterId);
    try {
      await this.runPipeline(chapterId);
    } finally {
      this.activeChapterIds.delete(chapterId);
    }
  }

  private async runPipeline(chapterId: string): Promise<void> {
    // One directory per RUN under the chapter's scratch root, so a run that
    // finishes (and removes its own directory in the finally below) can
    // never delete the original.pdf / page PNGs of another run for the
    // same chapter. The run id is minted here, but the root itself is now
    // nested by book and edition like every other book path, so the full
    // directory can only be resolved once the chapter row has been read —
    // hence the null until then, and the guard in the finally.
    const runId = randomUUID();
    // What the finally has to remove — null until the directory exists. The
    // pipeline itself works off its own const below, because a `let` loses
    // its non-null narrowing inside the worker closure.
    let createdScratchDir: string | null = null;
    // The row as it was before this run touched it — the `before` of the
    // READY/FAILED audit event. Declared out here so the catch can see it.
    let chapter: ProcessableChapter | null = null;
    // Page rows of an older source file this run removed (H-23) — reported
    // on the outcome audit event either way.
    let previousPagesRemoved = 0;
    // Whether this run holds one of the process-wide conversion slots.
    let holdsSlot = false;

    try {
      chapter = await this.prisma.bookChapter.findUnique({
        where: { id: chapterId },
        include: {
          edition: {
            select: {
              id: true,
              book: { select: { id: true, type: true } },
            },
          },
        },
      });
      if (
        !chapter ||
        chapter.edition.book.type !== BookType.PDF ||
        !chapter.pdfKey
      ) {
        this.logger.warn(
          `Chapter ${chapterId} is missing or not a processable PDF chapter — nothing to do`,
        );
        return;
      }
      const bookId = chapter.edition.book.id;
      const editionId = chapter.edition.id;

      await this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: { status: ChapterStatus.PROCESSING, processingError: null },
      });

      // The object's size is checked from its HEAD before a byte of it is
      // downloaded (M-24): a PDF over the document budget is failed here,
      // never streamed to the scratch disk.
      const stat = await this.minioService.objectStat(chapter.pdfKey);
      if (!stat) {
        throw new Error(
          'No uploaded PDF found for this chapter — upload the file first',
        );
      }
      const maxBytes = maxDocumentUploadBytes();
      if (stat.size > maxBytes) {
        throw new Error(
          `The PDF is ${stat.size} bytes — a chapter PDF may be at most ${describeBytes(maxBytes)}`,
        );
      }

      // Wait for a process-wide slot (M-9). The chapter already reads
      // PROCESSING, so the admin's poll shows it queued rather than idle.
      await this.slots.acquire();
      holdsSlot = true;

      const scratchDir = join(
        this.storageService.bookScratchDir(bookId, editionId, chapterId),
        runId,
      );
      createdScratchDir = scratchDir;
      await this.storageService.ensureDir(scratchDir);
      const localPdf = join(scratchDir, 'original.pdf');
      const { etag: sourceEtag } = await this.minioService.downloadFile(
        chapter.pdfKey,
        localPdf,
      );

      // The PDF sits at one fixed key, so a re-upload overwrites it. The
      // stored pages are this file's only when they were recorded against
      // this exact ETag — a retry of the same file. Anything else (a new
      // file, pages from before this was tracked, no ETag at all) is cleared
      // before a single new page is written, so the chapter never mixes two
      // files' pages and processedPages can never pass pageCount.
      const sameSource =
        sourceEtag !== null && chapter.pagesSourceEtag === sourceEtag;
      if (!sameSource) {
        previousPagesRemoved = await this.clearPages(
          bookId,
          editionId,
          chapterId,
        );
      }

      const { pageCount, pageSizes } = await probePdf(localPdf);

      // Pages that already made it through a previous (partial) run of THIS
      // file — their rows only exist because their WebP upload succeeded, so
      // they are safe to skip wholesale.
      const existing = sameSource
        ? await this.prisma.bookPage.findMany({
            where: { chapterId },
            select: { pageNumber: true },
          })
        : [];
      const done = new Set(existing.map((p) => p.pageNumber));

      // Recorded only now, after any clear finished: a clear that failed half
      // way leaves the old ETag (or NULL) behind, so the next start clears
      // again instead of resuming on top of the leftovers.
      await this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: {
          pageCount,
          processedPages: done.size,
          pagesSourceEtag: sourceEtag,
        },
      });
      const sourceTag = pagesFolderTag(sourceEtag);

      const pending: number[] = [];
      for (let page = 1; page <= pageCount; page++) {
        if (!done.has(page)) pending.push(page);
      }

      // A tiny worker pool: shift from a shared queue until it runs dry.
      // The first failure aborts the whole run — remaining pages would only
      // pile more of the same error onto the log, and resume picks up
      // exactly where the finished rows end.
      let nextIndex = 0;
      const worker = async () => {
        for (;;) {
          const index = nextIndex++;
          if (index >= pending.length) return;
          await this.convertPage(
            { bookId, editionId, chapterId },
            localPdf,
            pending[index],
            pageCount,
            sourceTag,
            scratchDir,
            renderDpiForPage(pageSizes.get(pending[index])),
          );
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(PAGE_CONCURRENCY, pending.length) },
          worker,
        ),
      );

      const ready = await this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: { status: ChapterStatus.READY },
      });
      this.logger.log(
        `Chapter ${chapterId} converted: ${pageCount} pages ready`,
      );
      // Nobody is on the request: the conversion finishing is a system event.
      await this.audit.record({
        action: 'book_chapter.status_change',
        actor: null,
        target: { type: 'book_chapter', id: chapterId, label: ready.title },
        before: bookChapterSnapshot(chapter),
        after: bookChapterSnapshot(ready),
        metadata: {
          trigger: 'pdf_conversion_complete',
          bookId,
          editionId,
          pageCount,
          previousPagesRemoved,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `PDF conversion failed for chapter ${chapterId}: ${reason}`,
      );

      // Its own try/catch for the same reason ProcessingService has one: a
      // book deleted mid-conversion makes this update throw P2025, and an
      // unhandled rejection here would take the whole container down.
      try {
        const failed = await this.prisma.bookChapter.update({
          where: { id: chapterId },
          data: { status: ChapterStatus.FAILED, processingError: reason },
        });
        await this.audit.record({
          action: 'book_chapter.status_change',
          actor: null,
          target: { type: 'book_chapter', id: chapterId, label: failed.title },
          before: chapter ? bookChapterSnapshot(chapter) : null,
          after: bookChapterSnapshot(failed),
          metadata: {
            trigger: 'pdf_conversion_failed',
            bookId: chapter?.edition.book.id ?? null,
            editionId: chapter?.editionId ?? null,
            reason,
            previousPagesRemoved,
          },
        });
      } catch (updateError) {
        if (
          updateError instanceof Prisma.PrismaClientKnownRequestError &&
          updateError.code === 'P2025'
        ) {
          this.logger.warn(
            `Chapter ${chapterId} was deleted while its conversion was running`,
          );
        } else {
          this.logger.error(
            `Could not record conversion failure for chapter ${chapterId}: ${(updateError as Error).message}`,
          );
        }
      }
    } finally {
      if (holdsSlot) this.slots.release();
      // Still null when the run bailed out before the chapter row resolved —
      // nothing was created, so there is nothing to remove.
      if (createdScratchDir) {
        await rm(createdScratchDir, {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }
  }

  /**
   * Removes every page of an older source file: the rows first, together
   * with the counters in one transaction (so a reader is never handed a row
   * whose image is already gone, and the admin never sees processedPages
   * above pageCount), then every object under the chapter's pages/ prefix —
   * which also sweeps any orphan a crashed run uploaded without a row. The
   * chapter is PROCESSING throughout, so no reader lists it meanwhile.
   * Returns how many rows went.
   */
  private async clearPages(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): Promise<number> {
    const [removed] = await this.prisma.$transaction([
      this.prisma.bookPage.deleteMany({ where: { chapterId } }),
      this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: { pageCount: 0, processedPages: 0, pagesSourceEtag: null },
      }),
    ]);
    await this.minioService.deleteByPrefix(
      this.storageService.bookPagesPrefix(bookId, editionId, chapterId),
    );
    return removed.count;
  }

  private async convertPage(
    ids: { bookId: string; editionId: string; chapterId: string },
    localPdf: string,
    pageNumber: number,
    pageCount: number,
    sourceTag: string,
    scratchDir: string,
    dpi: number,
  ): Promise<void> {
    const pngBase = join(scratchDir, `page-${pageNumber}`);
    // The DPI is bounded per page (see renderDpiForPage): an ordinary page
    // renders at the standard 150, a poster-sized one lower, so the raw
    // bitmap below can never be the multi-gigabyte image it used to be.
    const pngPath = await renderPdfPageToPng(
      localPdf,
      pageNumber,
      pngBase,
      dpi,
    );

    try {
      const { data, info } = await sharp(pngPath)
        // fit: 'inside' preserves the page's own aspect ratio within the
        // caps; withoutEnlargement keeps a small page at its real size
        // instead of upscaling blur into it.
        .resize({
          width: MAX_PAGE_WIDTH,
          height: MAX_PAGE_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });

      // Pages stay under books/, NOT under images/, even though they are
      // images: images/ is public by key and a converted page is paid
      // content that must only ever be reachable through a signed link.
      // The source PDF went the other way, to documents/, because it is
      // source and is never served at all.
      const imageKey = this.storageService.bookPageKey(
        ids.bookId,
        ids.editionId,
        ids.chapterId,
        pageNumber,
        pageCount,
        sourceTag,
      );
      await this.minioService.uploadBuffer(imageKey, data);

      // Row AFTER upload — its existence is the resume marker (see the
      // class doc comment), so it must never precede the bytes. The row and
      // the progress counter go in one transaction so they are atomic: the
      // counter can never drift from the rows. (This is for correctness, not
      // speed — through @prisma/adapter-pg a batch transaction is still sent
      // as separate BEGIN / INSERT / UPDATE / COMMIT statements.)
      await this.prisma.$transaction([
        this.prisma.bookPage.create({
          data: {
            chapterId: ids.chapterId,
            pageNumber,
            imageKey,
            width: info.width,
            height: info.height,
            fileSize: data.length,
          },
        }),
        this.prisma.bookChapter.update({
          where: { id: ids.chapterId },
          data: { processedPages: { increment: 1 } },
        }),
      ]);
    } finally {
      await rm(pngPath, { force: true }).catch(() => {});
    }
  }
}
