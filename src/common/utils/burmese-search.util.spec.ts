import { burmeseSearchKey, typedDigits } from './burmese-search.util';

/**
 * Pairs that must compare equal — each is a spelling a customer may type
 * for the name the admin saved (or the other way round).
 */
const SAME: Array<[string, string, string]> = [
  ['spaces inside a word', 'ငါး ကြီး', 'ငါးကြီး'],
  ['a no-break space', 'ငါး\u00a0ကြီး', 'ငါးကြီး'],
  ['a zero-width space pasted from a chat', 'ငါး\u200bကြီး', 'ငါးကြီး'],
  ['the ။ section mark', 'ဝက်။', 'ဝက်'],
  ['digit zero typed for wa', '၀က်', 'ဝက်'],
  ['digit seven typed for ra', '၇ထား', 'ရထား'],
  ['digit eight typed for ga', '၈ျောက်', 'ဂျောက်'],
  ['digit four typed for ၎', '၄င်း', '၎င်း'],
  ['nya typed for u', 'ဉက္ကဋ္ဌ', 'ဥက္ကဋ္ဌ'],
  ['nya and ii typed for ဦ', 'ဉီးထုပ်', 'ဦးထုပ်'],
  ['u and ii typed for ဦ', 'ဦး', 'ဦး'],
  ['a zero-width space inside ဦ', 'ဥ\u200bီး', 'ဦး'],
  ['i and u swapped', 'ကုိ', 'ကို'],
  ['ra and wa medials swapped', 'ကွြ', 'ကြွ'],
  ['anusvara before u', 'ကံု', 'ကုံ'],
  ['dot below and asat swapped', '\u1014\u103a\u1037', '\u1014\u1037\u103a'],
  ['e sign after the aa sign', 'ကာေ', 'ကော'],
  ['English case and spaces', 'Big Fish', 'bigfish'],
  ['leading and trailing blanks', '  မြွေ ', 'မြွေ'],
];

/** Pairs that must stay different: real words, not spellings of one word. */
const DIFFERENT: Array<[string, string, string]> = [
  ['a tone mark (visarga)', 'ငါး', 'ငါ'],
  ['a different consonant', 'ငါး', 'ညါး'],
  ['a different vowel', 'ကို', 'ကူ'],
  ['wa the letter vs the word pig', 'ဝ', 'ဝက်'],
  ['the ya and ra medials', 'ကျ', 'ကြ'],
  ['a short vs a long vowel', 'ကု', 'ကူ'],
];

describe('burmeseSearchKey', () => {
  it.each(SAME)('reads %s as the same word', (_why, a, b) => {
    expect(burmeseSearchKey(a)).toBe(burmeseSearchKey(b));
  });

  it.each(DIFFERENT)('keeps %s apart', (_why, a, b) => {
    expect(burmeseSearchKey(a)).not.toBe(burmeseSearchKey(b));
  });

  it('is empty for blank input', () => {
    expect(burmeseSearchKey('')).toBe('');
    expect(burmeseSearchKey(' \u200b ')).toBe('');
  });

  it('keeps a correctly spelled name unchanged apart from case', () => {
    expect(burmeseSearchKey('မြွေ')).toBe('မြွေ');
    expect(burmeseSearchKey('ချစ်ခြင်း')).toBe('ချစ်ခြင်း');
    expect(burmeseSearchKey('ဦးထုပ်')).toBe('ဦးထုပ်');
    expect(burmeseSearchKey('Snake')).toBe('snake');
  });

  it('lets "contains" find a name typed with any of these differences', () => {
    const name = burmeseSearchKey('ငါး ကြီး');
    for (const typed of ['ငါးကြီး', 'ကြီး', 'ငါး', 'ါးကြ']) {
      expect(name).toContain(burmeseSearchKey(typed));
    }
  });
});

describe('typedDigits', () => {
  it.each([
    ['27', '27'],
    ['027', '027'],
    ['၀၂၇', '027'],
    ['၂ ၇', '27'],
    ['0-2-7', '027'],
    ['0.2.7', '027'],
    ['ဝ၂၇', '027'],
    ['၂ရ', '27'],
    ['1ဂ', '18'],
  ])('reads %s as the number %s', (typed, digits) => {
    expect(typedDigits(typed)).toBe(digits);
  });

  it.each(['', '   ', 'ဝ', 'ဝက်', 'ရ', 'Snake', 'မြွေ', '2a', '၂က'])(
    'does not read %s as a number',
    (typed) => {
      expect(typedDigits(typed)).toBeNull();
    },
  );
});
