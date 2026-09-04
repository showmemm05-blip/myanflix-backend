import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BooksService } from './books.service';
import { BookProcessingService } from './book-processing.service';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { BookAuthorsService } from '../book-authors/book-authors.service';
import {
  BookStatus,
  BookType,
  ChapterStatus,
  Role,
} from '../generated/prisma/client';

const BOOK_ID = 'book-1';
const EDITION_ID = 'edition-my';
const CHAPTER_UUID = '11111111-1111-4111-8111-111111111111';

describe('BooksService', () => {
  let service: BooksService;
  let prisma: {
    book: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    bookEdition: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    bookChapter: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    bookPage: { findMany: jest.Mock };
    bookPart: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    bookSection: {
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    bookReadingProgress: { upsert: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let minioService: {
    canonicalImageUrl: jest.Mock;
    deleteByPrefix: jest.Mock;
    deleteObject: jest.Mock;
    keyFromPublicUrl: jest.Mock;
    objectSize: jest.Mock;
  };
  let bookProcessing: {
    processChapter: jest.Mock;
    isActivelyProcessing: jest.Mock;
  };
  let bookAuthors: {
    findByIdOrThrow: jest.Mock;
    findOrCreateByName: jest.Mock;
  };

  const AUTHOR_ROW = { id: 'author-1', name: 'An Author' };

  /** An edition row as the service's own guards load it. */
  const edition = (overrides: Record<string, unknown> = {}) => ({
    id: EDITION_ID,
    bookId: BOOK_ID,
    language: 'my',
    status: BookStatus.DRAFT,
    publishedAt: null,
    pdfKey: null,
    pdfFileSize: null,
    pageCount: 0,
    processedPages: 0,
    processingError: null,
    updatedAt: new Date(),
    book: { type: BookType.EDITOR },
    _count: { chapters: 1 },
    ...overrides,
  });

  const pdfEdition = (overrides: Record<string, unknown> = {}) =>
    edition({
      status: BookStatus.READY,
      pdfKey: `books/${BOOK_ID}/${EDITION_ID}/original.pdf`,
      pageCount: 12,
      processedPages: 12,
      book: { type: BookType.PDF },
      _count: { chapters: 1 },
      ...overrides,
    });

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      book: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      bookEdition: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      bookChapter: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findFirst: jest.fn(),
        // Chapter numbering reads the edition's chapters to place a row, so
        // the default is "no others" rather than undefined.
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      bookPage: { findMany: jest.fn() },
      // The hierarchy tables — empty by default, which is every existing book.
      bookPart: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      bookSection: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      bookReadingProgress: { upsert: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    minioService = {
      canonicalImageUrl: jest.fn((url: string | null) => url),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      keyFromPublicUrl: jest.fn(() => 'images/cover.webp'),
      objectSize: jest.fn().mockResolvedValue(1024),
    };
    bookProcessing = {
      processChapter: jest.fn().mockResolvedValue(undefined),
      isActivelyProcessing: jest.fn().mockReturnValue(false),
    };
    bookAuthors = {
      findByIdOrThrow: jest.fn().mockResolvedValue(AUTHOR_ROW),
      findOrCreateByName: jest.fn().mockResolvedValue(AUTHOR_ROW),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BooksService,
        { provide: PrismaService, useValue: prisma },
        { provide: MinioService, useValue: minioService },
        {
          provide: StorageService,
          useValue: {
            bookPdfKey: (b: string, e: string, c: string) =>
              `books/${b}/${e}/${c}/original.pdf`,
            bookEditionPrefix: (b: string, e: string) => `books/${b}/${e}`,
            bookChapterPrefix: (b: string, e: string, c: string) =>
              `books/${b}/${e}/${c}`,
          },
        },
        { provide: BookProcessingService, useValue: bookProcessing },
        { provide: BookAuthorsService, useValue: bookAuthors },
      ],
    }).compile();

    service = module.get(BooksService);
  });

  describe('create', () => {
    const base = {
      title: 'A Book',
      author: 'An Author',
      description: '',
      language: 'my',
    };

    it('creates the first language edition alongside the book', async () => {
      prisma.book.create.mockResolvedValue({ id: BOOK_ID });

      await service.create({ ...base, type: BookType.EDITOR });

      const data = prisma.book.create.mock.calls[0][0].data as {
        editions: { create: { language: string; status: BookStatus }[] };
      };
      expect(data.editions.create).toEqual([
        { language: 'my', status: BookStatus.DRAFT },
      ]);
    });

    it(
      'starts a PDF edition as a DRAFT too — a file now belongs to a chapter, ' +
        'so a fresh language has nothing to be uploading',
      async () => {
        prisma.book.create.mockResolvedValue({ id: BOOK_ID });

        await service.create({ ...base, type: BookType.PDF });

        const data = prisma.book.create.mock.calls[0][0].data as {
          editions: { create: { status: BookStatus }[] };
        };
        expect(data.editions.create[0].status).toBe(BookStatus.DRAFT);
      },
    );

    const authorDataOf = () =>
      prisma.book.create.mock.calls[0][0].data as {
        author?: string;
        authorId?: string;
        authorRef?: { connect: { id: string } };
      };

    it(
      'links the author row and copies its name into the display string — ' +
        'that string is what every existing client reads',
      async () => {
        prisma.book.create.mockResolvedValue({ id: BOOK_ID });
        bookAuthors.findByIdOrThrow.mockResolvedValue({
          id: 'author-9',
          name: 'Blake',
        });

        await service.create({
          title: 'A Book',
          authorId: 'author-9',
          description: '',
          language: 'my',
          type: BookType.EDITOR,
        });

        expect(bookAuthors.findByIdOrThrow).toHaveBeenCalledWith('author-9');
        expect(bookAuthors.findOrCreateByName).not.toHaveBeenCalled();
        expect(authorDataOf()).toMatchObject({
          author: 'Blake',
          authorRef: { connect: { id: 'author-9' } },
        });
        // The raw ids never reach Prisma as scalars — the relation does the linking.
        expect(authorDataOf().authorId).toBeUndefined();
      },
    );

    it('find-or-creates the author from a bare string and links it', async () => {
      prisma.book.create.mockResolvedValue({ id: BOOK_ID });

      await service.create({ ...base, type: BookType.EDITOR });

      expect(bookAuthors.findOrCreateByName).toHaveBeenCalledWith('An Author');
      expect(authorDataOf()).toMatchObject({
        author: 'An Author',
        authorRef: { connect: { id: 'author-1' } },
      });
    });

    it('lets authorId win when both are sent', async () => {
      prisma.book.create.mockResolvedValue({ id: BOOK_ID });
      bookAuthors.findByIdOrThrow.mockResolvedValue({
        id: 'author-9',
        name: 'Blake',
      });

      await service.create({
        ...base,
        author: 'Ignored Name',
        authorId: 'author-9',
        type: BookType.EDITOR,
      });

      expect(bookAuthors.findOrCreateByName).not.toHaveBeenCalled();
      expect(authorDataOf().author).toBe('Blake');
    });

    it('turns an unknown authorId into a 400, not a 404 about the book', async () => {
      bookAuthors.findByIdOrThrow.mockRejectedValue(
        new NotFoundException('Book author not found'),
      );

      await expect(
        service.create({
          title: 'A Book',
          authorId: 'missing',
          description: '',
          language: 'my',
          type: BookType.EDITOR,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.book.create).not.toHaveBeenCalled();
    });
  });

  describe('update — author', () => {
    beforeEach(() => {
      prisma.book.findUnique.mockResolvedValue({ id: BOOK_ID });
      prisma.book.update.mockResolvedValue({ id: BOOK_ID });
    });

    const dataOf = () =>
      prisma.book.update.mock.calls[0][0].data as Record<string, unknown>;

    it('leaves the author untouched when the edit does not mention it', async () => {
      await service.update(BOOK_ID, { title: 'Renamed' });

      expect(bookAuthors.findByIdOrThrow).not.toHaveBeenCalled();
      expect(bookAuthors.findOrCreateByName).not.toHaveBeenCalled();
      expect(dataOf().author).toBeUndefined();
      expect(dataOf().authorRef).toBeUndefined();
      expect(dataOf().authorId).toBeUndefined();
    });

    it('re-links and rewrites the display string when authorId is given', async () => {
      bookAuthors.findByIdOrThrow.mockResolvedValue({
        id: 'author-9',
        name: 'Blake',
      });

      await service.update(BOOK_ID, { authorId: 'author-9' });

      expect(dataOf()).toMatchObject({
        author: 'Blake',
        authorRef: { connect: { id: 'author-9' } },
      });
      expect(dataOf().authorId).toBeUndefined();
    });

    it('still accepts the legacy bare string on update', async () => {
      await service.update(BOOK_ID, { author: 'An Author' });

      expect(bookAuthors.findOrCreateByName).toHaveBeenCalledWith('An Author');
      expect(dataOf()).toMatchObject({
        author: 'An Author',
        authorRef: { connect: { id: 'author-1' } },
      });
    });
  });

  describe('findAll — visibility', () => {
    const whereOf = () =>
      (prisma.book.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }).where;
    const includeOf = () =>
      prisma.book.findMany.mock.calls[0][0] as {
        include: { editions: { where?: unknown } };
      };

    beforeEach(() => prisma.$transaction.mockResolvedValue([[], 0]));

    it('shows a user only books that have a published edition', async () => {
      await service.findAll({ status: BookStatus.DRAFT }, Role.USER);

      expect(whereOf().editions).toEqual({
        some: { status: BookStatus.PUBLISHED },
      });
    });

    it('hides a user the languages that are still drafts', async () => {
      await service.findAll({}, Role.USER);

      expect(includeOf().include.editions.where).toEqual({
        status: BookStatus.PUBLISHED,
      });
    });

    it('lets staff see every edition of every book', async () => {
      await service.findAll({}, Role.ADMIN);

      expect(includeOf().include.editions.where).toBeUndefined();
    });

    it('lets staff filter by an edition status', async () => {
      await service.findAll({ status: BookStatus.FAILED }, Role.ADMIN);

      expect(whereOf().editions).toEqual({
        some: { status: BookStatus.FAILED },
      });
    });

    it(
      'combines a language filter WITH the published rule for a user — a ' +
        'Burmese search must not surface a book published only in English',
      async () => {
        await service.findAll({ language: 'my' }, Role.USER);

        expect(whereOf().editions).toEqual({
          some: { status: BookStatus.PUBLISHED, language: 'my' },
        });
      },
    );

    it('searches title, author and description case-insensitively', async () => {
      await service.findAll({ search: 'ocean' }, Role.ADMIN);

      expect(whereOf().OR).toEqual([
        { title: { contains: 'ocean', mode: 'insensitive' } },
        { author: { contains: 'ocean', mode: 'insensitive' } },
        { description: { contains: 'ocean', mode: 'insensitive' } },
      ]);
    });
  });

  describe('findByIdOrThrow', () => {
    it('404s a book whose every language is still unpublished, for a user', async () => {
      prisma.book.findUnique.mockResolvedValue({ id: BOOK_ID, editions: [] });

      await expect(
        service.findByIdOrThrow(BOOK_ID, Role.USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns it for staff, editions and all', async () => {
      prisma.book.findUnique.mockResolvedValue({
        id: BOOK_ID,
        editions: [edition()],
      });

      await expect(
        service.findByIdOrThrow(BOOK_ID, Role.ADMIN),
      ).resolves.toMatchObject({ id: BOOK_ID });
    });
  });

  describe('addEdition', () => {
    it('refuses a language the book already has', async () => {
      prisma.book.findUnique.mockResolvedValue({ type: BookType.EDITOR });
      prisma.bookEdition.findUnique.mockResolvedValue({ id: EDITION_ID });

      await expect(
        service.addEdition(BOOK_ID, { language: 'my' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.bookEdition.create).not.toHaveBeenCalled();
    });

    it('starts a new language empty, whatever the book type', async () => {
      prisma.book.findUnique.mockResolvedValue({ type: BookType.PDF });
      prisma.bookEdition.findUnique.mockResolvedValue(null);
      prisma.bookEdition.create.mockResolvedValue(pdfEdition());

      await service.addEdition(BOOK_ID, { language: 'en' });

      expect(prisma.bookEdition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            bookId: BOOK_ID,
            language: 'en',
            status: BookStatus.DRAFT,
          },
        }),
      );
    });
  });

  describe('updateEdition — status transitions', () => {
    it('refuses to publish a language with nothing readable in it', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.count.mockResolvedValue(0);

      await expect(
        service.updateEdition(BOOK_ID, EDITION_ID, {
          status: BookStatus.PUBLISHED,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookEdition.update).not.toHaveBeenCalled();
    });

    it(
      'refuses to publish a PDF language whose only chapter is still ' +
        'converting — READY chapters are what counts, not chapter rows',
      async () => {
        prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
        prisma.bookChapter.count.mockResolvedValue(0);

        await expect(
          service.updateEdition(BOOK_ID, EDITION_ID, {
            status: BookStatus.PUBLISHED,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it(
      'publishes on the FIRST ready chapter — a serialised title goes live ' +
        'while later chapters are still converting',
      async () => {
        prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
        prisma.bookChapter.count.mockResolvedValue(1);
        prisma.bookEdition.update.mockResolvedValue(pdfEdition());

        await service.updateEdition(BOOK_ID, EDITION_ID, {
          status: BookStatus.PUBLISHED,
        });

        expect(prisma.bookEdition.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: BookStatus.PUBLISHED }),
          }),
        );
      },
    );

    it('refuses to hand-walk an edition into a conversion state', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());

      await expect(
        service.updateEdition(BOOK_ID, EDITION_ID, {
          status: BookStatus.PROCESSING,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('publishes one language without touching the others', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.count.mockResolvedValue(1);
      prisma.bookEdition.update.mockResolvedValue(edition());

      await service.updateEdition(BOOK_ID, EDITION_ID, {
        status: BookStatus.PUBLISHED,
      });

      expect(prisma.bookEdition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: EDITION_ID },
          data: expect.objectContaining({
            status: BookStatus.PUBLISHED,
            publishedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('keeps the original publishedAt when republishing', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        edition({ publishedAt: new Date('2026-01-01') }),
      );
      prisma.bookChapter.count.mockResolvedValue(1);
      prisma.bookEdition.update.mockResolvedValue(edition());

      await service.updateEdition(BOOK_ID, EDITION_ID, {
        status: BookStatus.PUBLISHED,
      });

      const data = prisma.bookEdition.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.publishedAt).toBeUndefined();
    });

    it('refuses to rename a language onto one the book already has', async () => {
      prisma.bookEdition.findUnique
        .mockResolvedValueOnce(edition())
        .mockResolvedValueOnce({ id: 'edition-en' });

      await expect(
        service.updateEdition(BOOK_ID, EDITION_ID, { language: 'en' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s an edition belonging to a different book', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        edition({ bookId: 'someone-else' }),
      );

      await expect(
        service.updateEdition(BOOK_ID, EDITION_ID, { language: 'en' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeEdition', () => {
    it('refuses to remove the last language — delete the book instead', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookEdition.count.mockResolvedValue(1);

      await expect(
        service.removeEdition(BOOK_ID, EDITION_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookEdition.delete).not.toHaveBeenCalled();
    });

    it('deletes the row and that language\'s objects only', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookEdition.count.mockResolvedValue(2);

      await service.removeEdition(BOOK_ID, EDITION_ID);

      expect(prisma.bookEdition.delete).toHaveBeenCalledWith({
        where: { id: EDITION_ID },
      });
      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(
        `books/${BOOK_ID}/${EDITION_ID}/`,
      );
    });
  });

  describe('remove', () => {
    it(
      'deletes the row first and then best-effort cleans storage — a leaked ' +
        'object must never block the catalog removal',
      async () => {
        prisma.book.findUnique.mockResolvedValue({
          id: BOOK_ID,
          coverUrl: 'http://cache/movies/images/cover.webp',
        });
        minioService.deleteByPrefix.mockRejectedValue(new Error('storage down'));

        await expect(service.remove(BOOK_ID)).resolves.toBeUndefined();

        expect(prisma.book.delete).toHaveBeenCalledWith({
          where: { id: BOOK_ID },
        });
      },
    );

    it('reaches every language with one prefix delete', async () => {
      prisma.book.findUnique.mockResolvedValue({ id: BOOK_ID, coverUrl: null });

      await service.remove(BOOK_ID);

      expect(minioService.deleteByPrefix).toHaveBeenCalledWith(
        `books/${BOOK_ID}/`,
      );
    });

    it('404s an unknown book instead of silently succeeding', async () => {
      prisma.book.findUnique.mockResolvedValue(null);
      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('startProcessing', () => {
    /** A chapter row as the service loads it before converting. */
    const chapter = (over: Record<string, unknown> = {}) => ({
      id: CHAPTER_UUID,
      editionId: EDITION_ID,
      status: ChapterStatus.DRAFT,
      pdfKey: `books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_UUID}/original.pdf`,
      pdfFileSize: null,
      pageCount: 0,
      processedPages: 0,
      processingError: null,
      updatedAt: new Date(),
      ...over,
    });

    beforeEach(() => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
    });

    it('refuses when no PDF has actually been uploaded yet', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        chapter({ pdfKey: null }),
      );
      minioService.objectSize.mockResolvedValue(null);

      await expect(
        service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(bookProcessing.processChapter).not.toHaveBeenCalled();
    });

    it('refuses a second run while this process is genuinely converting', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        chapter({ status: ChapterStatus.PROCESSING }),
      );
      bookProcessing.isActivelyProcessing.mockReturnValue(true);

      await expect(
        service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it(
      'allows a retry of a chapter stuck at PROCESSING that nothing is ' +
        'working on — the orphan-recovery path after a crash or redeploy',
      async () => {
        prisma.bookChapter.findUnique.mockResolvedValue(
          chapter({ status: ChapterStatus.PROCESSING }),
        );
        bookProcessing.isActivelyProcessing.mockReturnValue(false);

        await service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID);

        expect(bookProcessing.processChapter).toHaveBeenCalledWith(CHAPTER_UUID);
      },
    );

    it('records the uploaded size against the CHAPTER', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(chapter());
      minioService.objectSize.mockResolvedValue(4096);

      await service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID);

      expect(prisma.bookChapter.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CHAPTER_UUID },
          data: expect.objectContaining({ pdfFileSize: BigInt(4096) }),
        }),
      );
    });

    it(
      'lets a published book take a new chapter — publishing is per language, ' +
        'and a live serialised title is exactly where the next release lands',
      async () => {
        prisma.bookEdition.findUnique.mockResolvedValue(
          pdfEdition({ status: BookStatus.PUBLISHED }),
        );
        prisma.bookChapter.findUnique.mockResolvedValue(chapter());

        await service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID);

        expect(bookProcessing.processChapter).toHaveBeenCalledWith(CHAPTER_UUID);
      },
    );

    it('refuses on a written book, which has no conversion', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());

      await expect(
        service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a chapter belonging to a different language', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue(
        chapter({ editionId: 'edition-en' }),
      );

      await expect(
        service.startProcessing(BOOK_ID, EDITION_ID, CHAPTER_UUID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getProcessingStatus', () => {
    beforeEach(() => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
    });

    it('derives a real percentage from converted pages, unlike the video pipeline', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue({
        id: CHAPTER_UUID,
        editionId: EDITION_ID,
        title: 'Ch. 1',
        order: 1,
        status: ChapterStatus.PROCESSING,
        pageCount: 200,
        processedPages: 50,
        processingError: null,
        pdfFileSize: BigInt(9000),
        updatedAt: new Date(),
      });

      const status = await service.getProcessingStatus(
        BOOK_ID,
        EDITION_ID,
        CHAPTER_UUID,
      );

      expect(status.percent).toBe(25);
      expect(status.pdfFileSize).toBe(9000);
      expect(status.title).toBe('Ch. 1');
    });

    it('reports 0% rather than NaN before the PDF has been probed', async () => {
      prisma.bookChapter.findUnique.mockResolvedValue({
        id: CHAPTER_UUID,
        editionId: EDITION_ID,
        title: 'Ch. 1',
        order: 1,
        status: ChapterStatus.DRAFT,
        pageCount: 0,
        processedPages: 0,
        processingError: null,
        pdfFileSize: null,
        updatedAt: new Date(),
      });

      expect(
        (await service.getProcessingStatus(BOOK_ID, EDITION_ID, CHAPTER_UUID))
          .percent,
      ).toBe(0);
    });
  });

  describe('reorderChapters', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    beforeEach(() => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      // Read twice: once for the complete-set check, once by the
      // renormaliser after the writes (which the mock does not apply, so it
      // sees a contiguous, part-less order and has nothing to do).
      prisma.bookChapter.findMany.mockResolvedValue([
        { id: 'c1', partId: null, order: 1, createdAt: t },
        { id: 'c2', partId: null, order: 2, createdAt: t },
        { id: 'c3', partId: null, order: 3, createdAt: t },
      ]);
    });

    it('renumbers every chapter sequentially from the submitted order', async () => {
      await service.reorderChapters(BOOK_ID, EDITION_ID, {
        chapterIds: ['c3', 'c1', 'c2'],
      });

      expect(prisma.bookChapter.update.mock.calls.map((c) => c[0])).toEqual([
        { where: { id: 'c3' }, data: { order: 1 } },
        { where: { id: 'c1' }, data: { order: 2 } },
        { where: { id: 'c2' }, data: { order: 3 } },
      ]);
    });

    it(
      'issues exactly the index+1 writes and nothing else for a part-less ' +
        'edition — the byte-for-byte guard for every existing book',
      async () => {
        await service.reorderChapters(BOOK_ID, EDITION_ID, {
          chapterIds: ['c1', 'c2', 'c3'],
        });

        expect(prisma.bookChapter.update).toHaveBeenCalledTimes(3);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.bookPart.update).not.toHaveBeenCalled();
      },
    );

    it('rejects a partial list — a full-set renumber is what keeps this idempotent', async () => {
      await expect(
        service.reorderChapters(BOOK_ID, EDITION_ID, {
          chapterIds: ['c1', 'c2'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookChapter.update).not.toHaveBeenCalled();
    });
  });

  describe('chapters are per edition', () => {
    it(
      'gives a PDF chapter a DRAFT status and no content — it is waiting for ' +
        'a file, which is the whole point of per-chapter releases',
      async () => {
        prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
        prisma.bookChapter.findFirst.mockResolvedValue(null);
        prisma.bookChapter.create.mockResolvedValue({ id: 'c1' });

        await service.createChapter(BOOK_ID, EDITION_ID, { title: 'Ch. 1' });

        expect(prisma.bookChapter.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: ChapterStatus.DRAFT,
              content: undefined,
              order: 1,
            }),
          }),
        );
      },
    );

    it('gives a written chapter READY status straight away', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.findFirst.mockResolvedValue(null);
      prisma.bookChapter.create.mockResolvedValue({ id: 'c1' });

      await service.createChapter(BOOK_ID, EDITION_ID, {
        title: 'One',
        content: {},
      });

      expect(prisma.bookChapter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ChapterStatus.READY }),
        }),
      );
    });

    it('stores a chapter cover for either type', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
      prisma.bookChapter.findFirst.mockResolvedValue(null);
      prisma.bookChapter.create.mockResolvedValue({ id: 'c1' });

      await service.createChapter(BOOK_ID, EDITION_ID, {
        title: 'Ch. 1',
        imageUrl: 'http://cache/movies/images/ch1.webp',
      });

      expect(prisma.bookChapter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            imageUrl: 'http://cache/movies/images/ch1.webp',
          }),
        }),
      );
    });

    it('numbers a new chapter after the last one IN THAT LANGUAGE', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.findFirst.mockResolvedValue({ order: 7 });
      prisma.bookChapter.create.mockResolvedValue({ id: 'c8' });

      await service.createChapter(BOOK_ID, EDITION_ID, {
        title: 'Eight',
        content: {},
      });

      expect(prisma.bookChapter.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { editionId: EDITION_ID } }),
      );
      expect(prisma.bookChapter.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ editionId: EDITION_ID, order: 8 }),
        }),
      );
    });
  });

  describe('updateReadingProgress', () => {
    const published = (over: Record<string, unknown> = {}) =>
      edition({ status: BookStatus.PUBLISHED, ...over });

    it('rejects a page number on a written edition', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(published());

      await expect(
        service.updateReadingProgress(
          'u1',
          BOOK_ID,
          EDITION_ID,
          { pageNumber: 3, progress: 10 },
          Role.USER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a chapter id on a PDF edition', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        published({ book: { type: BookType.PDF } }),
      );

      await expect(
        service.updateReadingProgress(
          'u1',
          BOOK_ID,
          EDITION_ID,
          { chapterId: CHAPTER_UUID, progress: 10 },
          Role.USER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a chapter belonging to a different language', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(published());
      prisma.bookChapter.findUnique.mockResolvedValue({
        editionId: 'edition-en',
      });

      await expect(
        service.updateReadingProgress(
          'u1',
          BOOK_ID,
          EDITION_ID,
          { chapterId: CHAPTER_UUID, progress: 10 },
          Role.USER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('upserts on (userId, editionId) — one bookmark per reader per language', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        published({ book: { type: BookType.PDF } }),
      );
      prisma.bookReadingProgress.upsert.mockResolvedValue({});

      await service.updateReadingProgress(
        'u1',
        BOOK_ID,
        EDITION_ID,
        { pageNumber: 42, progress: 35 },
        Role.USER,
      );

      expect(prisma.bookReadingProgress.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_editionId: { userId: 'u1', editionId: EDITION_ID } },
          update: {
            chapterId: null,
            pageNumber: 42,
            sectionId: null,
            progress: 35,
          },
        }),
      );
    });

    it('hides an unpublished language from a regular reader', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        edition({ status: BookStatus.READY, book: { type: BookType.PDF } }),
      );

      await expect(
        service.updateReadingProgress(
          'u1',
          BOOK_ID,
          EDITION_ID,
          { pageNumber: 1, progress: 1 },
          Role.USER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still lets staff read an unpublished language, to proof it', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(
        edition({ status: BookStatus.DRAFT, book: { type: BookType.PDF } }),
      );
      prisma.bookReadingProgress.upsert.mockResolvedValue({});

      await expect(
        service.updateReadingProgress(
          'admin',
          BOOK_ID,
          EDITION_ID,
          { pageNumber: 1, progress: 1 },
          Role.ADMIN,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('hierarchy — parts on chapters', () => {
    const PART_UUID = '22222222-2222-4222-8222-222222222222';
    const t = new Date('2026-01-01T00:00:00Z');

    it('refuses a partId from another edition with a 400, before writing', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookPart.findUnique.mockResolvedValue({ editionId: 'edition-en' });

      await expect(
        service.createChapter(BOOK_ID, EDITION_ID, {
          title: 'One',
          content: {},
          partId: PART_UUID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookChapter.create).not.toHaveBeenCalled();
    });

    it('leaves a part-less create exactly as it was — no partId key in the write', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.findFirst.mockResolvedValue(null);
      prisma.bookChapter.create.mockResolvedValue({ id: 'c1', order: 1 });

      const created = await service.createChapter(BOOK_ID, EDITION_ID, {
        title: 'One',
        content: {},
      });

      expect(prisma.bookChapter.create.mock.calls[0][0].data).not.toHaveProperty(
        'partId',
      );
      expect(created.number).toBe('1');
      expect(created.sections).toEqual([]);
    });

    it('regroups the reading order when a chapter moves into a part, writing only the rows that moved', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookPart.findUnique.mockResolvedValue({ editionId: EDITION_ID });
      // The chapter being moved (c3) was unparted at the end.
      prisma.bookChapter.findUnique
        .mockResolvedValueOnce({ editionId: EDITION_ID, partId: null })
        .mockResolvedValue({
          id: 'c3',
          editionId: EDITION_ID,
          partId: PART_UUID,
          order: 1,
          createdAt: t,
          pageCount: 0,
        });
      prisma.bookChapter.update.mockResolvedValue({ id: 'c3' });
      prisma.bookPart.findMany.mockResolvedValue([
        { id: PART_UUID, title: 'Part One', order: 1, createdAt: t },
      ]);
      // After the update: c1 in the part, c2 unparted, c3 now in the part.
      prisma.bookChapter.findMany.mockResolvedValue([
        { id: 'c1', partId: PART_UUID, order: 1, createdAt: t, pageCount: 0 },
        { id: 'c2', partId: null, order: 2, createdAt: t, pageCount: 0 },
        { id: 'c3', partId: PART_UUID, order: 3, createdAt: t, pageCount: 0 },
      ]);

      await service.updateChapter(BOOK_ID, EDITION_ID, 'c3', {
        partId: PART_UUID,
      });

      // Canonical: c2 (unparted) first, then c1, c3 — c3 keeps 3.
      const orderWrites = prisma.bookChapter.update.mock.calls
        .map((c) => c[0])
        .filter((call) => 'order' in call.data);
      expect(orderWrites).toEqual([
        { where: { id: 'c2' }, data: { order: 1 } },
        { where: { id: 'c1' }, data: { order: 2 } },
      ]);
    });

    it('renormalises after a part is deleted, so its chapters surface unparted', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookPart.findUnique.mockResolvedValue({
        id: PART_UUID,
        editionId: EDITION_ID,
      });
      prisma.bookPart.findMany.mockResolvedValue([]);
      prisma.bookChapter.findMany.mockResolvedValue([
        { id: 'c1', partId: null, order: 2, createdAt: t },
        { id: 'c2', partId: null, order: 1, createdAt: t },
      ]);

      await service.deletePart(BOOK_ID, EDITION_ID, PART_UUID);

      expect(prisma.bookPart.delete).toHaveBeenCalledWith({
        where: { id: PART_UUID },
      });
      // Already contiguous — the delete needs no renumbering writes.
      expect(prisma.bookChapter.update).not.toHaveBeenCalled();
      expect(prisma.bookChapter.findMany).toHaveBeenCalled();
    });
  });

  describe('hierarchy — sections', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    const pdfChapter = (over: Record<string, unknown> = {}) => ({
      id: CHAPTER_UUID,
      editionId: EDITION_ID,
      partId: null,
      order: 1,
      createdAt: t,
      pageCount: 12,
      ...over,
    });

    it('rejects a PDF section whose start page is outside 1..pageCount', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
      prisma.bookChapter.findUnique.mockResolvedValue(pdfChapter());

      await expect(
        service.createSection(BOOK_ID, EDITION_ID, CHAPTER_UUID, {
          title: 'S',
          startPage: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createSection(BOOK_ID, EDITION_ID, CHAPTER_UUID, {
          title: 'S',
          startPage: 13,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookSection.create).not.toHaveBeenCalled();
    });

    it('rejects a PDF section that starts on a page another section already starts on', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
      prisma.bookChapter.findUnique.mockResolvedValue(pdfChapter());
      prisma.bookSection.findFirst.mockImplementation(
        ({ where }: { where: { startPage?: number } }) =>
          Promise.resolve(
            where?.startPage !== undefined ? { id: 's-old', title: 'Late' } : { order: 1 },
          ),
      );
      await expect(
        service.createSection(BOOK_ID, EDITION_ID, CHAPTER_UUID, { title: 'Dup', startPage: 9 }),
      ).rejects.toThrow(/already starts on page 9/);
      expect(prisma.bookSection.create).not.toHaveBeenCalled();
    });

    it('stores a valid PDF section and re-sorts the chapter by start page', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
      prisma.bookChapter.findUnique.mockResolvedValue(pdfChapter());
      // findFirst serves two queries now: the "last order" lookup and the
      // duplicate-start-page check (the one with startPage in its where).
      prisma.bookSection.findFirst.mockImplementation(
        ({ where }: { where: { startPage?: number } }) =>
          Promise.resolve(where?.startPage !== undefined ? null : { order: 1 }),
      );
      prisma.bookSection.create.mockResolvedValue({ id: 's-new', order: 2 });
      const rows = [
        { id: 's-old', chapterId: CHAPTER_UUID, title: 'Late', order: 1, startPage: 9, content: null, createdAt: t, updatedAt: t },
        { id: 's-new', chapterId: CHAPTER_UUID, title: 'Early', order: 2, startPage: 3, content: null, createdAt: t, updatedAt: t },
      ];
      prisma.bookSection.findMany.mockResolvedValue(rows);

      const created = await service.createSection(
        BOOK_ID,
        EDITION_ID,
        CHAPTER_UUID,
        { title: 'Early', startPage: 3 },
      );

      expect(prisma.bookSection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ startPage: 3, order: 2 }),
        }),
      );
      // Sorted by page: the new one is first, so both rows swap order.
      expect(prisma.bookSection.update.mock.calls.map((c) => c[0])).toEqual([
        { where: { id: 's-new' }, data: { order: 1 } },
        { where: { id: 's-old' }, data: { order: 2 } },
      ]);
      expect(created.number).toBe('1.1');
      expect(created.endPage).toBe(8);
    });

    it('refuses a start page on a written chapter, and defaults its content to {}', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(edition());
      prisma.bookChapter.findUnique.mockResolvedValue(pdfChapter({ pageCount: 0 }));

      await expect(
        service.createSection(BOOK_ID, EDITION_ID, CHAPTER_UUID, {
          title: 'S',
          startPage: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      prisma.bookSection.findFirst.mockResolvedValue(null);
      prisma.bookSection.create.mockResolvedValue({ id: 's1' });
      prisma.bookSection.findMany.mockResolvedValue([
        { id: 's1', chapterId: CHAPTER_UUID, title: 'S', order: 1, startPage: null, content: {}, createdAt: t, updatedAt: t },
      ]);

      const created = await service.createSection(
        BOOK_ID,
        EDITION_ID,
        CHAPTER_UUID,
        { title: 'S' },
      );

      expect(prisma.bookSection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ content: {}, startPage: undefined, order: 1 }),
        }),
      );
      expect(created.number).toBe('1.1');
      expect(created.endPage).toBeNull();
    });

    it('refuses to reorder the sections of a PDF chapter — their pages decide', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(pdfEdition());
      prisma.bookChapter.findUnique.mockResolvedValue(pdfChapter());

      await expect(
        service.reorderSections(BOOK_ID, EDITION_ID, CHAPTER_UUID, {
          sectionIds: ['s1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookSection.update).not.toHaveBeenCalled();
    });
  });

  describe('hierarchy — reading progress remembers the section', () => {
    const SECTION_UUID = '33333333-3333-4333-8333-333333333333';
    const OTHER_CHAPTER = '44444444-4444-4444-8444-444444444444';
    const published = () => edition({ status: BookStatus.PUBLISHED });

    it('rejects a section that belongs to a different chapter than the one sent', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(published());
      prisma.bookChapter.findUnique.mockResolvedValue({ editionId: EDITION_ID });
      prisma.bookSection.findUnique.mockResolvedValue({
        chapterId: OTHER_CHAPTER,
        chapter: { editionId: EDITION_ID },
      });

      await expect(
        service.updateReadingProgress(
          'u1',
          BOOK_ID,
          EDITION_ID,
          { chapterId: CHAPTER_UUID, sectionId: SECTION_UUID, progress: 10 },
          Role.USER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.bookReadingProgress.upsert).not.toHaveBeenCalled();
    });

    it('writes the section alongside the chapter when it fits', async () => {
      prisma.bookEdition.findUnique.mockResolvedValue(published());
      prisma.bookChapter.findUnique.mockResolvedValue({ editionId: EDITION_ID });
      prisma.bookSection.findUnique.mockResolvedValue({
        chapterId: CHAPTER_UUID,
        chapter: { editionId: EDITION_ID },
      });
      prisma.bookReadingProgress.upsert.mockResolvedValue({});

      await service.updateReadingProgress(
        'u1',
        BOOK_ID,
        EDITION_ID,
        { chapterId: CHAPTER_UUID, sectionId: SECTION_UUID, progress: 10 },
        Role.USER,
      );

      expect(prisma.bookReadingProgress.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            chapterId: CHAPTER_UUID,
            pageNumber: null,
            sectionId: SECTION_UUID,
            progress: 10,
          },
        }),
      );
    });
  });
});
