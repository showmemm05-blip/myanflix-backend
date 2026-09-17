import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { BookProcessingService } from './book-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { probePdf, renderPdfPageToPng } from './pdf.util';
import { BookType, ChapterStatus } from '../generated/prisma/client';

jest.mock('./pdf.util', () => ({
  probePdf: jest.fn(),
  renderPdfPageToPng: jest.fn(),
}));

jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('node:fs/promises', () => ({
  rm: jest.fn().mockResolvedValue(undefined),
}));

const probePdfMock = probePdf as jest.Mock;
const rmMock = rm as unknown as jest.Mock;
void renderPdfPageToPng; // mocked so the pipeline never shells out to pdftoppm

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
  edition: { id: EDITION_ID, book: { id: BOOK_ID, type: BookType.PDF } },
});

describe('BookProcessingService', () => {
  let service: BookProcessingService;
  let prisma: {
    bookChapter: { findUnique: jest.Mock; update: jest.Mock };
    bookPage: { findMany: jest.Mock; create: jest.Mock };
  };
  let minioService: { downloadFile: jest.Mock; uploadBuffer: jest.Mock };
  let storageService: {
    bookScratchDir: jest.Mock;
    ensureDir: jest.Mock;
    bookPageKey: jest.Mock;
  };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

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
        create: jest.fn(),
      },
    };
    minioService = {
      downloadFile: jest.fn().mockResolvedValue(undefined),
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      bookScratchDir: jest.fn(
        (bookId: string, editionId: string, chapterId: string) =>
          `/scratch/temp/documents/books/${bookId}/${editionId}/${chapterId}`,
      ),
      ensureDir: jest.fn().mockResolvedValue(undefined),
      bookPageKey: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    probePdfMock.mockResolvedValue({ pageCount: 0 });

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
});
