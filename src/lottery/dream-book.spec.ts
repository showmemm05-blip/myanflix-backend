import { LotteryDreamBook } from '../generated/prisma/client';
import {
  bookFromWire,
  bookToWire,
  DREAM_BOOK_WIRE,
  dreamNumberWidth,
  isDreamBookWire,
  normalizeDreamNumber,
} from './dream-book';

describe('dream books', () => {
  it('maps the two wire spellings to the enum and back', () => {
    expect(bookFromWire('1000')).toBe(LotteryDreamBook.DREAM_1000);
    expect(bookFromWire('100')).toBe(LotteryDreamBook.DREAM_100);
    for (const wire of DREAM_BOOK_WIRE) {
      expect(bookToWire(bookFromWire(wire))).toBe(wire);
    }
  });

  it('recognises only the two spellings, as strings', () => {
    expect(isDreamBookWire('1000')).toBe(true);
    expect(isDreamBookWire('100')).toBe(true);
    for (const value of ['10', '01000', 'DREAM_1000', 1000, '', null]) {
      expect(isDreamBookWire(value)).toBe(false);
    }
  });

  it('knows the digit width of each book', () => {
    expect(dreamNumberWidth(LotteryDreamBook.DREAM_1000)).toBe(3);
    expect(dreamNumberWidth(LotteryDreamBook.DREAM_100)).toBe(2);
  });

  describe('normalizeDreamNumber', () => {
    it.each([
      ['27', '027'],
      [' 27 ', '027'],
      ['027', '027'],
      ['0027', '027'],
      ['0', '000'],
      ['000', '000'],
      ['999', '999'],
    ])('1000 book: %p -> %p', (raw, expected) => {
      expect(normalizeDreamNumber(LotteryDreamBook.DREAM_1000, raw)).toBe(
        expected,
      );
    });

    it.each([
      ['7', '07'],
      ['07', '07'],
      ['99', '99'],
      ['007', '07'],
    ])('100 book: %p -> %p', (raw, expected) => {
      expect(normalizeDreamNumber(LotteryDreamBook.DREAM_100, raw)).toBe(
        expected,
      );
    });

    it('refuses anything that is not a number of the book', () => {
      const cases: Array<[LotteryDreamBook, string]> = [
        [LotteryDreamBook.DREAM_1000, '1234'],
        [LotteryDreamBook.DREAM_1000, '2a'],
        [LotteryDreamBook.DREAM_1000, '-1'],
        [LotteryDreamBook.DREAM_1000, '1.5'],
        [LotteryDreamBook.DREAM_1000, ''],
        [LotteryDreamBook.DREAM_1000, '   '],
        [LotteryDreamBook.DREAM_100, '123'],
        [LotteryDreamBook.DREAM_100, '0123'],
      ];
      for (const [book, raw] of cases) {
        expect({ book, raw, result: normalizeDreamNumber(book, raw) }).toEqual({
          book,
          raw,
          result: null,
        });
      }
    });
  });
});
