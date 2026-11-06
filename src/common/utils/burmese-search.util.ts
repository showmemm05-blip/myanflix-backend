/**
 * Search keys for text people type in Burmese or English — the dream books'
 * search box, where "No dream found" is what a customer sees whenever their
 * spelling of a name differs from the admin's by something they cannot see.
 *
 * Two spellings of one Burmese word look identical on screen yet compare
 * different, for these reasons, which the key removes:
 *   - spaces and hidden characters ("ငါး ကြီး" vs "ငါးကြီး", a zero-width
 *     space pasted from a chat, the ၊ ။ section marks);
 *   - look-alike characters: the digit ၀ typed for the letter ဝ, ၇ for ရ,
 *     ၈ for ဂ, ၄ for ၎ (၎င်း), and ဉ for ဥ;
 *   - the order of a syllable's marks (ကို typed as ကုိ, ကြွ as ကွြ): Unicode
 *     NFC fixes only a few of these, so every run of marks is put in one
 *     fixed order;
 *   - letter case, for English names.
 * Zawgyi text is NOT converted: that is a different encoding, not a spelling.
 *
 * Mirrored in the phone app (mobile/src/utils/burmeseSearch.ts), which
 * searches the downloaded book itself — keep the two in step.
 */

/** Digits ၀-၉ and letters typed for them, read as a number. */
const LOOKALIKE_TO_LETTER: ReadonlyMap<string, string> = new Map([
  ['\u1040', '\u101d'], // ၀ zero  → ဝ wa
  ['\u1047', '\u101b'], // ၇ seven → ရ ra
  ['\u1048', '\u1002'], // ၈ eight → ဂ ga
  ['\u1044', '\u104e'], // ၄ four  → ၎ (as in ၎င်း)
  ['\u1009', '\u1025'], // ဉ nya   → ဥ u
]);
const LETTER_TO_DIGIT: ReadonlyMap<string, string> = new Map([
  ['\u101d', '0'],
  ['\u101b', '7'],
  ['\u1002', '8'],
  ['\u104e', '4'],
]);

/**
 * One fixed order for the marks that follow a consonant: medials, then ေ,
 * then the other vowel signs, then ံ ့ ် း, with the stacking virama last so
 * it stays next to the consonant it stacks. Marks of the same rank keep the
 * order they were typed in (ိ and ု never share a rank, nor do ြ and ွ).
 */
const MARK_RANK: Readonly<Record<string, number>> = {
  '\u103b': 1, // ျ
  '\u103c': 2, // ြ
  '\u103d': 3, // ွ
  '\u103e': 4, // ှ
  '\u1031': 5, // ေ
  '\u102b': 6, // ါ
  '\u102c': 6, // ာ
  '\u102d': 7, // ိ
  '\u102e': 7, // ီ
  '\u1032': 7, // ဲ
  '\u1033': 7,
  '\u1034': 7,
  '\u1035': 7,
  '\u102f': 8, // ု
  '\u1030': 8, // ူ
  '\u1036': 9, // ံ
  '\u1037': 10, // ့
  '\u103a': 11, // ်
  '\u1038': 12, // း
  '\u1039': 13, // ္ (stacks the next consonant)
};

/** Whitespace, no-break and zero-width characters, and the Burmese ၊ ။ marks. */
const HIDDEN = /[\s\u00a0\u200b-\u200d\u2060\ufeff\u104a\u104b]/g;
/** What people put between the digits of a number: spaces, dots, dashes, middots. */
const DIGIT_SEPARATORS = /[\s.\-\u00b7\u00a0\u200b-\u200d\u2060\ufeff]/g;

function nfc(text: string): string {
  try {
    return text.normalize('NFC');
  } catch {
    // A runtime without Unicode tables: compare the text as typed.
    return text;
  }
}

function orderMarks(run: string): string {
  return Array.from(run)
    .map((mark, index) => ({ mark, index, rank: MARK_RANK[mark] ?? 99 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.mark)
    .join('');
}

/**
 * The key a name and a search are both reduced to before "contains" is
 * asked: "" for blank input.
 */
export function burmeseSearchKey(text: string): string {
  // NFC runs AFTER the look-alikes are mapped and the hidden characters are
  // gone, so ဥ + ီ composes to ဦ (U+1026) whether the person typed ဦ, ဦ,
  // the look-alike ဉီ, or left a zero-width space in between.
  return nfc(
    text
      .replace(
        /[\u1040\u1047\u1048\u1044\u1009]/g,
        (ch) => LOOKALIKE_TO_LETTER.get(ch) ?? ch,
      )
      .replace(HIDDEN, ''),
  )
    .toLowerCase()
    .replace(/[\u102b-\u103e]{2,}/g, orderMarks);
}

/**
 * The digits of a number the person typed — ASCII or Burmese digits, with
 * the letters that look like digits (ဝ ရ ဂ ၎) read as such when they stand
 * next to real digits — or null when the text is not a number. "၀၂၇" → "027",
 * "ဝ၂၇" → "027", "2 7" → "27"; "ဝက်" and "ဝ" alone → null (those are words).
 */
export function typedDigits(text: string): string | null {
  const compact = nfc(text).replace(DIGIT_SEPARATORS, '');
  if (!compact) return null;
  let digits = '';
  let sawDigit = false;
  for (const ch of compact) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) {
      digits += ch;
      sawDigit = true;
    } else if (code >= 0x1040 && code <= 0x1049) {
      digits += String.fromCharCode(code - 0x1040 + 0x30);
      sawDigit = true;
    } else {
      const asDigit = LETTER_TO_DIGIT.get(ch);
      if (asDigit === undefined) return null;
      digits += asDigit;
    }
  }
  return sawDigit ? digits : null;
}
