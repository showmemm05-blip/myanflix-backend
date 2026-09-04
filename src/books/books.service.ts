import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BookStatus,
  BookType,
  ChapterStatus,
  Prisma,
  Role,
  type Book,
  type BookChapter,
  type BookEdition,
  type BookPage,
  type BookPart,
  type BookReadingProgress,
  type BookCategory,
  type BookSection,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { BookAuthorsService } from '../book-authors/book-authors.service';
import { BookProcessingService } from './book-processing.service';
import type { BookQueryDto } from './dto/book-query.dto';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';
import type {
  CreateBookEditionDto,
  UpdateBookEditionDto,
} from './dto/edition.dto';
import type {
  CreateBookChapterDto,
  ReorderChaptersDto,
  UpdateBookChapterDto,
} from './dto/chapter.dto';
import type { UpdateReadingProgressDto } from './dto/reading-progress.dto';
import type {
  CreateBookPartDto,
  ReorderPartsDto,
  UpdateBookPartDto,
} from './dto/part.dto';
import type {
  CreateBookSectionDto,
  ReorderSectionsDto,
  UpdateBookSectionDto,
} from './dto/section.dto';
import {
  buildContentsTree,
  byPosition,
  normalizeReadingOrder as planReadingOrder,
  type ChapterRowLike,
  type ContentsTree,
  type NumberedChapter,
  type NumberedSection,
} from './book-numbering';

/**
 * What a reader is allowed to see. Staff browse every edition; a regular
 * user is only ever offered the languages that are actually published.
 */
const publishedOnly = (viewerRole: Role) => viewerRole === Role.USER;

const editionOrder = { language: 'asc' } as const;

const CATALOG_INCLUDE = {
  // The linked author, as the lightweight ref the response carries beside
  // the denormalised `author` string.
  authorRef: { select: { id: true, name: true, imageUrl: true } },
  categories: true,
  editions: {
    orderBy: editionOrder,
    include: {
      _count: { select: { chapters: true } },
      // How many chapters a reader could actually open. That — not the
      // chapter count — is what "can this language be published?" means now,
      // so the admin must not be left to guess it. Selected as ids rather
      // than a filtered _count because Prisma cannot alias two counts of the
      // same relation.
      chapters: {
        where: { status: ChapterStatus.READY },
        select: { id: true },
      },
    },
  },
} satisfies Prisma.BookInclude;

type EditionWithCounts = BookEdition & {
  _count: { chapters: number };
  /** Only the READY ones — see CATALOG_INCLUDE. */
  chapters: { id: string }[];
};

export type BookWithRelations = Book & {
  authorRef: { id: string; name: string; imageUrl: string | null } | null;
  categories: BookCategory[];
  editions: EditionWithCounts[];
};

/** A chapter row decorated by book-numbering: `number` and numbered `sections`. */
export type ChapterWithHierarchy = NumberedChapter<BookChapter, BookSection>;
export type SectionWithNumber = NumberedSection<BookSection>;
export type PartWithCounts = BookPart & {
  number: number;
  chapterCount: number;
};

/** The tie-break book-numbering uses, as Prisma orderBy — so DB and util agree. */
const positionOrder = () => [
  { order: 'asc' as const },
  { createdAt: 'asc' as const },
  { id: 'asc' as const },
];

@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
    private readonly bookProcessing: BookProcessingService,
    private readonly bookAuthors: BookAuthorsService,
  ) {}

  // ---------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------

  async findAll(query: BookQueryDto, viewerRole: Role) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.BookWhereInput = {};

    // A book has no status of its own any more: it is visible exactly when
    // one of its editions is published. Staff can instead filter by an
    // edition status to find work in progress.
    if (publishedOnly(viewerRole)) {
      where.editions = { some: { status: BookStatus.PUBLISHED } };
    } else if (query.readyToPublish) {
      // The review queue. Editions are never moved to READY by anything —
      // that vocabulary belongs to chapters now — so "ready to publish"
      // means: not yet live, but holding at least one chapter a reader
      // could open.
      where.editions = {
        some: {
          status: { not: BookStatus.PUBLISHED },
          chapters: { some: { status: ChapterStatus.READY } },
        },
      };
    } else if (query.status) {
      where.editions = { some: { status: query.status } };
    }

    if (query.language) {
      const languageFilter: Prisma.BookEditionWhereInput = {
        language: query.language,
      };
      if (publishedOnly(viewerRole))
        languageFilter.status = BookStatus.PUBLISHED;
      // Merged rather than overwritten, so "published AND in this language"
      // cannot degrade into "published in ANY language".
      where.editions = { some: { ...where.editions?.some, ...languageFilter } };
    }

    if (query.type) where.type = query.type;
    if (query.categoryId) where.categories = { some: { id: query.categoryId } };
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { author: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.book.findMany({
        where,
        include: this.catalogInclude(viewerRole),
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.book.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  /**
   * A regular user's payload must not leak the languages that are still
   * drafts, so the include filters editions for them too — matching the
   * book-level visibility rule above.
   */
  private catalogInclude(viewerRole: Role) {
    if (!publishedOnly(viewerRole)) return CATALOG_INCLUDE;
    return {
      ...CATALOG_INCLUDE,
      editions: {
        ...CATALOG_INCLUDE.editions,
        where: { status: BookStatus.PUBLISHED },
      },
    } satisfies Prisma.BookInclude;
  }

  async findByIdOrThrow(
    id: string,
    viewerRole: Role,
  ): Promise<BookWithRelations> {
    const book = await this.prisma.book.findUnique({
      where: { id },
      include: this.catalogInclude(viewerRole),
    });

    // For a user, a book with no published edition is indistinguishable from
    // a book that does not exist — the same rule the catalog applies.
    if (!book || (publishedOnly(viewerRole) && book.editions.length === 0)) {
      throw new NotFoundException('Book not found');
    }
    return book;
  }

  /**
   * Which BookAuthor row a create/update credits. `authorId` wins; a bare
   * `author` string is find-or-created by name so the legacy path still
   * lands on a row; neither means "leave it alone". Both the link and the
   * denormalised `author` string are written together — `book.author` must
   * always equal `authorRef.name`, because that string is what every
   * existing client reads.
   */
  private async resolveAuthor(dto: {
    author?: string;
    authorId?: string;
  }): Promise<{ id: string; name: string } | null> {
    if (dto.authorId) {
      try {
        return await this.bookAuthors.findByIdOrThrow(dto.authorId);
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new BadRequestException(
            'authorId does not match any book author',
          );
        }
        throw error;
      }
    }
    if (dto.author?.trim()) {
      return this.bookAuthors.findOrCreateByName(dto.author);
    }
    return null;
  }

  private authorData(row: { id: string; name: string }) {
    return { author: row.name, authorRef: { connect: { id: row.id } } };
  }

  async create(dto: CreateBookDto): Promise<BookWithRelations> {
    const { categoryIds, language, author, authorId, ...data } = dto;
    // Never null here: the DTO requires `author` unless `authorId` is given.
    const authorRow = await this.resolveAuthor({ author, authorId });
    if (!authorRow) throw new BadRequestException('A book needs an author');

    return this.prisma.book.create({
      data: {
        ...data,
        ...this.authorData(authorRow),
        coverUrl: this.minioService.canonicalImageUrl(data.coverUrl),
        categories: categoryIds
          ? { connect: categoryIds.map((id) => ({ id })) }
          : undefined,
        // A book is created with its first language already in place —
        // there is no useful state between "a book exists" and "it has one
        // edition to put content in".
        editions: { create: [this.newEditionData(dto.type, language)] },
      },
      include: CATALOG_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateBookDto): Promise<BookWithRelations> {
    await this.assertBookExists(id);
    const { categoryIds, author, authorId, ...data } = dto;
    const authorRow = await this.resolveAuthor({ author, authorId });

    return this.prisma.book.update({
      where: { id },
      data: {
        ...data,
        ...(authorRow ? this.authorData(authorRow) : {}),
        ...(data.coverUrl !== undefined
          ? { coverUrl: this.minioService.canonicalImageUrl(data.coverUrl) }
          : {}),
        categories: categoryIds
          ? { set: categoryIds.map((cid) => ({ id: cid })) }
          : undefined,
      },
      include: CATALOG_INCLUDE,
    });
  }

  /**
   * DB row first (cascading to editions, chapters, pages and bookmarks),
   * storage second and best-effort — the same order and reasoning as
   * MoviesService.remove. Every edition's objects live under the book's own
   * key prefix, so one prefix delete still reaches all of them.
   */
  async remove(id: string): Promise<void> {
    const book = await this.prisma.book.findUnique({ where: { id } });
    if (!book) throw new NotFoundException('Book not found');

    await this.prisma.book.delete({ where: { id } });

    try {
      await this.minioService.deleteByPrefix(`books/${id}/`);
      if (book.coverUrl) {
        const key = this.minioService.keyFromPublicUrl(book.coverUrl);
        if (key) await this.minioService.deleteObject(key);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to clean up storage for deleted book ${id}: ${(error as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Editions (languages)
  // ---------------------------------------------------------------------

  /**
   * Both types now start as a plain draft: a file belongs to a CHAPTER, so
   * there is nothing for a fresh edition to be uploading.
   */
  private newEditionData(_type: BookType, language: string) {
    return { language, status: BookStatus.DRAFT };
  }

  async addEdition(
    bookId: string,
    dto: CreateBookEditionDto,
  ): Promise<EditionWithCounts> {
    const book = await this.prisma.book.findUnique({
      where: { id: bookId },
      select: { type: true },
    });
    if (!book) throw new NotFoundException('Book not found');

    const existing = await this.prisma.bookEdition.findUnique({
      where: { bookId_language: { bookId, language: dto.language } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'This book already has an edition in that language',
      );
    }

    return this.prisma.bookEdition.create({
      data: { bookId, ...this.newEditionData(book.type, dto.language) },
      include: {
        _count: { select: { chapters: true } },
        // How many chapters a reader could actually open. That — not the
        // chapter count — is what "can this language be published?" means now,
        // so the admin must not be left to guess it. Selected as ids rather
        // than a filtered _count because Prisma cannot alias two counts of the
        // same relation.
        chapters: {
          where: { status: ChapterStatus.READY },
          select: { id: true },
        },
      },
    });
  }

  async updateEdition(
    bookId: string,
    editionId: string,
    dto: UpdateBookEditionDto,
  ): Promise<EditionWithCounts> {
    const edition = await this.editionOrThrow(bookId, editionId, {
      book: { select: { type: true } },
    });

    if (dto.status !== undefined) {
      const readyChapters = await this.prisma.bookChapter.count({
        where: { editionId, status: ChapterStatus.READY },
      });
      this.assertStatusChangeAllowed(edition, dto.status, readyChapters);
    }
    if (dto.language !== undefined && dto.language !== edition.language) {
      const clash = await this.prisma.bookEdition.findUnique({
        where: { bookId_language: { bookId, language: dto.language } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          'This book already has an edition in that language',
        );
      }
    }

    return this.prisma.bookEdition.update({
      where: { id: editionId },
      data: {
        ...(dto.language !== undefined ? { language: dto.language } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        // Stamped on the first publish only — republishing after an
        // unpublish keeps the original date, like a print run.
        ...(dto.status === BookStatus.PUBLISHED && edition.publishedAt === null
          ? { publishedAt: new Date() }
          : {}),
      },
      include: {
        _count: { select: { chapters: true } },
        // How many chapters a reader could actually open. That — not the
        // chapter count — is what "can this language be published?" means now,
        // so the admin must not be left to guess it. Selected as ids rather
        // than a filtered _count because Prisma cannot alias two counts of the
        // same relation.
        chapters: {
          where: { status: ChapterStatus.READY },
          select: { id: true },
        },
      },
    });
  }

  /**
   * Removing a language takes its chapters/pages/bookmarks with it (schema
   * cascade) and its objects from storage. The last edition cannot go: a
   * book with no languages is unreachable content, and deleting the book is
   * the honest way to say that.
   */
  async removeEdition(bookId: string, editionId: string): Promise<void> {
    await this.editionOrThrow(bookId, editionId);
    const count = await this.prisma.bookEdition.count({ where: { bookId } });
    if (count <= 1) {
      throw new BadRequestException(
        'A book must keep at least one language — delete the book instead',
      );
    }

    await this.prisma.bookEdition.delete({ where: { id: editionId } });

    try {
      await this.minioService.deleteByPrefix(
        `${this.storageService.bookEditionPrefix(bookId, editionId)}/`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to clean up storage for deleted edition ${editionId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The edition's own lifecycle rules. Status is a raw enum in the admin, so
   * this is where nonsense transitions are refused: publishing an empty
   * language, or hand-walking a PDF edition through states only the
   * conversion pipeline may set.
   */
  private assertStatusChangeAllowed(
    edition: BookEdition & { book: { type: BookType } },
    next: BookStatus,
    readyChapters: number,
  ): void {
    if (next === edition.status) return;
    const type = edition.book.type;

    if (next === BookStatus.PUBLISHED) {
      // One rule for both types now that both are made of chapters: a
      // language goes live once it has something a reader can actually open.
      // Deliberately ONE ready chapter, not all of them — a serialised title
      // publishes chapter 1 while chapter 2 is still converting, which is the
      // whole point of per-chapter releases.
      if (readyChapters === 0) {
        throw new BadRequestException(
          type === BookType.PDF
            ? 'This language needs at least one converted chapter before it can be published'
            : 'This language needs at least one chapter with content before it can be published',
        );
      }
      return;
    }

    // Everything else is just hiding it again.
    if (next !== BookStatus.DRAFT && next !== BookStatus.READY) {
      throw new BadRequestException(
        'An edition is either a draft or published — the conversion states belong to its chapters',
      );
    }
  }

  // ---------------------------------------------------------------------
  // Chapters (EDITOR books)
  // ---------------------------------------------------------------------

  /**
   * Both book types have chapters. A written one is born READY the moment it
   * has text; a PDF one is born DRAFT and waits for its file, then walks the
   * conversion lifecycle on its own.
   */
  async createChapter(
    bookId: string,
    editionId: string,
    dto: CreateBookChapterDto,
  ): Promise<ChapterWithHierarchy> {
    const edition = await this.editionOrThrow(bookId, editionId, {
      book: { select: { type: true } },
    });
    if (dto.partId) await this.assertPartInEdition(editionId, dto.partId);

    const last = await this.prisma.bookChapter.findFirst({
      where: { editionId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    const written = edition.book.type === BookType.EDITOR;
    const created = await this.prisma.bookChapter.create({
      data: {
        editionId,
        title: dto.title,
        imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl),
        content: written
          ? ((dto.content ?? {}) as Prisma.InputJsonValue)
          : undefined,
        order: (last?.order ?? 0) + 1,
        status: written ? ChapterStatus.READY : ChapterStatus.DRAFT,
        // Only written when given, so a part-less create is the same row
        // it always was.
        ...(dto.partId ? { partId: dto.partId } : {}),
      },
    });

    // A chapter born into a part lands at the end of the edition's order;
    // regrouping moves it up behind its part-mates and renumbers.
    if (dto.partId) {
      await this.normalizeReadingOrder(editionId);
      return this.decoratedChapterOrThrow(editionId, created.id);
    }
    return (await this.decorateChapters(editionId, [created]))[0];
  }

  async updateChapter(
    bookId: string,
    editionId: string,
    chapterId: string,
    dto: UpdateBookChapterDto,
  ): Promise<ChapterWithHierarchy> {
    const current = await this.assertChapterInEdition(
      bookId,
      editionId,
      chapterId,
    );
    // partId: undefined leaves the assignment alone, null unassigns, a uuid
    // must be a part of this same edition.
    if (dto.partId) await this.assertPartInEdition(editionId, dto.partId);
    const partChanged =
      dto.partId !== undefined && dto.partId !== (current.partId ?? null);

    const updated = await this.prisma.bookChapter.update({
      where: { id: chapterId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.imageUrl !== undefined
          ? { imageUrl: this.minioService.canonicalImageUrl(dto.imageUrl) }
          : {}),
        ...(dto.content !== undefined
          ? { content: dto.content as Prisma.InputJsonValue }
          : {}),
        ...(dto.partId !== undefined ? { partId: dto.partId } : {}),
      },
    });

    if (partChanged) {
      await this.normalizeReadingOrder(editionId);
      return this.decoratedChapterOrThrow(editionId, chapterId);
    }
    return (await this.decorateChapters(editionId, [updated]))[0];
  }

  async deleteChapter(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): Promise<void> {
    await this.assertChapterInEdition(bookId, editionId, chapterId);
    await this.prisma.bookChapter.delete({ where: { id: chapterId } });

    // The rows cascade; the bytes do not. Best-effort and warn-only, the same
    // order and reasoning as remove().
    try {
      await this.minioService.deleteByPrefix(
        `${this.storageService.bookChapterPrefix(bookId, editionId, chapterId)}/`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to clean up storage for deleted chapter ${chapterId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Full-list renumber, the way series episodes reorder: the client sends
   * every chapter id of this edition in reading order and each row gets
   * order = index + 1. Requiring the COMPLETE set keeps the operation
   * idempotent and conflict-free without a unique constraint dance.
   */
  async reorderChapters(
    bookId: string,
    editionId: string,
    dto: ReorderChaptersDto,
  ): Promise<void> {
    await this.editionOrThrow(bookId, editionId);

    const chapters = await this.prisma.bookChapter.findMany({
      where: { editionId },
      select: { id: true },
    });
    const existingIds = new Set(chapters.map((c) => c.id));

    if (
      dto.chapterIds.length !== existingIds.size ||
      !dto.chapterIds.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'chapterIds must contain every chapter of this edition exactly once',
      );
    }

    await this.prisma.$transaction(
      dto.chapterIds.map((id, index) =>
        this.prisma.bookChapter.update({
          where: { id },
          data: { order: index + 1 },
        }),
      ),
    );

    // Parts group the order: if the sent list interleaved parts, regroup.
    // For a part-less edition (and a list the grouped admin UI sends) the
    // order just written IS canonical, so this issues no writes at all.
    await this.normalizeReadingOrder(editionId);
  }

  /** Chapter list for one edition — summaries only; content is its own route. */
  async getChapters(
    bookId: string,
    editionId: string,
    viewerRole: Role,
  ): Promise<ChapterWithHierarchy[]> {
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    const rows = await this.prisma.bookChapter.findMany({
      where: { editionId },
      orderBy: { order: 'asc' },
    });
    // Canonical reading order — for an edition with no parts, exactly the
    // orderBy above.
    return this.decorateChapters(editionId, rows, { complete: true });
  }

  async getChapterOrThrow(
    bookId: string,
    editionId: string,
    chapterId: string,
    viewerRole: Role,
  ): Promise<ChapterWithHierarchy> {
    // Visibility first, so probing chapter ids of an unpublished language
    // gets the same 404 the edition itself would give.
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    return this.decoratedChapterOrThrow(editionId, chapterId);
  }

  /** One chapter of this edition, decorated — 404 if it is someone else's. */
  private async decoratedChapterOrThrow(
    editionId: string,
    chapterId: string,
  ): Promise<ChapterWithHierarchy> {
    const chapter = await this.prisma.bookChapter.findUnique({
      where: { id: chapterId },
    });
    if (!chapter || chapter.editionId !== editionId) {
      throw new NotFoundException('Chapter not found');
    }
    return (await this.decorateChapters(editionId, [chapter]))[0];
  }

  /**
   * Attach `number` and numbered `sections` to chapter rows. Numbering is
   * positional over the WHOLE edition, so unless `complete` says the rows
   * already are the whole edition, the other chapters are read (id/order
   * only) to place these. Returns the given rows in canonical reading order.
   */
  private async decorateChapters<T extends BookChapter>(
    editionId: string,
    rows: T[],
    options: { complete?: boolean } = {},
  ): Promise<NumberedChapter<T, BookSection>[]> {
    const tree = await this.loadContentsTree(editionId, rows, options);
    const wanted = new Set(rows.map((r) => r.id));
    return tree.flat.filter((c) => wanted.has(c.id)) as NumberedChapter<
      T,
      BookSection
    >[];
  }

  private async loadContentsTree<T extends BookChapter>(
    editionId: string,
    rows: T[],
    options: { complete?: boolean } = {},
  ): Promise<
    ContentsTree<ChapterRowLike & { pageCount: number }, BookSection>
  > {
    const [parts, sections, others] = await Promise.all([
      this.prisma.bookPart.findMany({
        where: { editionId },
        orderBy: positionOrder(),
      }),
      this.prisma.bookSection.findMany({
        where: { chapterId: { in: rows.map((r) => r.id) } },
        orderBy: positionOrder(),
      }),
      options.complete
        ? Promise.resolve([] as (ChapterRowLike & { pageCount: number })[])
        : this.prisma.bookChapter.findMany({
            where: { editionId },
            select: {
              id: true,
              partId: true,
              order: true,
              createdAt: true,
              pageCount: true,
            },
          }),
    ]);

    // The given rows stand in for their fresh copies (they may be the result
    // of a write the read above would not yet reflect in a test double);
    // chapters not among `rows` are placed by their stored position only.
    const given = new Map(rows.map((r) => [r.id, r]));
    const all: (ChapterRowLike & { pageCount: number })[] = [
      ...others.map((o) => given.get(o.id) ?? o),
      ...rows.filter((r) => !others.some((o) => o.id === r.id)),
    ];

    const sectionsByChapter = new Map<string, BookSection[]>();
    for (const section of sections) {
      sectionsByChapter.set(section.chapterId, [
        ...(sectionsByChapter.get(section.chapterId) ?? []),
        section,
      ]);
    }

    return buildContentsTree({
      parts,
      chapters: all,
      sectionsByChapter,
      pageCountOf: (c) => c.pageCount,
    });
  }

  /**
   * Bring the edition's stored `order` back to canonical — unparted chapters
   * first, then each part in turn — writing only the rows that moved. Every
   * mutation that can break the grouping ends here; an edition that is
   * already canonical (every part-less book) costs two reads and no writes.
   */
  private async normalizeReadingOrder(editionId: string): Promise<void> {
    const [parts, chapters] = await Promise.all([
      this.prisma.bookPart.findMany({
        where: { editionId },
        select: { id: true, title: true, order: true, createdAt: true },
      }),
      this.prisma.bookChapter.findMany({
        where: { editionId },
        select: { id: true, partId: true, order: true, createdAt: true },
      }),
    ]);
    const writes = planReadingOrder(parts, chapters);
    if (writes.length === 0) return;

    await this.prisma.$transaction(
      writes.map((w) =>
        this.prisma.bookChapter.update({
          where: { id: w.id },
          data: { order: w.order },
        }),
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Pages (PDF books)
  // ---------------------------------------------------------------------

  async getPages(
    bookId: string,
    editionId: string,
    chapterId: string,
    viewerRole: Role,
  ): Promise<BookPage[]> {
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    await this.assertChapterInEdition(bookId, editionId, chapterId, {
      allowAnyType: true,
    });
    return this.prisma.bookPage.findMany({
      where: { chapterId },
      orderBy: { pageNumber: 'asc' },
    });
  }

  // ---------------------------------------------------------------------
  // PDF conversion
  // ---------------------------------------------------------------------

  /**
   * Kick off (or retry) one language's PDF -> WebP conversion.
   * Fire-and-forget like video transcoding: the caller gets an immediate
   * response and the admin polls getProcessingStatus. Accepting PROCESSING
   * only when this process isn't actually running it is the orphan-recovery
   * path — see UploadsService.reprocessVideo.
   */
  async startProcessing(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): Promise<void> {
    const edition = await this.editionOrThrow(bookId, editionId, {
      book: { select: { type: true } },
    });
    if (edition.book.type !== BookType.PDF) {
      throw new BadRequestException('Only PDF books have a conversion to run');
    }

    const chapter = await this.prisma.bookChapter.findUnique({
      where: { id: chapterId },
    });
    if (!chapter || chapter.editionId !== editionId) {
      throw new NotFoundException('Chapter not found');
    }
    if (
      chapter.status === ChapterStatus.PROCESSING &&
      this.bookProcessing.isActivelyProcessing(chapterId)
    ) {
      throw new ConflictException('This chapter is already being processed');
    }

    // The PDF lands at a fixed key via the browser-direct upload (see
    // ResourceUploadTypeRegistry's "book" entry, whose relativePath carries
    // the edition and chapter) — record it on first processing so everything
    // downstream reads the row, not the convention.
    const pdfKey =
      chapter.pdfKey ??
      this.storageService.bookPdfKey(bookId, editionId, chapterId);
    const size = await this.minioService.objectSize(pdfKey);
    if (size === null) {
      throw new BadRequestException(
        'No uploaded PDF found for this chapter — upload the file first',
      );
    }
    await this.prisma.bookChapter.update({
      where: { id: chapterId },
      data: { pdfKey, pdfFileSize: BigInt(size) },
    });

    void this.bookProcessing.processChapter(chapterId);
  }

  /** The admin's 2.5s poll — deliberately a single-row read with no relations. */
  async getProcessingStatus(
    bookId: string,
    editionId: string,
    chapterId: string,
  ) {
    await this.editionOrThrow(bookId, editionId);
    const chapter = await this.prisma.bookChapter.findUnique({
      where: { id: chapterId },
    });
    if (!chapter || chapter.editionId !== editionId) {
      throw new NotFoundException('Chapter not found');
    }

    return {
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      status: chapter.status,
      pageCount: chapter.pageCount,
      processedPages: chapter.processedPages,
      percent:
        chapter.pageCount > 0
          ? Math.round((chapter.processedPages / chapter.pageCount) * 100)
          : 0,
      processingError: chapter.processingError,
      pdfFileSize:
        chapter.pdfFileSize === null ? null : Number(chapter.pdfFileSize),
      updatedAt: chapter.updatedAt,
    };
  }

  /**
   * The edition's current publish status. The PUT gate needs to know which
   * direction an edit is moving before it can pick BOOKS.PUBLISH vs
   * BOOKS.UNPUBLISH — the same shape as MoviesService.getStatusOrThrow.
   */
  async getEditionStatusOrThrow(
    bookId: string,
    editionId: string,
  ): Promise<BookStatus> {
    const edition = await this.editionOrThrow(bookId, editionId);
    return edition.status;
  }

  // ---------------------------------------------------------------------
  // Reading progress
  // ---------------------------------------------------------------------

  async getReadingProgress(
    userId: string,
    bookId: string,
    editionId: string,
    viewerRole: Role,
  ): Promise<BookReadingProgress | null> {
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    return this.prisma.bookReadingProgress.findUnique({
      where: { userId_editionId: { userId, editionId } },
    });
  }

  /** WatchHistory's upsert, per edition — see VideosService.recordWatchProgress. */
  async updateReadingProgress(
    userId: string,
    bookId: string,
    editionId: string,
    dto: UpdateReadingProgressDto,
    viewerRole: Role,
  ): Promise<BookReadingProgress> {
    const edition = await this.assertEditionVisible(
      bookId,
      editionId,
      viewerRole,
    );

    if (edition.book.type === BookType.EDITOR && dto.pageNumber !== undefined) {
      throw new BadRequestException(
        'Written editions track a chapter, not a page number',
      );
    }
    // No converse guard for PDF editions: since the chapter-level PDF rework
    // a PDF book is made of chapters too, so its bookmark is a chapter AND a
    // page within it. The old "PDF editions track a page number, not a
    // chapter" rejection outlived the one-PDF-per-edition model it was
    // written for — and silently broke every PDF bookmark both readers sent.
    // `!= null`: an explicit null from a client means "no chapter/section",
    // and must never reach Prisma as `where: { id: null }` (a 500).
    if (dto.chapterId != null) {
      const chapter = await this.prisma.bookChapter.findUnique({
        where: { id: dto.chapterId },
        select: { editionId: true },
      });
      if (!chapter || chapter.editionId !== editionId) {
        throw new BadRequestException(
          'chapterId does not belong to this edition',
        );
      }
    }

    // A section implies its chapter: when the client sends only sectionId,
    // the bookmark still lands on a consistent (chapter, section) pair.
    let sectionChapterId: string | null = null;
    if (dto.sectionId != null) {
      const section = await this.prisma.bookSection.findUnique({
        where: { id: dto.sectionId },
        select: { chapterId: true, chapter: { select: { editionId: true } } },
      });
      if (!section || section.chapter.editionId !== editionId) {
        throw new BadRequestException(
          'sectionId does not belong to this edition',
        );
      }
      if (dto.chapterId != null && section.chapterId !== dto.chapterId) {
        throw new BadRequestException(
          'sectionId does not belong to this chapter',
        );
      }
      sectionChapterId = section.chapterId;
    }

    const position = {
      chapterId: dto.chapterId ?? sectionChapterId ?? null,
      pageNumber: dto.pageNumber ?? null,
      sectionId: dto.sectionId ?? null,
      progress: dto.progress,
    };
    return this.prisma.bookReadingProgress.upsert({
      where: { userId_editionId: { userId, editionId } },
      create: { userId, editionId, ...position },
      update: position,
    });
  }

  // ---------------------------------------------------------------------
  // Parts (optional grouping of chapters inside one edition)
  // ---------------------------------------------------------------------

  /** Numbered by position, with how many chapters each holds. */
  private async listParts(editionId: string): Promise<PartWithCounts[]> {
    const parts = await this.prisma.bookPart.findMany({
      where: { editionId },
      orderBy: positionOrder(),
      include: { _count: { select: { chapters: true } } },
    });
    return parts.map(({ _count, ...part }, i) => ({
      ...part,
      number: i + 1,
      chapterCount: _count.chapters,
    }));
  }

  private async partWithCountsOrThrow(
    editionId: string,
    partId: string,
  ): Promise<PartWithCounts> {
    const part = (await this.listParts(editionId)).find((p) => p.id === partId);
    if (!part) throw new NotFoundException('Part not found');
    return part;
  }

  async getParts(
    bookId: string,
    editionId: string,
    viewerRole: Role,
  ): Promise<PartWithCounts[]> {
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    return this.listParts(editionId);
  }

  async createPart(
    bookId: string,
    editionId: string,
    dto: CreateBookPartDto,
  ): Promise<PartWithCounts> {
    await this.editionOrThrow(bookId, editionId);
    const last = await this.prisma.bookPart.findFirst({
      where: { editionId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const created = await this.prisma.bookPart.create({
      data: { editionId, title: dto.title, order: (last?.order ?? 0) + 1 },
    });
    // A new part is empty, so the reading order is untouched.
    return this.partWithCountsOrThrow(editionId, created.id);
  }

  async updatePart(
    bookId: string,
    editionId: string,
    partId: string,
    dto: UpdateBookPartDto,
  ): Promise<PartWithCounts> {
    await this.partOrThrow(bookId, editionId, partId);
    await this.prisma.bookPart.update({
      where: { id: partId },
      data: { ...(dto.title !== undefined ? { title: dto.title } : {}) },
    });
    return this.partWithCountsOrThrow(editionId, partId);
  }

  /** The chapters' complete-set renumber, for parts — then regroup the chapters. */
  async reorderParts(
    bookId: string,
    editionId: string,
    dto: ReorderPartsDto,
  ): Promise<void> {
    await this.editionOrThrow(bookId, editionId);

    const parts = await this.prisma.bookPart.findMany({
      where: { editionId },
      select: { id: true },
    });
    const existingIds = new Set(parts.map((p) => p.id));
    if (
      dto.partIds.length !== existingIds.size ||
      !dto.partIds.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'partIds must contain every part of this edition exactly once',
      );
    }

    await this.prisma.$transaction(
      dto.partIds.map((id, index) =>
        this.prisma.bookPart.update({
          where: { id },
          data: { order: index + 1 },
        }),
      ),
    );
    await this.normalizeReadingOrder(editionId);
  }

  /**
   * Deleting a part keeps its chapters (FK SET NULL): they become unparted
   * and move to the front of the reading order, renumbered.
   */
  async deletePart(
    bookId: string,
    editionId: string,
    partId: string,
  ): Promise<void> {
    await this.partOrThrow(bookId, editionId, partId);
    await this.prisma.bookPart.delete({ where: { id: partId } });
    await this.normalizeReadingOrder(editionId);
  }

  // ---------------------------------------------------------------------
  // Sections (optional subdivisions inside one chapter)
  // ---------------------------------------------------------------------

  async getSections(
    bookId: string,
    editionId: string,
    chapterId: string,
    viewerRole: Role,
  ): Promise<SectionWithNumber[]> {
    await this.assertEditionVisible(bookId, editionId, viewerRole);
    const chapter = await this.decoratedChapterOrThrow(editionId, chapterId);
    return chapter.sections;
  }

  /**
   * What a section may carry depends on the book: a written section has a
   * document and no page; a PDF section is a page anchor and has no
   * document. The page must exist in the chapter's converted range.
   */
  private async assertSectionShape(
    type: BookType,
    chapter: BookChapter,
    dto: { content?: unknown; startPage?: number },
    creating: boolean,
    excludeSectionId?: string,
  ): Promise<void> {
    if (type === BookType.EDITOR) {
      if (dto.startPage !== undefined) {
        throw new BadRequestException(
          'Written chapters have no pages — a section carries content, not a start page',
        );
      }
      return;
    }
    if (dto.content !== undefined) {
      throw new BadRequestException(
        'PDF chapters have no written content — a section is a start page',
      );
    }
    if (creating && dto.startPage === undefined) {
      throw new BadRequestException('startPage is required for a PDF section');
    }
    if (dto.startPage !== undefined) {
      const max = Math.max(1, chapter.pageCount);
      if (dto.startPage < 1 || dto.startPage > max) {
        throw new BadRequestException(`startPage must be between 1 and ${max}`);
      }
      // Two sections cannot start on the same page: numbering would hand the
      // earlier one a backwards range (3.1 = pages 5..4) and the readers,
      // which pick the LAST section at or before a page, could never mark it
      // current. Strictly increasing pages fall out of uniqueness + sorting.
      const clash = await this.prisma.bookSection.findFirst({
        where: {
          chapterId: chapter.id,
          startPage: dto.startPage,
          ...(excludeSectionId ? { NOT: { id: excludeSectionId } } : {}),
        },
        select: { id: true, title: true },
      });
      if (clash) {
        throw new BadRequestException(
          `A section ("${clash.title}") already starts on page ${dto.startPage}`,
        );
      }
    }
  }

  /**
   * PDF sections are always stored in start-page order: after a create or a
   * page change, rewrite `order` to match, writing only the rows that moved.
   */
  private async resortPdfSections(chapterId: string): Promise<void> {
    const sections = await this.prisma.bookSection.findMany({
      where: { chapterId },
      select: { id: true, order: true, startPage: true, createdAt: true },
    });
    const sorted = [...sections].sort(
      (a, b) => (a.startPage ?? 0) - (b.startPage ?? 0) || byPosition(a, b),
    );
    const writes = sorted
      .map((s, index) => ({ id: s.id, order: index + 1, was: s.order }))
      .filter((w) => w.was !== w.order);
    if (writes.length === 0) return;

    await this.prisma.$transaction(
      writes.map((w) =>
        this.prisma.bookSection.update({
          where: { id: w.id },
          data: { order: w.order },
        }),
      ),
    );
  }

  private async numberedSectionOrThrow(
    editionId: string,
    chapterId: string,
    sectionId: string,
  ): Promise<SectionWithNumber> {
    const chapter = await this.decoratedChapterOrThrow(editionId, chapterId);
    const section = chapter.sections.find((s) => s.id === sectionId);
    if (!section) throw new NotFoundException('Section not found');
    return section;
  }

  async createSection(
    bookId: string,
    editionId: string,
    chapterId: string,
    dto: CreateBookSectionDto,
  ): Promise<SectionWithNumber> {
    const { type, chapter } = await this.sectionChapterOrThrow(
      bookId,
      editionId,
      chapterId,
    );
    await this.assertSectionShape(type, chapter, dto, true);

    const last = await this.prisma.bookSection.findFirst({
      where: { chapterId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const written = type === BookType.EDITOR;
    const created = await this.prisma.bookSection.create({
      data: {
        chapterId,
        title: dto.title,
        order: (last?.order ?? 0) + 1,
        content: written
          ? ((dto.content ?? {}) as Prisma.InputJsonValue)
          : undefined,
        startPage: written ? undefined : dto.startPage,
      },
    });
    if (!written) await this.resortPdfSections(chapterId);

    return this.numberedSectionOrThrow(editionId, chapterId, created.id);
  }

  async updateSection(
    bookId: string,
    editionId: string,
    chapterId: string,
    sectionId: string,
    dto: UpdateBookSectionDto,
  ): Promise<SectionWithNumber> {
    const { type, chapter, section } = await this.sectionOrThrow(
      bookId,
      editionId,
      chapterId,
      sectionId,
    );
    await this.assertSectionShape(type, chapter, dto, false, sectionId);

    await this.prisma.bookSection.update({
      where: { id: sectionId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined
          ? { content: dto.content as Prisma.InputJsonValue }
          : {}),
        ...(dto.startPage !== undefined ? { startPage: dto.startPage } : {}),
      },
    });
    if (
      type === BookType.PDF &&
      dto.startPage !== undefined &&
      dto.startPage !== section.startPage
    ) {
      await this.resortPdfSections(chapterId);
    }

    return this.numberedSectionOrThrow(editionId, chapterId, sectionId);
  }

  /** Written chapters only — PDF sections take their order from their pages. */
  async reorderSections(
    bookId: string,
    editionId: string,
    chapterId: string,
    dto: ReorderSectionsDto,
  ): Promise<void> {
    const { type } = await this.sectionChapterOrThrow(
      bookId,
      editionId,
      chapterId,
    );
    if (type === BookType.PDF) {
      throw new BadRequestException(
        'PDF sections are ordered by their start page',
      );
    }

    const sections = await this.prisma.bookSection.findMany({
      where: { chapterId },
      select: { id: true },
    });
    const existingIds = new Set(sections.map((s) => s.id));
    if (
      dto.sectionIds.length !== existingIds.size ||
      !dto.sectionIds.every((id) => existingIds.has(id))
    ) {
      throw new BadRequestException(
        'sectionIds must contain every section of this chapter exactly once',
      );
    }

    await this.prisma.$transaction(
      dto.sectionIds.map((id, index) =>
        this.prisma.bookSection.update({
          where: { id },
          data: { order: index + 1 },
        }),
      ),
    );
  }

  /** Plain delete — numbering is positional, so the gap it leaves is invisible. */
  async deleteSection(
    bookId: string,
    editionId: string,
    chapterId: string,
    sectionId: string,
  ): Promise<void> {
    await this.sectionOrThrow(bookId, editionId, chapterId, sectionId);
    await this.prisma.bookSection.delete({ where: { id: sectionId } });
  }

  // ---------------------------------------------------------------------
  // Contents (the numbered tree every table of contents renders from)
  // ---------------------------------------------------------------------

  async getContents(
    bookId: string,
    editionId: string,
    viewerRole: Role,
  ): Promise<{
    bookType: BookType;
    tree: ContentsTree<BookChapter, BookSection>;
  }> {
    const edition = await this.assertEditionVisible(
      bookId,
      editionId,
      viewerRole,
    );
    const rows = await this.prisma.bookChapter.findMany({
      where: { editionId },
      orderBy: { order: 'asc' },
    });
    const tree = (await this.loadContentsTree(editionId, rows, {
      complete: true,
    })) as ContentsTree<BookChapter, BookSection>;
    return { bookType: edition.book.type, tree };
  }

  // ---------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------

  private async assertBookExists(id: string): Promise<void> {
    const exists = await this.prisma.book.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Book not found');
  }

  /**
   * The edition, if it belongs to this book. Staff-facing: no publish check,
   * because the admin's whole job is the unpublished ones.
   */
  private async editionOrThrow<T extends Prisma.BookEditionInclude>(
    bookId: string,
    editionId: string,
    include?: T,
  ) {
    const edition = await this.prisma.bookEdition.findUnique({
      where: { id: editionId },
      include: (include ?? {}) as T,
    });
    if (!edition || edition.bookId !== bookId) {
      throw new NotFoundException('Book edition not found');
    }
    return edition as BookEdition &
      Prisma.BookEditionGetPayload<{ include: T }>;
  }

  /** The edition, if this viewer may read it — USERs only see PUBLISHED. */
  private async assertEditionVisible(
    bookId: string,
    editionId: string,
    viewerRole: Role,
  ): Promise<BookEdition & { book: { type: BookType } }> {
    const edition = await this.prisma.bookEdition.findUnique({
      where: { id: editionId },
      include: { book: { select: { type: true } } },
    });
    if (
      !edition ||
      edition.bookId !== bookId ||
      (publishedOnly(viewerRole) && edition.status !== BookStatus.PUBLISHED)
    ) {
      throw new NotFoundException('Book edition not found');
    }
    return edition;
  }

  private async assertChapterInEdition(
    bookId: string,
    editionId: string,
    chapterId: string,
    options: { allowAnyType?: boolean } = {},
  ): Promise<{ editionId: string; partId: string | null }> {
    void options;
    await this.editionOrThrow(bookId, editionId);
    const chapter = await this.prisma.bookChapter.findUnique({
      where: { id: chapterId },
      select: { editionId: true, partId: true },
    });
    if (!chapter || chapter.editionId !== editionId) {
      throw new NotFoundException('Chapter not found');
    }
    return chapter;
  }

  /** A part id sent on a chapter must name a part of that same edition — else 400. */
  private async assertPartInEdition(
    editionId: string,
    partId: string,
  ): Promise<void> {
    const part = await this.prisma.bookPart.findUnique({
      where: { id: partId },
      select: { editionId: true },
    });
    if (!part || part.editionId !== editionId) {
      throw new BadRequestException('partId does not belong to this edition');
    }
  }

  /** The part, if it belongs to this edition of this book. Staff-facing. */
  private async partOrThrow(
    bookId: string,
    editionId: string,
    partId: string,
  ): Promise<BookPart> {
    await this.editionOrThrow(bookId, editionId);
    const part = await this.prisma.bookPart.findUnique({
      where: { id: partId },
    });
    if (!part || part.editionId !== editionId) {
      throw new NotFoundException('Part not found');
    }
    return part;
  }

  /**
   * The chapter a section lives in, with the book type that decides what a
   * section may carry. Staff-facing, like assertChapterInEdition.
   */
  private async sectionChapterOrThrow(
    bookId: string,
    editionId: string,
    chapterId: string,
  ): Promise<{ type: BookType; chapter: BookChapter }> {
    const edition = await this.editionOrThrow(bookId, editionId, {
      book: { select: { type: true } },
    });
    const chapter = await this.prisma.bookChapter.findUnique({
      where: { id: chapterId },
    });
    if (!chapter || chapter.editionId !== editionId) {
      throw new NotFoundException('Chapter not found');
    }
    return { type: edition.book.type, chapter };
  }

  private async sectionOrThrow(
    bookId: string,
    editionId: string,
    chapterId: string,
    sectionId: string,
  ): Promise<{ type: BookType; chapter: BookChapter; section: BookSection }> {
    const owner = await this.sectionChapterOrThrow(
      bookId,
      editionId,
      chapterId,
    );
    const section = await this.prisma.bookSection.findUnique({
      where: { id: sectionId },
    });
    if (!section || section.chapterId !== chapterId) {
      throw new NotFoundException('Section not found');
    }
    return { ...owner, section };
  }
}
