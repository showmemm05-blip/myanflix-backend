import {
  buildContentsTree,
  canonicalChapterOrder,
  normalizeReadingOrder,
  numberChapters,
  numberSections,
  type ChapterRowLike,
  type PartRow,
  type SectionRow,
} from './book-numbering';

/**
 * Numbering is derived, never stored — so this table is the whole contract
 * every client's "1 / 1.1 / 2" display rests on. T1-T12 follow the hierarchy
 * spec's test table.
 */
describe('book-numbering', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-02T00:00:00Z');

  const part = (id: string, order: number, createdAt = t0): PartRow => ({
    id,
    title: `Part ${id}`,
    order,
    createdAt,
  });
  const chapter = (
    id: string,
    partId: string | null,
    order: number,
    createdAt = t0,
  ): ChapterRowLike & { pageCount: number } => ({
    id,
    partId,
    order,
    createdAt,
    pageCount: 0,
  });
  const section = (
    id: string,
    chapterId: string,
    order: number,
    startPage: number | null = null,
  ): SectionRow => ({
    id,
    chapterId,
    title: `Section ${id}`,
    order,
    startPage,
    createdAt: t0,
  });

  const tree = (
    parts: PartRow[],
    chapters: (ChapterRowLike & { pageCount: number })[],
    sections: SectionRow[] = [],
  ) => {
    const sectionsByChapter = new Map<string, SectionRow[]>();
    for (const s of sections) {
      sectionsByChapter.set(s.chapterId, [
        ...(sectionsByChapter.get(s.chapterId) ?? []),
        s,
      ]);
    }
    return buildContentsTree({
      parts,
      chapters,
      sectionsByChapter,
      pageCountOf: (c) => c.pageCount,
    });
  };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const numbers = (rows: { id: string; number: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.id, r.number]));

  it('T1: a simple book — no parts, no sections — numbers by position and needs no writes', () => {
    const chapters = [
      chapter('A', null, 1),
      chapter('B', null, 2),
      chapter('C', null, 3),
    ];
    const result = tree([], chapters);

    expect(numbers(result.flat)).toEqual({ A: '1', B: '2', C: '3' });
    expect(result.parts).toEqual([]);
    expect(ids(result.chapters)).toEqual(['A', 'B', 'C']);
    expect(ids(result.flat)).toEqual(['A', 'B', 'C']);
    expect(result.flat.every((c) => c.sections.length === 0)).toBe(true);
    expect(normalizeReadingOrder([], chapters)).toEqual([]);
  });

  it('T2: gaps in stored order are positional, and normalising closes them', () => {
    const chapters = [
      chapter('A', null, 2),
      chapter('B', null, 5),
      chapter('C', null, 9),
    ];

    expect(numbers(tree([], chapters).flat)).toEqual({
      A: '1',
      B: '2',
      C: '3',
    });
    expect(normalizeReadingOrder([], chapters)).toEqual([
      { id: 'A', order: 1 },
      { id: 'B', order: 2 },
      { id: 'C', order: 3 },
    ]);
  });

  it("T3: the owner's example — parts group, chapter numbers run on, sections dot-number", () => {
    const parts = [part('P1', 1), part('P2', 2)];
    const chapters = [
      chapter('A', 'P1', 1),
      chapter('B', 'P1', 2),
      chapter('C', 'P2', 3),
    ];
    const sections = [
      section('s1', 'A', 1),
      section('s2', 'A', 2),
      section('t1', 'C', 1),
    ];
    const result = tree(parts, chapters, sections);

    expect(numbers(result.flat)).toEqual({ A: '1', B: '2', C: '3' });
    const a = result.flat.find((c) => c.id === 'A')!;
    const c = result.flat.find((c) => c.id === 'C')!;
    expect(numbers(a.sections)).toEqual({ s1: '1.1', s2: '1.2' });
    expect(numbers(c.sections)).toEqual({ t1: '3.1' });
    expect(result.parts[0].number).toBe(1);
    expect(ids(result.parts[0].chapters)).toEqual(['A', 'B']);
    expect(result.parts[1].number).toBe(2);
    expect(ids(result.parts[1].chapters)).toEqual(['C']);
    expect(result.chapters).toEqual([]);
  });

  it('T4: unparted chapters come first and are numbered first', () => {
    const parts = [part('P1', 1)];
    const chapters = [chapter('U', null, 3), chapter('A', 'P1', 1)];

    expect(ids(canonicalChapterOrder(parts, chapters))).toEqual(['U', 'A']);
    const result = tree(parts, chapters);
    expect(numbers(result.flat)).toEqual({ U: '1', A: '2' });
    expect(ids(result.chapters)).toEqual(['U']);
    expect(ids(result.parts[0].chapters)).toEqual(['A']);
    expect(normalizeReadingOrder(parts, chapters)).toEqual([
      { id: 'U', order: 1 },
      { id: 'A', order: 2 },
    ]);
  });

  it('T5: interleaved orders regroup by part, stable within a part, writing only what moved', () => {
    const parts = [part('P1', 1), part('P2', 2)];
    const chapters = [
      chapter('A', 'P1', 1),
      chapter('U', null, 2),
      chapter('B', 'P1', 3),
      chapter('C', 'P2', 4),
      chapter('D', 'P1', 5),
    ];

    expect(ids(canonicalChapterOrder(parts, chapters))).toEqual([
      'U',
      'A',
      'B',
      'D',
      'C',
    ]);
    expect(numbers(tree(parts, chapters).flat)).toEqual({
      U: '1',
      A: '2',
      B: '3',
      D: '4',
      C: '5',
    });
    // B is already at 3; every other row moved.
    expect(normalizeReadingOrder(parts, chapters)).toEqual([
      { id: 'U', order: 1 },
      { id: 'A', order: 2 },
      { id: 'D', order: 4 },
      { id: 'C', order: 5 },
    ]);
  });

  it('T6: an orphan partId (part missing from the list) is treated as unparted', () => {
    const result = tree([], [chapter('A', 'ghost', 1)]);

    expect(ids(result.chapters)).toEqual(['A']);
    expect(result.flat[0].number).toBe('1');
  });

  it('T7: an empty part survives with chapters: []', () => {
    const result = tree([part('P1', 1)], [chapter('A', null, 1)]);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      id: 'P1',
      number: 1,
      chapters: [],
    });
    expect(result.flat[0].number).toBe('1');
  });

  it('T8: equal orders tie-break on createdAt', () => {
    const chapters = [chapter('A', null, 1, t1), chapter('B', null, 1, t0)];

    expect(ids(canonicalChapterOrder([], chapters))).toEqual(['B', 'A']);
  });

  it('T9: PDF section ranges end where the next one starts, or at pageCount', () => {
    const sections = [
      section('s1', 'A', 1, 1),
      section('s2', 'A', 2, 12),
      section('s3', 'A', 3, 20),
    ];
    const numbered = numberSections('4', sections, 30);

    expect(numbered.map((s) => s.endPage)).toEqual([11, 19, 30]);
    expect(numbered.map((s) => s.number)).toEqual(['4.1', '4.2', '4.3']);

    const lone = numberSections('4', [section('s1', 'A', 1, 5)], 30);
    expect(lone[0]).toMatchObject({ startPage: 5, endPage: 30 });

    // Not yet converted: the range never runs backwards.
    const unconverted = numberSections('4', [section('s1', 'A', 1, 5)], 0);
    expect(unconverted[0].endPage).toBe(5);
  });

  it('T10: PDF sections sort by startPage regardless of stored order', () => {
    const numbered = numberSections(
      '2',
      [section('s1', 'A', 1, 20), section('s2', 'A', 2, 3)],
      40,
    );

    expect(numbered.map((s) => [s.id, s.number])).toEqual([
      ['s2', '2.1'],
      ['s1', '2.2'],
    ]);
  });

  it('T11: written sections carry null pages and number by order', () => {
    const numbered = numberSections(
      '1',
      [section('b', 'A', 2), section('a', 'A', 1)],
      0,
    );

    expect(numbered.map((s) => s.id)).toEqual(['a', 'b']);
    expect(numbered.every((s) => s.startPage === null)).toBe(true);
    expect(numbered.every((s) => s.endPage === null)).toBe(true);
    expect(numbered.map((s) => s.number)).toEqual(['1.1', '1.2']);
  });

  it('T12: numbers are plain strings with no padding', () => {
    const chapters = Array.from({ length: 10 }, (_, i) =>
      chapter(`c${i + 1}`, null, i + 1),
    );
    const numbered = numberChapters(canonicalChapterOrder([], chapters));

    expect(numbered.get('c10')).toBe('10');
    expect(typeof numbered.get('c10')).toBe('string');
    expect(
      numberSections(
        '10',
        [section('x', 'c10', 1), section('y', 'c10', 2)],
        0,
      )[1].number,
    ).toBe('10.2');
  });

  it('decorates the very objects it is given, so callers keep their full rows', () => {
    const rows = [chapter('A', null, 1)];
    const result = tree([], rows);

    expect(result.flat[0]).toBe(rows[0]);
  });
});
