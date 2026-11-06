import { LotteryDreamBook } from '../generated/prisma/client';

/**
 * The two dream books as every client spells them: "1000" is the book of
 * 3-digit numbers 000-999, "100" the book of 2-digit numbers 00-99. The
 * database stores the LotteryDreamBook enum; these helpers are the only
 * place the two spellings meet.
 */
export const DREAM_BOOK_WIRE = ['1000', '100'] as const;

export type DreamBookWire = (typeof DREAM_BOOK_WIRE)[number];

const BOOK_FROM_WIRE: Record<DreamBookWire, LotteryDreamBook> = {
  '1000': LotteryDreamBook.DREAM_1000,
  '100': LotteryDreamBook.DREAM_100,
};

const WIRE_FROM_BOOK: Record<LotteryDreamBook, DreamBookWire> = {
  [LotteryDreamBook.DREAM_1000]: '1000',
  [LotteryDreamBook.DREAM_100]: '100',
};

/** How many digits a number of each book has. */
const NUMBER_WIDTH: Record<LotteryDreamBook, number> = {
  [LotteryDreamBook.DREAM_1000]: 3,
  [LotteryDreamBook.DREAM_100]: 2,
};

export function isDreamBookWire(value: unknown): value is DreamBookWire {
  return DREAM_BOOK_WIRE.includes(value as DreamBookWire);
}

export function bookFromWire(wire: DreamBookWire): LotteryDreamBook {
  return BOOK_FROM_WIRE[wire];
}

export function bookToWire(book: LotteryDreamBook): DreamBookWire {
  return WIRE_FROM_BOOK[book];
}

export function dreamNumberWidth(book: LotteryDreamBook): number {
  return NUMBER_WIDTH[book];
}

/**
 * The stored form of a number typed or imported for `book`: digits only,
 * zero-padded to the book's width ("27" -> "027" in the 1000 book, "7" ->
 * "07" in the 100 book). Null when it is not a number of that book — not
 * all digits, or more digits than the book has once extra leading zeros
 * ("0027") are dropped.
 */
export function normalizeDreamNumber(
  book: LotteryDreamBook,
  raw: string,
): string | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const significant = text.replace(/^0+(?=\d)/, '');
  const width = dreamNumberWidth(book);
  if (significant.length > width) return null;
  return significant.padStart(width, '0');
}
