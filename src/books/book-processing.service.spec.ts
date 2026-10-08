import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import {
  BookProcessingService,
  pagesFolderTag,
} from './book-processing.service';
import { ConversionSlots } from '../common/concurrency/slots';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { probePdf, renderPdfPageToPng, PDF_RENDER_DPI } from './pdf.util';
import { BookType, ChapterStatus } from '../generated/prisma/client';

jest.mock('./pdf.util', () => ({
  ...jest.requireActual<typeof import('./pdf.util')>('./pdf.util'),
  probePdf: jest.fn(),
  renderPdfPageToPng: jest.fn(),
}));

jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('node:fs/promises', () => ({
  rm: jest.fn().mockResolvedValue(undefined),
}));

const probePdfMock = probePdf as jest.Mock;
const rmMock = rm as unknown as jest.Mock;
// Mocked so the pipeline never shells out to pdftoppm.
const renderMock = renderPdfPageToPng as jest.Mock;
const sharpMock = sharp as unknown as jest.Mock;

const CHAPTER_ID = 'chapter-1';
const BOOK_ID = 'book-1';
const EDITION_ID = 'edition-1';
// Local scratch now lives under <STORAGE_PATH>/temp/ and is nested by
// book/edition/chapter, mirroring the documents/ key it converts.
const SCRATCH_ROOT = `/scratch/temp/documents/books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}`;

/** A chapter row as the pipeline loads it — a zero-page PDF so no page ever renders. */
const chapterRow = () => ({
  id: CHAPTER_ID,
  editionId: EDITION_ID,
  partId: null,
  title: 'Chapter 1',
  imageUrl: null,
  order: 1,
  status: ChapterStatus.DRAFT,
  content: null,
  pdfKey: `documents/books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}/original.pdf`,
  pdfFileSize: null,
  pageCount: 0,
  processedPages: 0,
  processingError: null,
  pagesSourceEtag: null as string | null,
  edition: { id: EDITION_ID, book: { id: BOOK_ID, type: BookType.PDF } },
});
const PAGES_PREFIX = `books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}/pages/`;

describe('BookProcessingService', () => {
  let service: BookProcessingService;
  let prisma: {
    bookChapter: { findUnique: jest.Mock; update: jest.Mock };
    bookPage: { findMany: jest.Mock; create: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let minioService: {
    objectStat: jest.Mock;
    downloadFile: jest.Mock;
    uploadBuffer: jest.Mock;
    deleteByPrefix: jest.Mock;
  };
  let storageService: {
    bookScratchDir: jest.Mock;
    ensureDir: jest.Mock;
    bookPageKey: jest.Mock;
    bookPagesPrefix: jest.Mock;
  };
  /** Every side effect that matters for ordering, in the order it happened. */
  let events: string[];
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    events = [];
    prisma = {
      bookChapter: {
        findUnique: jest.fn().mockResolvedValue(chapterRow()),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ ...chapterRow(), ...data }),
          ),
      },
      bookPage: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: { pageNumber: number } }) => {
            events.push(`row:${data.pageNumber}`);
            return Promise.resolve(data);
          }),
        deleteMany: jest.fn().mockImplementation(() => {
          events.push('rows-cleared');
          return Promise.resolve({ count: 0 });
        }),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    minioService = {
      // A small PDF by default; the size-cap case overrides it.
      objectStat: jest.fn().mockResolvedValue({ size: 1000, etag: 'etag-new' }),
      downloadFile: jest.fn().mockResolvedValue({ etag: 'etag-new' }),
      uploadBuffer: jest.fn().mockImplementation((key: string) => {
        events.push(`upload:${key}`);
        return Promise.resolve();
      }),
      deleteByPrefix: jest.fn().mockImplementation((prefix: string) => {
        events.push(`objects-cleared:${prefix}`);
        return Promise.resolve();
      }),
    };
    storageService = {
      bookScratchDir: jest.fn(
        (bookId: string, editionId: string, chapterId: string) =>
          `/scratch/temp/documents/books/${bookId}/${editionId}/${chapterId}`,
      ),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      // The real key shape, so the tests can see which folder a page lands in.
      bookPageKey: jest.fn(
        (
          bookId: string,
          editionId: string,
          chapterId: string,
          pageNumber: number,
          totalPages: number,
          sourceTag: string,
        ) =>
          `books/${bookId}/${editionId}/${chapterId}/pages/v-${sourceTag}/page-${String(
            pageNumber,
          ).padStart(Math.max(3, String(totalPages).length), '0')}.webp`,
      ),
      bookPagesPrefix: jest.fn(
        (bookId: string, editionId: string, chapterId: string) =>
          `books/${bookId}/${editionId}/${chapterId}/pages/`,
      ),
    };
    renderMock.mockImplementation((_pdf: string, page: number, base: string) =>
      Promise.resolve(`${base}-${page}.png`),
    );
    sharpMock.mockImplementation(() => {
      const chain = {
        resize: () => chain,
        webp: () => chain,
        toBuffer: () =>
          Promise.resolve({
            data: Buffer.from('webp'),
            info: { width: 1200, height: 1800 },
          }),
      };
      return chain;
    });
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    probePdfMock.mockResolvedValue({ pageCount: 0, pageSizes: new Map() });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookProcessingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        { provide: StorageService, useValue: storageService },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(BookProcessingService);
  });

  describe('reserve / release — the synchronous claim a start request takes', () => {
    it('is exclusive: a second reserve() for the same chapter is refused until release()', () => {
      expect(service.reserve(CHAPTER_ID)).toBe(true);
      expect(service.isActivelyProcessing(CHAPTER_ID)).toBe(true);

      expect(service.reserve(CHAPTER_ID)).toBe(false);
      // Another chapter is unaffected.
      expect(service.reserve('chapter-2')).toBe(true);

      service.release(CHAPTER_ID);
      expect(service.isActivelyProcessing(CHAPTER_ID)).toBe(false);
      expect(service.reserve(CHAPTER_ID)).toBe(true);
    });

    it("is cleared by processChapter()'s finally once the run owns it", async () => {
      expect(service.reserve(CHAPTER_ID)).toBe(true);

      const run = service.processChapter(CHAPTER_ID);
      // Still reserved while the (mocked) pipeline is in flight.
      expect(service.isActivelyProcessing(CHAPTER_ID)).toBe(true);
      expect(service.reserve(CHAPTER_ID)).toBe(false);

      await run;
      expect(service.isActivelyProcessing(CHAPTER_ID)).toBe(false);
    });

    it('is cleared even when the run fails — a FAILED chapter can be retried straight away', async () => {
      prisma.bookChapter.findUnique.mockRejectedValue(new Error('db down'));
      expect(service.reserve(CHAPTER_ID)).toBe(true);

      await service.processChapter(CHAPTER_ID);

      expect(service.isActivelyProcessing(CHAPTER_ID)).toBe(false);
      expect(prisma.bookChapter.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ChapterStatus.FAILED }),
        }),
      );
    });
  });

  describe('per-run scratch directory', () => {
    it('converts under temp/documents/books/<b>/<e>/<c>/<uuid> and removes only that directory in its finally', async () => {
      await service.processChapter(CHAPTER_ID);

      // The root is resolved from the chapter row's own ids, not from the
      // chapter id alone — that is what nests scratch the way the keys nest.
      expect(storageService.bookScratchDir).toHaveBeenCalledWith(
        BOOK_ID,
        EDITION_ID,
        CHAPTER_ID,
      );
      expect(storageService.ensureDir).toHaveBeenCalledTimes(1);
      const [scratchDir] = storageService.ensureDir.mock.calls[0] as [string];
      expect(scratchDir.startsWith(`${SCRATCH_ROOT}/`)).toBe(true);
      expect(scratchDir).not.toBe(SCRATCH_ROOT);
      expect(minioService.downloadFile).toHaveBeenCalledWith(
        chapterRow().pdfKey,
        `${scratchDir}/original.pdf`,
      );

      expect(rmMock).toHaveBeenCalledTimes(1);
      expect(rmMock).toHaveBeenCalledWith(scratchDir, {
        recursive: true,
        force: true,
      });
      expect(rmMock).not.toHaveBeenCalledWith(SCRATCH_ROOT, expect.anything());
    });

    it("gives two runs for the same chapter two different directories, so one finishing never deletes the other's files", async () => {
      await service.processChapter(CHAPTER_ID);
      await service.processChapter(CHAPTER_ID);

      const dirs = storageService.ensureDir.mock.calls.map(
        ([dir]: [string]) => dir,
      );
      expect(dirs).toHaveLength(2);
      expect(dirs[0]).not.toBe(dirs[1]);
      for (const dir of dirs) {
        expect(dir.startsWith(`${SCRATCH_ROOT}/`)).toBe(true);
      }
      expect(rmMock.mock.calls.map(([dir]: [string]) => dir)).toEqual(dirs);
    });

    it(
      'removes nothing when the run bails before the chapter row resolves — ' +
        'the directory is only knowable from that row, so there is none yet',
      async () => {
        prisma.bookChapter.findUnique.mockResolvedValue(null);

        await service.processChapter(CHAPTER_ID);

        expect(storageService.bookScratchDir).not.toHaveBeenCalled();
        expect(storageService.ensureDir).not.toHaveBeenCalled();
        expect(rmMock).not.toHaveBeenCalled();
      },
    );

    it('still cleans its own directory up when the run fails part-way', async () => {
      probePdfMock.mockRejectedValue(new Error('pdfinfo blew up'));

      await service.processChapter(CHAPTER_ID);

      const [scratchDir] = storageService.ensureDir.mock.calls[0] as [string];
      expect(rmMock).toHaveBeenCalledWith(scratchDir, {
        recursive: true,
        force: true,
      });
    });
  });

  /**
   * H-23: a chapter's PDF lives at ONE fixed key, so a re-upload overwrites
   * it and the next start must not treat the old file's pages as "already
   * done". Pages are resumed only when they are known to come from the very
   * file being converted (same ETag); anything else is converted from
   * scratch into a fresh pages/v-<tag>/ folder after the old rows and
   * objects are gone.
   */
  describe('replacing the source PDF', () => {
    const convertedChapter = (pagesSourceEtag: string | null) => ({
      ...chapterRow(),
      status: ChapterStatus.READY,
      pdfFileSize: BigInt(1000),
      pageCount: 3,
      processedPages: 3,
      pagesSourceEtag,
    });

    it('a different file: old rows, then old objects, are cleared before any new page is written, and the counters restart', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        convertedChapter('etag-old'),
      );
      // What the old file left behind — must NOT count as done.
      prisma.bookPage.findMany.mockResolvedValue(
        [1, 2, 3].map((pageNumber) => ({ pageNumber })),
      );
      probePdfMock.mockResolvedValue({ pageCount: 2, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(prisma.bookPage.deleteMany).toHaveBeenCalledWith({
        where: { chapterId: CHAPTER_ID },
      });
      // The counters reset in the SAME transaction as the rows, so the
      // admin never sees processedPages > pageCount.
      // One transaction for the clear, then one per converted page (its
      // row + the progress counter together).
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: { pageCount: 0, processedPages: 0, pagesSourceEtag: null },
      });
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(PAGES_PREFIX);

      const tag = pagesFolderTag('etag-new');
      expect(events).toEqual([
        'rows-cleared',
        `objects-cleared:${PAGES_PREFIX}`,
        expect.stringMatching(/^upload:/),
        expect.stringMatching(/^(row|upload):/),
        expect.stringMatching(/^(row|upload):/),
        expect.stringMatching(/^row:/),
      ]);
      // Both new pages, from page 1, into the new file's own folder.
      expect(
        renderMock.mock.calls.map(([, page]) => page as number).sort(),
      ).toEqual([1, 2]);
      expect(
        minioService.uploadBuffer.mock.calls
          .map(([key]) => key as string)
          .sort(),
      ).toEqual([
        `${PAGES_PREFIX}v-${tag}/page-001.webp`,
        `${PAGES_PREFIX}v-${tag}/page-002.webp`,
      ]);
      // The new file is recorded as the pages' source with the new count.
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: { pageCount: 2, processedPages: 0, pagesSourceEtag: 'etag-new' },
      });
      expect(prisma.bookChapter.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: { status: ChapterStatus.READY },
        }),
      );
    });

    it('writes each page row and its progress increment in ONE transaction', async () => {
      probePdfMock.mockResolvedValue({ pageCount: 2, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      // The clear of the old pages, then one per page.
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      expect(prisma.bookPage.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.bookPage.create).toHaveBeenCalledTimes(2);
      const increments = prisma.bookChapter.update.mock.calls.filter(
        ([arg]) =>
          JSON.stringify((arg as { data: unknown }).data) ===
          JSON.stringify({ processedPages: { increment: 1 } }),
      );
      expect(increments).toHaveLength(2);
    });

    it('a retry of the SAME file resumes: nothing is cleared and only the missing pages are converted', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue({
        ...convertedChapter('etag-same'),
        status: ChapterStatus.FAILED,
        pageCount: 3,
        processedPages: 1,
      });
      minioService.downloadFile.mockResolvedValue({ etag: 'etag-same' });
      prisma.bookPage.findMany.mockResolvedValue([{ pageNumber: 1 }]);
      probePdfMock.mockResolvedValue({ pageCount: 3, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(prisma.bookPage.deleteMany).not.toHaveBeenCalled();
      expect(minioService.deleteByPrefix).not.toHaveBeenCalled();
      expect(
        renderMock.mock.calls.map(([, page]) => page as number).sort(),
      ).toEqual([2, 3]);
      const tag = pagesFolderTag('etag-same');
      for (const [key] of minioService.uploadBuffer.mock.calls) {
        expect(key).toMatch(
          new RegExp(`^${PAGES_PREFIX}v-${tag}/page-00[23]\\.webp$`),
        );
      }
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: { pageCount: 3, processedPages: 1, pagesSourceEtag: 'etag-same' },
      });
    });

    it('pages made before the source was tracked (no recorded ETag) are never trusted — converted from scratch', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(convertedChapter(null));
      prisma.bookPage.findMany.mockResolvedValue(
        [1, 2, 3].map((pageNumber) => ({ pageNumber })),
      );
      probePdfMock.mockResolvedValue({ pageCount: 3, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(prisma.bookPage.deleteMany).toHaveBeenCalled();
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(PAGES_PREFIX);
      expect(renderMock).toHaveBeenCalledTimes(3);
    });

    it('a server that reports no ETag can never resume — every run starts clean', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(convertedChapter(null));
      minioService.downloadFile.mockResolvedValue({ etag: null });
      probePdfMock.mockResolvedValue({ pageCount: 1, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(PAGES_PREFIX);
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: { pageCount: 1, processedPages: 0, pagesSourceEtag: null },
      });
    });

    it('if the old objects cannot be removed, the run FAILS without recording the new file, so the next start clears again', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        convertedChapter('etag-old'),
      );
      minioService.deleteByPrefix.mockRejectedValue(new Error('minio down'));
      probePdfMock.mockResolvedValue({ pageCount: 2, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(renderMock).not.toHaveBeenCalled();
      expect(minioService.uploadBuffer).not.toHaveBeenCalled();
      const recorded = prisma.bookChapter.update.mock.calls.filter(
        ([args]: [{ data: { pagesSourceEtag?: string | null } }]) =>
          args.data.pagesSourceEtag === 'etag-new',
      );
      expect(recorded).toHaveLength(0);
      expect(prisma.bookChapter.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ChapterStatus.FAILED }),
        }),
      );
    });

    it('if the NEW file fails half way, the chapter holds only that file’s pages (recorded against its ETag, so a retry resumes it) and is FAILED — never a mix with the old file', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        convertedChapter('etag-old'),
      );
      probePdfMock.mockResolvedValue({ pageCount: 3, pageSizes: new Map() });
      renderMock.mockImplementation(
        (_pdf: string, page: number, base: string) =>
          page === 2
            ? Promise.reject(new Error('pdftoppm crashed'))
            : Promise.resolve(`${base}-${page}.png`),
      );

      await service.processChapter(CHAPTER_ID);

      // The old file's rows and objects went before anything new was written.
      expect(events.slice(0, 2)).toEqual([
        'rows-cleared',
        `objects-cleared:${PAGES_PREFIX}`,
      ]);
      // Whatever did get written belongs to the new file's own folder.
      const tag = pagesFolderTag('etag-new');
      for (const [key] of minioService.uploadBuffer.mock.calls) {
        expect(key).toMatch(new RegExp(`^${PAGES_PREFIX}v-${tag}/`));
      }
      // The new file is the recorded source, with its own page count, so the
      // retry of this same file resumes instead of clearing again.
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: { pageCount: 3, processedPages: 0, pagesSourceEtag: 'etag-new' },
      });
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: {
          status: ChapterStatus.FAILED,
          processingError: 'pdftoppm crashed',
        },
      });
      expect(prisma.bookChapter.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ChapterStatus.READY } }),
      );
    });

    it('records how many old pages a replace removed on the completion audit event', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        convertedChapter('etag-old'),
      );
      prisma.bookPage.deleteMany.mockResolvedValue({ count: 3 });
      probePdfMock.mockResolvedValue({ pageCount: 0, pageSizes: new Map() });

      await service.processChapter(CHAPTER_ID);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'book_chapter.status_change',
          metadata: expect.objectContaining({
            trigger: 'pdf_conversion_complete',
            previousPagesRemoved: 3,
          }),
        }),
      );
    });

    it('the folder tag is a pure function of the ETag: same file, same folder; different file, different folder', () => {
      expect(pagesFolderTag('etag-a')).toBe(pagesFolderTag('etag-a'));
      expect(pagesFolderTag('etag-a')).not.toBe(pagesFolderTag('etag-b'));
      expect(pagesFolderTag('etag-a')).toMatch(/^[0-9a-f]{16}$/);
      // No ETag: a one-off folder, never shared with another run.
      expect(pagesFolderTag(null)).not.toBe(pagesFolderTag(null));
    });
  });

  describe('input caps and the process-wide conversion limit (M-9 / M-24)', () => {
    const ORIGINAL_ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it('fails a PDF over the document budget from its HEAD alone — nothing is downloaded, no page renders', async () => {
      minioService.objectStat.mockResolvedValue({
        size: 500 * 1024 * 1024 + 1,
        etag: 'etag-huge',
      });

      await service.processChapter(CHAPTER_ID);

      expect(minioService.downloadFile).not.toHaveBeenCalled();
      expect(renderMock).not.toHaveBeenCalled();
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: {
          status: ChapterStatus.FAILED,
          processingError: expect.stringMatching(
            /a chapter PDF may be at most 500 MB/,
          ),
        },
      });
      expect(service.conversionLoad).toEqual({ active: 0, queued: 0 });
    });

    it('fails a chapter whose PDF is gone from storage without downloading', async () => {
      minioService.objectStat.mockResolvedValue(null);

      await service.processChapter(CHAPTER_ID);

      expect(minioService.downloadFile).not.toHaveBeenCalled();
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: {
          status: ChapterStatus.FAILED,
          processingError: expect.stringMatching(/No uploaded PDF/),
        },
      });
    });

    it('fails the chapter (and renders nothing) when the probe refuses the page count', async () => {
      probePdfMock.mockRejectedValue(
        new Error('The PDF has 2001 pages — a chapter may have at most 2000'),
      );

      await service.processChapter(CHAPTER_ID);

      expect(renderMock).not.toHaveBeenCalled();
      expect(prisma.bookChapter.update).toHaveBeenCalledWith({
        where: { id: CHAPTER_ID },
        data: {
          status: ChapterStatus.FAILED,
          processingError: expect.stringMatching(/at most 2000/),
        },
      });
    });

    it('renders an ordinary page at the standard DPI and a poster-sized page lower, per page', async () => {
      probePdfMock.mockResolvedValue({
        pageCount: 2,
        pageSizes: new Map([
          [1, { widthPt: 612, heightPt: 792 }],
          [2, { widthPt: 5760, heightPt: 5760 }],
        ]),
      });

      await service.processChapter(CHAPTER_ID);

      const dpiByPage = new Map(
        renderMock.mock.calls.map(
          ([, page, , dpi]) => [page as number, dpi as number] as const,
        ),
      );
      expect(dpiByPage.get(1)).toBe(PDF_RENDER_DPI);
      expect(dpiByPage.get(2)).toBe(50);
    });

    it('lets only BOOK_CONVERSION_CONCURRENCY chapters past the download at once; the rest wait and then run', async () => {
      process.env.BOOK_CONVERSION_CONCURRENCY = '1';
      // Each run blocks inside the download until the test lets it go.
      const gates: Array<() => void> = [];
      minioService.downloadFile.mockImplementation(
        () =>
          new Promise<{ etag: string }>((resolve) =>
            gates.push(() => resolve({ etag: 'etag-new' })),
          ),
      );
      prisma.bookChapter.findUnique.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({ ...chapterRow(), id: where.id }),
      );

      const first = service.processChapter('chapter-a');
      const second = service.processChapter('chapter-b');
      await new Promise((r) => setImmediate(r));

      // One past the slot (downloading), one queued behind it.
      expect(service.conversionLoad).toEqual({ active: 1, queued: 1 });
      expect(minioService.downloadFile).toHaveBeenCalledTimes(1);

      gates.shift()!();
      await first;
      await new Promise((r) => setImmediate(r));
      expect(service.conversionLoad).toEqual({ active: 1, queued: 0 });
      expect(minioService.downloadFile).toHaveBeenCalledTimes(2);

      gates.shift()!();
      await second;
      expect(service.conversionLoad).toEqual({ active: 0, queued: 0 });
    });

    it('gives its slot back when the run fails, so the next chapter is not stuck behind a dead one', async () => {
      process.env.BOOK_CONVERSION_CONCURRENCY = '1';
      probePdfMock.mockRejectedValue(new Error('pdfinfo blew up'));

      await service.processChapter(CHAPTER_ID);

      expect(service.conversionLoad).toEqual({ active: 0, queued: 0 });
    });
  });

  describe('ConversionSlots', () => {
    it('hands out `limit` slots at once and queues the rest in order', async () => {
      const slots = new ConversionSlots(() => 2);
      await slots.acquire();
      await slots.acquire();
      const order: string[] = [];
      const third = slots.acquire().then(() => order.push('third'));
      const fourth = slots.acquire().then(() => order.push('fourth'));
      await new Promise((r) => setImmediate(r));
      expect(slots.active).toBe(2);
      expect(slots.queued).toBe(2);

      slots.release();
      await third;
      expect(order).toEqual(['third']);
      slots.release();
      await fourth;
      expect(order).toEqual(['third', 'fourth']);
      expect(slots.active).toBe(2);
      expect(slots.queued).toBe(0);
    });
  });
});
