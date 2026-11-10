import { cutText, nameKey, wordKey } from './tmdb-keys';

/** A text spelled out by code point, so the order of its marks can be seen. */
const typed = (...codes: number[]) => String.fromCharCode(...codes);

describe('wordKey — the "same title / same genre?" key', () => {
  it.each([
    ['Sci-Fi', 'scifi'],
    ['sci fi', 'scifi'],
    ['SCI_FI', 'scifi'],
    ['War & Politics', 'warandpolitics'],
    ['War and Politics', 'warandpolitics'],
    ['Amélie', 'amelie'],
    ['Spider-Man: No Way Home', 'spidermannowayhome'],
    ['  The   Dark Knight ', 'thedarkknight'],
    ['!!!', ''],
    ['', ''],
  ])('%p -> %p', (text, key) => {
    expect(wordKey(text)).toBe(key);
  });

  it('reads the same film written two ways as one', () => {
    expect(wordKey('Fast & Furious')).toBe(wordKey('fast and furious'));
    expect(wordKey('WALL·E')).toBe(wordKey('Wall-E'));
  });

  it('keeps the letters of every script — a Korean or Burmese title still has a key', () => {
    expect(wordKey('기생충')).not.toBe('');
    expect(wordKey('기생충 ')).toBe(wordKey('기생충'));
    expect(wordKey('기생충')).not.toBe(wordKey('괴물'));
    expect(wordKey('ပန်းသီး')).not.toBe('');
  });

  it('keeps the vowel signs and marks of other scripts — another vowel is another word', () => {
    // Burmese "rain" and "fire": the same consonant, different marks.
    expect(wordKey('မိုး')).not.toBe(wordKey('မီး'));
    // Thai, Devanagari, and the voicing mark of a Japanese kana (NFKD
    // splits it off the letter, like an accent).
    expect(wordKey('กิน')).not.toBe(wordKey('กัน'));
    expect(wordKey('राम')).not.toBe(wordKey('रोम'));
    expect(wordKey('バード')).not.toBe(wordKey('ハート'));
    // The same word is still one key, however it is spaced or punctuated.
    expect(wordKey(' မိုး! ')).toBe(wordKey('မိုး'));
    expect(wordKey('バード')).toBe(wordKey('バ ー ド'));
  });

  it('one Burmese word typed with its marks in another order is one key', () => {
    // "ko": ka, then the vowel signs i and u — and the same two signs the
    // other way round. Both look alike on screen; Unicode gives these marks
    // no fixed order, so NFKD leaves them as typed.
    const usual = typed(0x1000, 0x102d, 0x102f);
    const swapped = typed(0x1000, 0x102f, 0x102d);
    expect(swapped).not.toBe(usual);
    expect(wordKey(swapped)).toBe(wordKey(usual));
    // Two medials (ya, wa), and a vowel sign with the dot above.
    expect(wordKey(typed(0x1000, 0x103d, 0x103b))).toBe(
      wordKey(typed(0x1000, 0x103b, 0x103d)),
    );
    expect(wordKey(typed(0x1000, 0x1036, 0x102f))).toBe(
      wordKey(typed(0x1000, 0x102f, 0x1036)),
    );
    // A hidden character between two marks does not keep them apart.
    expect(wordKey(typed(0x1000, 0x102f, 0x200b, 0x102d))).toBe(wordKey(usual));
  });
});

describe('nameKey — the "same person?" key', () => {
  it.each([
    ['Chloë Grace Moretz', 'chloegracemoretz'],
    ['Chloe Grace Moretz', 'chloegracemoretz'],
    ['Lee Byung-hun', 'leebyunghun'],
    ['Lee Byung Hun', 'leebyunghun'],
    ["Lupita Nyong'o", 'lupitanyongo'],
    ['  TOM   HANKS ', 'tomhanks'],
    ['---', ''],
  ])('%p -> %p', (text, key) => {
    expect(nameKey(text)).toBe(key);
  });

  it('has no "&" rule — a name has none', () => {
    expect(nameKey('A & B')).toBe('ab');
    expect(wordKey('A & B')).toBe('aandb');
  });

  it('two Burmese names with the same consonants are two people', () => {
    // Kyaw Kyaw / Ko Ko, Maung Maung / Min Min: only the marks differ.
    expect(nameKey('ကျော်ကျော်')).not.toBe(nameKey('ကိုကို'));
    expect(nameKey('မောင်မောင်')).not.toBe(nameKey('မင်းမင်း'));
    // One name written with and without a space is still one person.
    expect(nameKey('ကျော် ကျော်')).toBe(nameKey('ကျော်ကျော်'));
  });

  it('one Burmese name typed with its marks in another order is one person', () => {
    // Ko Ko with i before u in both syllables, and with u before i: the
    // two look the same, and an actor typed by hand may be either.
    const usual = typed(0x1000, 0x102d, 0x102f, 0x1000, 0x102d, 0x102f);
    const swapped = typed(0x1000, 0x102f, 0x102d, 0x1000, 0x102f, 0x102d);
    expect(swapped).not.toBe(usual);
    expect(nameKey(swapped)).toBe(nameKey(usual));
    expect(nameKey(typed(0x1000, 0x103d, 0x103b))).toBe(
      nameKey(typed(0x1000, 0x103b, 0x103d)),
    );
    // Still not Kyaw Kyaw: the marks themselves differ, not their order.
    expect(nameKey(swapped)).not.toBe(
      nameKey(typed(0x1000, 0x103b, 0x1031, 0x102c, 0x103a).repeat(2)),
    );
  });
});

describe('cutText', () => {
  it('trims and leaves a short text alone', () => {
    expect(cutText('  Inception  ', 200)).toBe('Inception');
  });

  it('cuts to the limit and drops a trailing blank the cut left behind', () => {
    expect(cutText('abcde fghij', 6)).toBe('abcde');
    expect(cutText('abcdefghij', 4)).toBe('abcd');
  });

  it('never ends on half of a two-unit character', () => {
    // '😀' is two UTF-16 units; a cut in its middle would leave a lone half.
    const cut = cutText('ab😀cd', 3);
    expect(cut).toBe('ab');
    expect(cutText('ab😀cd', 4)).toBe('ab😀');
  });
});
