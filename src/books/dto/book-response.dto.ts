import type {
  Book,
  BookCategory,
  BookChapter,
  BookEdition,
  BookPart,
  BookSection,
  BookType,
} from '../../generated/prisma/client';
import type { ContentsTree, NumberedSection } from '../book-numbering';

export type ImageUrlResolver = (
  url: string | null | undefined,
) => string | null;

type EditionWithCounts = BookEdition & {
  _count: { chapters: number };
  /** Only the READY ones — see BooksService's CATALOG_INCLUDE. */
  chapters: { id: string }[];
};

/** The slice of the author row a book carries — see BooksService's CATALOG_INCLUDE. */
type AuthorRefRow = { id: string; name: string; imageUrl: string | null };

type BookWithRelations = Book & {
  authorRef: AuthorRefRow | null;
  categories: BookCategory[];
  editions: EditionWithCounts[];
};

/**
 * Chapter as it appears in a list — everything except `content`, which has
 * its own route. A PDF chapter's numbers ride along so a chapter list can
 * show conversion progress without a second request per row.
 */
export interface ChapterSummary {
  id: string;
  title: string;
  order: number;
  imageUrl: string | null;
  status: BookChapter['status'];
  pageCount: number;
  processedPages: number;
  processingError: string | null;
  pdfFileSize: number | null;
  /** The part this chapter sits in; null for every chapter of a part-less book. */
  partId: string | null;
  /** Derived 1-based position in reading order, as a string ("3") — never stored. */
  number: string;
  sections: SectionSummary[];
}

/**
 * A section as a table of contents lists it. `number` is "3.1"; `endPage` is
 * derived for PDF sections (the page before the next one starts) and null
 * for written ones.
 */
export interface SectionSummary {
  id: string;
  chapterId: string;
  title: string;
  order: number;
  number: string;
  startPage: number | null;
  endPage: number | null;
}

export function toSectionSummary(
  section: NumberedSection<BookSection>,
): SectionSummary {
  return {
    id: section.id,
    chapterId: section.chapterId,
    title: section.title,
    order: section.order,
    number: section.number,
    startPage: section.startPage,
    endPage: section.endPage,
  };
}

/** The summary plus the document — what the admin's section editor loads. */
export function toSectionDetail(section: NumberedSection<BookSection>) {
  return {
    ...toSectionSummary(section),
    content: section.content,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
  };
}

/**
 * A chapter row as the service hands it out: optionally decorated by
 * book-numbering with its derived `number` and numbered `sections`. Both are
 * optional so a bare Prisma row still maps (tests pass bare rows) — the
 * defaults, String(order) and [], are exactly right for a part-less book.
 */
export type ChapterRowWithHierarchy = BookChapter & {
  number?: string;
  sections?: NumberedSection<BookSection>[];
};

export function toChapterSummary(
  chapter: ChapterRowWithHierarchy,
  resolveImageUrl: ImageUrlResolver,
): ChapterSummary {
  return {
    id: chapter.id,
    title: chapter.title,
    order: chapter.order,
    imageUrl: resolveImageUrl(chapter.imageUrl),
    status: chapter.status,
    pageCount: chapter.pageCount,
    processedPages: chapter.processedPages,
    processingError: chapter.processingError,
    // BigInt doesn't survive JSON.stringify.
    pdfFileSize:
      chapter.pdfFileSize === null ? null : Number(chapter.pdfFileSize),
    partId: chapter.partId ?? null,
    number: chapter.number ?? String(chapter.order),
    sections: (chapter.sections ?? []).map(toSectionSummary),
  };
}

/**
 * A chapter WITH its document — what the editor loads.
 *
 * Everything a chapter leaves this module through goes via one of these two
 * mappers, and that is not tidiness: the raw Prisma row carries `pdfFileSize`
 * as a BigInt, which JSON.stringify cannot serialise. Returning a raw row
 * therefore 500s *after* the write has already succeeded — the update lands,
 * the response explodes, and the client sees a failure that was actually a
 * success. A PDF chapter has that field set; a written one has null, so the
 * bug only ever showed on PDF chapters.
 */
export function toChapterDetail(
  chapter: ChapterRowWithHierarchy,
  resolveImageUrl: ImageUrlResolver,
) {
  return {
    ...toChapterSummary(chapter, resolveImageUrl),
    editionId: chapter.editionId,
    content: chapter.content,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    // The detail carries each section WITH its document, so the editor and
    // the readers compose the chapter from one response.
    sections: (chapter.sections ?? []).map(toSectionDetail),
  };
}

export class BookPartResponseDto {
  static fromEntity(
    part: BookPart & { number: number; chapterCount: number },
  ) {
    return {
      id: part.id,
      editionId: part.editionId,
      title: part.title,
      order: part.order,
      number: part.number,
      chapterCount: part.chapterCount,
      createdAt: part.createdAt,
      updatedAt: part.updatedAt,
    };
  }
}

/**
 * The full numbered tree one edition's tables of contents render from. Every
 * chapter goes through toChapterSummary — the same mapper as the flat list —
 * so a TOC row and a list row can never disagree.
 */
export function toContentsResponse(
  tree: ContentsTree<BookChapter, BookSection>,
  bookType: BookType,
  editionId: string,
  resolveImageUrl: ImageUrlResolver,
) {
  return {
    editionId,
    bookType,
    chapterCount: tree.flat.length,
    parts: tree.parts.map((part) => ({
      id: part.id,
      title: part.title,
      order: part.order,
      number: part.number,
      chapters: part.chapters.map((c) => toChapterSummary(c, resolveImageUrl)),
    })),
    chapters: tree.chapters.map((c) => toChapterSummary(c, resolveImageUrl)),
  };
}

export class BookEditionResponseDto {
  static fromEntity(edition: EditionWithCounts) {
    return {
      id: edition.id,
      language: edition.language,
      status: edition.status,
      publishedAt: edition.publishedAt,
      createdAt: edition.createdAt,
      updatedAt: edition.updatedAt,
      // Conversion now happens per chapter, so an edition reports counts
      // rather than progress; the progress numbers live on each chapter.
      chapterCount: edition._count.chapters,
      // What makes a language publishable, and what the review queue is
      // filtering on.
      readyChapterCount: edition.chapters.length,
    };
  }
}

export class BookResponseDto {
  static fromEntity(book: BookWithRelations, resolveImageUrl: ImageUrlResolver) {
    return {
      id: book.id,
      title: book.title,
      // The denormalised display name — what every existing client reads.
      // Kept first and unchanged; the linked row rides along beside it.
      author: book.author,
      authorId: book.authorId,
      authorRef: book.authorRef
        ? {
            id: book.authorRef.id,
            name: book.authorRef.name,
            imageUrl: resolveImageUrl(book.authorRef.imageUrl),
          }
        : null,
      description: book.description,
      coverUrl: resolveImageUrl(book.coverUrl),
      type: book.type,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      categories: book.categories.map((c) => ({ id: c.id, name: c.name })),
      // Only the editions this viewer may see — the service filters them for
      // regular users, so a draft translation never leaks as a language the
      // reader could pick.
      editions: book.editions.map((e) => BookEditionResponseDto.fromEntity(e)),
      languages: book.editions.map((e) => e.language),
    };
  }

  static fromDetail(
    book: BookWithRelations,
    chapters: BookChapter[],
    resolveImageUrl: ImageUrlResolver,
  ) {
    return {
      ...BookResponseDto.fromEntity(book, resolveImageUrl),
      chapters: chapters.map((c) => toChapterSummary(c, resolveImageUrl)),
    };
  }
}
