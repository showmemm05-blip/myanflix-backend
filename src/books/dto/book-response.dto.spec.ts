import { toChapterDetail, toChapterSummary } from './book-response.dto';
import type { BookChapter } from '../../generated/prisma/client';

/**
 * Guards the one bug that cost a chapter-image upload: a chapter row carries
 * `pdfFileSize` as a BigInt, and JSON.stringify throws on BigInt. Returning a
 * raw row therefore 500s AFTER the write has already committed — the client
 * sees a failure that was actually a success, which is the worst shape a bug
 * can take. TypeScript cannot catch it (BigInt is a perfectly good type), so
 * it has to be caught here.
 */
describe('chapter response mappers', () => {
  const chapter = (over: Partial<BookChapter> = {}): BookChapter =>
    ({
      id: 'chapter-1',
      editionId: 'edition-1',
      title: 'Chapter 1',
      imageUrl: null,
      content: null,
      order: 1,
      status: 'READY',
      pdfKey: 'books/b/e/c/original.pdf',
      pdfFileSize: BigInt(4096),
      pageCount: 12,
      processedPages: 12,
      processingError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as BookChapter;

  const resolve = (url: string | null | undefined) => url ?? null;

  it('turns a PDF chapter into something JSON can actually serialise', () => {
    const summary = toChapterSummary(chapter(), resolve);

    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(summary.pdfFileSize).toBe(4096);
    expect(typeof summary.pdfFileSize).toBe('number');
  });

  it('does the same for the detail shape the editor loads', () => {
    const detail = toChapterDetail(chapter({ content: { type: 'doc' } }), resolve);

    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail.content).toEqual({ type: 'doc' });
  });

  it('leaves a written chapter (no file) alone', () => {
    const summary = toChapterSummary(
      chapter({ pdfFileSize: null, pdfKey: null, pageCount: 0 }),
      resolve,
    );

    expect(summary.pdfFileSize).toBeNull();
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('gives a bare row the hierarchy defaults every existing book relies on', () => {
    const summary = toChapterSummary(chapter({ order: 4 }), resolve);

    expect(summary.partId).toBeNull();
    expect(summary.number).toBe('4');
    expect(summary.sections).toEqual([]);
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('passes a decorated row\'s number and sections straight through', () => {
    const decorated = Object.assign(chapter({ order: 4, partId: 'part-1' }), {
      number: '2',
      sections: [
        {
          id: 's1',
          chapterId: 'chapter-1',
          title: 'Opening',
          order: 1,
          content: { type: 'doc' },
          startPage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          number: '2.1',
          endPage: null,
        },
      ],
    });

    const summary = toChapterSummary(decorated, resolve);
    expect(summary.partId).toBe('part-1');
    expect(summary.number).toBe('2');
    expect(summary.sections).toEqual([
      expect.objectContaining({ id: 's1', number: '2.1', startPage: null }),
    ]);
    expect(summary.sections[0]).not.toHaveProperty('content');

    const detail = toChapterDetail(decorated, resolve);
    expect(detail.sections[0]).toMatchObject({
      id: 's1',
      number: '2.1',
      content: { type: 'doc' },
    });
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it('re-hosts the chapter image through the resolver it is given', () => {
    const summary = toChapterSummary(
      chapter({ imageUrl: 'http://stale-host/movies/images/c.webp' }),
      () => 'http://current-host/movies/images/c.webp',
    );

    expect(summary.imageUrl).toBe('http://current-host/movies/images/c.webp');
  });
});
