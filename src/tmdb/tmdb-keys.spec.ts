import { cutText, nameKey, wordKey } from './tmdb-keys';

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
