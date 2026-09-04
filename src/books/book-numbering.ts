/**
 * The ONE place reading order, part grouping and the "1 / 1.1 / 2" numbers
 * are computed. Pure and synchronous — it takes plain rows and returns the
 * same objects decorated, so it is trivially unit-tested and no client ever
 * has to recompute a number.
 *
 * The invariant it maintains (see D2 in the hierarchy spec):
 * BookChapter.order stays the single source of reading order and is kept
 * CANONICAL — unparted chapters first, then each part in BookPart.order,
 * each part's chapters in their own order, renumbered 1..n. Numbers are
 * derived from that order and never stored.
 */

export interface PartRow {
  id: string;
  title: string;
  order: number;
  createdAt: Date;
}

export interface ChapterRowLike {
  id: string;
  partId: string | null;
  order: number;
  createdAt: Date;
}

export interface SectionRow {
  id: string;
  chapterId: string;
  title: string;
  order: number;
  startPage: number | null;
  createdAt: Date;
}

export type NumberedSection<S extends SectionRow = SectionRow> = S & {
  /** "3.1" — chapter number, dot, 1-based position within the chapter. */
  number: string;
  /** PDF sections only: the last page of this section's range. */
  endPage: number | null;
};

export type NumberedChapter<
  T extends ChapterRowLike = ChapterRowLike,
  S extends SectionRow = SectionRow,
> = T & {
  /** "3" — 1-based position in canonical reading order across the edition. */
  number: string;
  sections: NumberedSection<S>[];
};

export type NumberedPart<
  T extends ChapterRowLike = ChapterRowLike,
  S extends SectionRow = SectionRow,
> = PartRow & {
  /** 1-based position among the edition's parts. */
  number: number;
  chapters: NumberedChapter<T, S>[];
};

export interface ContentsTree<
  T extends ChapterRowLike = ChapterRowLike,
  S extends SectionRow = SectionRow,
> {
  parts: NumberedPart<T, S>[];
  /** The UNPARTED chapters, which precede every part in reading order. */
  chapters: NumberedChapter<T, S>[];
  /** Every chapter of the edition in canonical reading order. */
  flat: NumberedChapter<T, S>[];
}

/** The tie-break used everywhere: order, then creation time, then id. */
export function byPosition(
  a: { order: number; createdAt: Date; id: string },
  b: { order: number; createdAt: Date; id: string },
): number {
  if (a.order !== b.order) return a.order - b.order;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Chapters in canonical reading order: the unparted ones (partId null, or a
 * partId that matches none of `parts` — an orphan is treated as unparted
 * rather than vanishing), then each part by position with its own chapters
 * by position. Returns the very objects it was given.
 */
export function canonicalChapterOrder<T extends ChapterRowLike>(
  parts: PartRow[],
  chapters: T[],
): T[] {
  const partIds = new Set(parts.map((p) => p.id));
  const isUnparted = (c: T) => c.partId == null || !partIds.has(c.partId);

  const ordered: T[] = chapters.filter(isUnparted).sort(byPosition);
  for (const part of [...parts].sort(byPosition)) {
    ordered.push(
      ...chapters.filter((c) => c.partId === part.id).sort(byPosition),
    );
  }
  return ordered;
}

/** id -> "1", "2", ... over a list already in canonical order. */
export function numberChapters(
  orderedChapters: { id: string }[],
): Map<string, string> {
  return new Map(orderedChapters.map((c, i) => [c.id, String(i + 1)]));
}

/**
 * A chapter's sections, sorted and numbered. Written sections sort by
 * position; PDF sections (any startPage set) sort by startPage so a section
 * can never be listed after one that starts on a later page. endPage is the
 * page before the next section starts, or the chapter's pageCount for the
 * last one — derived here, never stored.
 */
export function numberSections<S extends SectionRow>(
  chapterNumber: string,
  sections: S[],
  pageCount: number,
): NumberedSection<S>[] {
  const paged = sections.some((s) => s.startPage != null);
  const sorted = [...sections].sort((a, b) => {
    if (paged) {
      const as = a.startPage ?? 0;
      const bs = b.startPage ?? 0;
      if (as !== bs) return as - bs;
    }
    return byPosition(a, b);
  });

  // A re-converted, shorter PDF can leave sections starting past the new
  // last page; clamp to pageCount (when known) so no range points at pages
  // that no longer exist. pageCount 0 = not yet converted: nothing to clamp.
  const cap = pageCount > 0 ? pageCount : Number.POSITIVE_INFINITY;
  const clamp = (page: number) => Math.min(page, cap);

  return sorted.map((section, i) => {
    let startPage = section.startPage;
    let endPage: number | null = null;
    if (startPage != null) {
      startPage = clamp(startPage);
      const next = sorted[i + 1];
      if (next?.startPage != null) {
        // Never backwards, even when two clamped starts coincide.
        endPage = Math.max(startPage, clamp(next.startPage) - 1);
      } else {
        // pageCount 0 (not yet converted) falls back to the start page so a
        // range never runs backwards.
        endPage = Math.max(startPage, pageCount);
      }
    }
    return {
      ...section,
      startPage,
      number: `${chapterNumber}.${i + 1}`,
      endPage,
    };
  });
}

export interface BuildContentsInput<
  T extends ChapterRowLike,
  S extends SectionRow,
> {
  parts: PartRow[];
  chapters: T[];
  /** Every section of the edition, grouped by chapter id (missing = none). */
  sectionsByChapter: Map<string, S[]>;
  /** A PDF chapter's pageCount; written chapters return 0. */
  pageCountOf: (chapter: T) => number;
}

/**
 * Canonical order -> numbers -> grouped into parts / unparted / flat. A part
 * with no chapters is still listed (with chapters: []) so the admin can fill
 * it. The chapter objects in all three views are the same references, each
 * decorated once.
 */
export function buildContentsTree<
  T extends ChapterRowLike,
  S extends SectionRow,
>(input: BuildContentsInput<T, S>): ContentsTree<T, S> {
  const ordered = canonicalChapterOrder(input.parts, input.chapters);
  const numbers = numberChapters(ordered);

  const flat: NumberedChapter<T, S>[] = ordered.map((chapter) => {
    const number = numbers.get(chapter.id) as string;
    const sections = numberSections(
      number,
      input.sectionsByChapter.get(chapter.id) ?? [],
      input.pageCountOf(chapter),
    );
    return Object.assign(chapter, { number, sections });
  });

  const partIds = new Set(input.parts.map((p) => p.id));
  const parts: NumberedPart<T, S>[] = [...input.parts]
    .sort(byPosition)
    .map((part, i) => ({
      ...part,
      number: i + 1,
      chapters: flat.filter((c) => c.partId === part.id),
    }));
  const chapters = flat.filter(
    (c) => c.partId == null || !partIds.has(c.partId),
  );

  return { parts, chapters, flat };
}

/**
 * The writes that bring an edition's stored `order` values back to
 * canonical (1..n in reading order). Only rows whose stored order differs
 * are returned, so an edition that is already canonical — every part-less
 * book — produces ZERO writes.
 */
export function normalizeReadingOrder(
  parts: PartRow[],
  chapters: ChapterRowLike[],
): { id: string; order: number }[] {
  const writes: { id: string; order: number }[] = [];
  canonicalChapterOrder(parts, chapters).forEach((chapter, index) => {
    if (chapter.order !== index + 1) {
      writes.push({ id: chapter.id, order: index + 1 });
    }
  });
  return writes;
}
