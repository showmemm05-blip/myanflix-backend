import { Injectable, Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { BookType, ChapterStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { probePdf, renderPdfPageToPng } from './pdf.util';

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
 * PDF -> per-page WebP conversion, per CHAPTER — each chapter is its own
 * release with its own file, so two chapters (and two languages) convert
 * independently and one failing never stalls the rest.
 *
 * The books counterpart of ProcessingService, following its shape: in-process and
 * fire-and-forget (no queue exists in this backend), DB status as the
 * source of truth, an in-memory in-flight set so orphaned PROCESSING rows
 * are distinguishable from live ones, and idempotent resume — a BookPage
 * row is created only after its WebP is uploaded, so a retry skips every
 * page that already has one.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
  ) {}

  isActivelyProcessing(chapterId: string): boolean {
    return this.activeChapterIds.has(chapterId);
  }

  /**
   * Original PDF -> pdftoppm -> sharp -> WebP per page -> MinIO + BookPage
   * rows. Runs in the background; the triggering request does not wait.
   */
  async processChapter(chapterId: string): Promise<void> {
    this.activeChapterIds.add(chapterId);
    try {
      await this.runPipeline(chapterId);
    } finally {
      this.activeChapterIds.delete(chapterId);
    }
  }

  private async runPipeline(chapterId: string): Promise<void> {
    const scratchDir = this.storageService.bookScratchDir(chapterId);

    try {
      const chapter = await this.prisma.bookChapter.findUnique({
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

      await this.storageService.ensureDir(scratchDir);
      const localPdf = join(scratchDir, 'original.pdf');
      await this.minioService.downloadFile(chapter.pdfKey, localPdf);

      const { pageCount } = await probePdf(localPdf);

      // Pages that already made it through a previous (partial) run — their
      // rows only exist because their WebP upload succeeded, so they are
      // safe to skip wholesale.
      const existing = await this.prisma.bookPage.findMany({
        where: { chapterId },
        select: { pageNumber: true },
      });
      const done = new Set(existing.map((p) => p.pageNumber));

      await this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: { pageCount, processedPages: done.size },
      });

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
            scratchDir,
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(PAGE_CONCURRENCY, pending.length) }, worker),
      );

      await this.prisma.bookChapter.update({
        where: { id: chapterId },
        data: { status: ChapterStatus.READY },
      });
      this.logger.log(
        `Chapter ${chapterId} converted: ${pageCount} pages ready`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `PDF conversion failed for chapter ${chapterId}: ${reason}`,
      );

      // Its own try/catch for the same reason ProcessingService has one: a
      // book deleted mid-conversion makes this update throw P2025, and an
      // unhandled rejection here would take the whole container down.
      try {
        await this.prisma.bookChapter.update({
          where: { id: chapterId },
          data: { status: ChapterStatus.FAILED, processingError: reason },
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
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async convertPage(
    ids: { bookId: string; editionId: string; chapterId: string },
    localPdf: string,
    pageNumber: number,
    pageCount: number,
    scratchDir: string,
  ): Promise<void> {
    const pngBase = join(scratchDir, `page-${pageNumber}`);
    const pngPath = await renderPdfPageToPng(localPdf, pageNumber, pngBase);

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

      const imageKey = this.storageService.bookPageKey(
        ids.bookId,
        ids.editionId,
        ids.chapterId,
        pageNumber,
        pageCount,
      );
      await this.minioService.uploadBuffer(imageKey, data);

      // Row AFTER upload — its existence is the resume marker (see the
      // class doc comment), so it must never precede the bytes.
      await this.prisma.bookPage.create({
        data: {
          chapterId: ids.chapterId,
          pageNumber,
          imageKey,
          width: info.width,
          height: info.height,
          fileSize: data.length,
        },
      });
      await this.prisma.bookChapter.update({
        where: { id: ids.chapterId },
        data: { processedPages: { increment: 1 } },
      });
    } finally {
      await rm(pngPath, { force: true }).catch(() => {});
    }
  }
}
