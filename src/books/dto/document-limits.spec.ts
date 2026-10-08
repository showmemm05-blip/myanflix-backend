import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBookChapterDto, UpdateBookChapterDto } from './chapter.dto';
import { CreateBookSectionDto, UpdateBookSectionDto } from './section.dto';
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  MAX_DOCUMENT_NODES,
  MAX_SECTIONS_PER_CHAPTER,
  documentLimitViolation,
  measureDocument,
} from './document-limits';

/** A TipTap doc of `count` short paragraphs. */
const paragraphs = (count: number, text = 'Once upon a time.') => ({
  type: 'doc',
  content: Array.from({ length: count }, () => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
});

/** A doc nested `levels` deep (bulletList > listItem > bulletList > ...). */
const nested = (levels: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { type: 'paragraph' };
  for (let i = 0; i < levels; i++) {
    node = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [node] }],
    };
  }
  return { type: 'doc', content: [node] };
};

const errorsFor = async (dto: object) =>
  (await validate(dto)).flatMap((e) => Object.values(e.constraints ?? {}));

describe('document limits (M-8)', () => {
  describe('documentLimitViolation / measureDocument', () => {
    it('is null for an ordinary chapter', () => {
      const doc = paragraphs(400);
      expect(documentLimitViolation(doc)).toBeNull();
      const m = measureDocument(doc);
      expect(m.nodes).toBeGreaterThan(400);
      expect(m.bytes).toBeLessThan(MAX_DOCUMENT_BYTES);
      expect(m.depth).toBe(5);
    });

    it('names the byte limit for a document over 2 MB serialised', () => {
      const big = paragraphs(1, 'x'.repeat(MAX_DOCUMENT_BYTES));
      expect(documentLimitViolation(big)).toMatch(
        /bytes serialised — the limit is/,
      );
    });

    it(`names the node limit past ${MAX_DOCUMENT_NODES} nodes, even when the bytes are small`, () => {
      // Each paragraph is 3 containers (paragraph, content[], text).
      const many = paragraphs(Math.ceil(MAX_DOCUMENT_NODES / 3) + 1, 'a');
      expect(measureDocument(many).bytes).toBeLessThan(MAX_DOCUMENT_BYTES);
      expect(documentLimitViolation(many)).toMatch(/more than 50000 nodes/);
    });

    it(`names the depth limit past ${MAX_DOCUMENT_DEPTH} levels`, () => {
      expect(documentLimitViolation(nested(10))).toBeNull();
      expect(documentLimitViolation(nested(40))).toMatch(
        /nested deeper than 64 levels/,
      );
    });

    it('stops walking as soon as a ceiling is passed — a hostile document costs at most the ceiling', () => {
      const doc = paragraphs(200_000, 'a');
      const started = Date.now();
      expect(documentLimitViolation(doc)).toMatch(/nodes/);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  describe('the chapter and section DTOs refuse an oversized document', () => {
    const huge = paragraphs(1, 'x'.repeat(MAX_DOCUMENT_BYTES));

    it.each([
      ['CreateBookChapterDto', CreateBookChapterDto, { title: 'T' }],
      ['UpdateBookChapterDto', UpdateBookChapterDto, {}],
      ['CreateBookSectionDto', CreateBookSectionDto, { title: 'T' }],
      ['UpdateBookSectionDto', UpdateBookSectionDto, {}],
    ])(
      '%s: 400 with a reason, instead of storing it',
      async (_name, cls, base) => {
        const dto = plainToInstance(cls as never, { ...base, content: huge });
        const errors = await errorsFor(dto as object);
        expect(errors.join(' ')).toMatch(
          /content is too large: the document is \d+ bytes serialised/,
        );
      },
    );

    it.each([
      ['CreateBookChapterDto', CreateBookChapterDto, { title: 'T' }],
      ['CreateBookSectionDto', CreateBookSectionDto, { title: 'T' }],
    ])(
      '%s: a normal document still passes, and a missing one is still optional',
      async (_name, cls, base) => {
        expect(
          await errorsFor(
            plainToInstance(cls as never, {
              ...base,
              content: paragraphs(50),
            }) as object,
          ),
        ).toEqual([]);
        expect(
          await errorsFor(plainToInstance(cls as never, base) as object),
        ).toEqual([]);
      },
    );

    it('a deeply nested document is refused with the depth reason', async () => {
      const dto = plainToInstance(UpdateBookChapterDto, {
        content: nested(40),
      });
      expect((await errorsFor(dto)).join(' ')).toMatch(/nested deeper than/);
    });

    it("a non-object content is @IsObject()'s failure, not a limit failure", async () => {
      const dto = plainToInstance(UpdateBookChapterDto, { content: 'nope' });
      const errors = await errorsFor(dto);
      expect(errors.join(' ')).toMatch(/object/);
      expect(errors.join(' ')).not.toMatch(/too large/);
    });
  });

  it('caps sections per chapter at a number the chapter response can carry', () => {
    expect(MAX_SECTIONS_PER_CHAPTER).toBe(500);
  });
});
