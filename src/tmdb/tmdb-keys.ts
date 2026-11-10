/**
 * The two "same word?" keys of the TMDB module. TMDB's spelling of a film,
 * a genre or a person rarely equals ours character for character
 * (`Chloë Grace Moretz` / `Chloe Grace Moretz`, `Sci-Fi` / `Sci Fi`,
 * `Fast & Furious` / `Fast and Furious`), so every comparison goes through
 * a key that keeps only what a reader would call the same.
 */
import { orderMarks } from '../common/utils/burmese-search.util';

function decompose(text: string): string {
  try {
    return text.normalize('NFKD');
  } catch {
    // A runtime without Unicode tables: compare the text as written.
    return text;
  }
}

/**
 * The accents NFKD splits off a Latin, Greek or Cyrillic letter (U+0300 to
 * U+036F) — the only marks a key drops. Every other mark is part of the
 * word: a Burmese, Thai or Indic vowel sign, the voicing mark of a Japanese
 * kana. Dropping those would leave bare consonants, and
 * ကျော်ကျော် and ကိုကို, or မိုး and မီး, would count as one name.
 */
const LATIN_ACCENTS = /[\u0300-\u036f]/g;

/**
 * A run of two or more Burmese marks (U+102B to U+103E: vowel signs, medials,
 * asat, virama). Most of them have no fixed order in Unicode, so NFKD leaves
 * them as typed, and one name typed with its marks in another order looks
 * the same on screen yet is another text. Every run is put in the one order
 * the dream search uses (common/utils/burmese-search.util.ts), so both
 * spellings are one key and the actor we already have is found.
 */
const BURMESE_MARK_RUN = /[\u102b-\u103e]{2,}/g;

/**
 * The key of a title, a genre or a category name: accents and case gone,
 * `&` read as "and", then only letters, digits and the marks that belong
 * to them kept, Burmese marks in one order. `Sci-Fi` and `sci fi` are
 * `scifi`; `War & Politics` is `warandpolitics`. This is the `norm()` of
 * the one-clear-match rule and the `key()` of the category rule (PLAN.md
 * 2.5 and 2.7 of docs/movie-details-tmdb-2026-11-06) — with one
 * difference from the plan's formula: it says "remove \p{M}", which is
 * right for accents only.
 */
export function wordKey(text: string): string {
  return decompose(text)
    .replace(LATIN_ACCENTS, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
    .replace(BURMESE_MARK_RUN, orderMarks);
}

/**
 * The key of a person's name: accents and case gone, only letters, digits
 * and the marks that belong to them kept, Burmese marks in one order —
 * `Lee Byung-hun` and `Lee Byung Hun` are one person. No `&` rule: a name
 * has none (PLAN.md 2.10, with the same difference as wordKey).
 */
export function nameKey(text: string): string {
  return decompose(text)
    .replace(LATIN_ACCENTS, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '')
    .replace(BURMESE_MARK_RUN, orderMarks);
}

/** The first `max` characters of a trimmed text, never ending on half of a two-unit character. */
export function cutText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const last = trimmed.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return trimmed.slice(0, splitsPair ? max - 1 : max).trimEnd();
}
