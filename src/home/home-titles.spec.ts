import {
  BOOK_CARD_SELECT,
  DESCRIPTION_PREVIEW,
  MOVIE_CARD_SELECT,
  SERIES_CARD_SELECT,
  bookCard,
  descriptionPreview,
  movieCard,
  seriesCard,
} from './home-titles';

/** The Burmese stacking sign (virama) and a combining mark test, by code point. */
const STACKING_SIGN = String.fromCodePoint(0x1039);
const isMark = (character: string) => /^\p{M}$/u.test(character);

describe('descriptionPreview', () => {
  it('returns a short text as it is, with its whitespace collapsed', () => {
    expect(descriptionPreview('  A   film\nabout lanterns ')).toBe(
      'A film about lanterns',
    );
    expect(descriptionPreview('')).toBe('');
    expect(descriptionPreview(null)).toBe('');
    expect(descriptionPreview(undefined)).toBe('');
  });

  it(`leaves a text of exactly ${DESCRIPTION_PREVIEW} characters alone`, () => {
    const text = 'a'.repeat(DESCRIPTION_PREVIEW);
    expect(descriptionPreview(text)).toBe(text);
  });

  it('cuts a longer Latin text to the first 299 letters and an ellipsis — exactly as it always did', () => {
    const text = 'abcdefghij'.repeat(40);

    const preview = descriptionPreview(text);

    expect(preview).toBe(`${text.slice(0, DESCRIPTION_PREVIEW - 1)}…`);
    expect(preview).toHaveLength(DESCRIPTION_PREVIEW);
  });

  describe('Burmese is never cut in the middle of a letter', () => {
    // One syllable is a consonant with marks on it: several code units,
    // one character to a reader.
    const syllables = ['ကြွ', 'မြို့', 'ကျော်', 'ရွှေ', 'ပြည်', 'သူ', 'ခိုး'];
    const long = (offset: number) =>
      'x'.repeat(offset) + syllables.join('').repeat(60);

    it.each([0, 1, 2, 3, 4, 5, 6, 7])(
      'wherever the limit falls (text shifted by %d)',
      (offset) => {
        const text = long(offset);

        const preview = descriptionPreview(text);

        expect(preview.endsWith('…')).toBe(true);
        expect(preview.length).toBeLessThanOrEqual(DESCRIPTION_PREVIEW);
        const kept = preview.slice(0, -1);
        expect(text.startsWith(kept)).toBe(true);
        // The first character left out starts a new letter: it is not a
        // mark that belonged on the last letter kept.
        const next = String.fromCodePoint(text.codePointAt(kept.length)!);
        expect(isMark(next)).toBe(false);
        // And nearly the whole budget is used (a syllable is a few units).
        expect(kept.length).toBeGreaterThan(DESCRIPTION_PREVIEW - 12);
      },
    );

    it('keeps the vowel sign aa and the visarga with their letter (Unicode would let them stand alone)', () => {
      // "ကား" is က + ာ + း: three code units, one syllable. Shift it so the
      // budget ends after each unit in turn.
      for (const offset of [0, 1, 2]) {
        const text =
          'x'.repeat(DESCRIPTION_PREVIEW - 3 + offset) + 'ကား' + 'y'.repeat(50);

        const kept = descriptionPreview(text).slice(0, -1);

        // Either the whole syllable is in, or none of it.
        expect(kept.endsWith('က') || kept.endsWith('ကာ')).toBe(false);
      }
    });

    it('does not keep only the top half of a stacked pair', () => {
      // က + stacking sign + က is drawn as one stack. Place it so the budget
      // ends right after the stacking sign.
      const stack = `က${STACKING_SIGN}က`;
      const text = 'x'.repeat(DESCRIPTION_PREVIEW - 3) + stack + 'y'.repeat(50);

      const preview = descriptionPreview(text);

      const kept = preview.slice(0, -1);
      expect(kept.endsWith(STACKING_SIGN)).toBe(false);
      expect(kept).toBe('x'.repeat(DESCRIPTION_PREVIEW - 3));
    });
  });

  it('never splits a character made of several code units (an emoji)', () => {
    // A family emoji: four people joined by zero-width joiners, 11 units.
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466]
      .map((codePoint) => String.fromCodePoint(codePoint))
      .join('');
    const text = 'a'.repeat(DESCRIPTION_PREVIEW - 5) + family + 'b'.repeat(50);

    expect(descriptionPreview(text)).toBe(
      `${'a'.repeat(DESCRIPTION_PREVIEW - 5)}…`,
    );
  });
});

describe('title cards — the description in each language', () => {
  const movieRow = {
    id: 'movie-1',
    title: 'Lanterns',
    description: '  A   film\nabout lanterns ',
    descriptionMm: '  မီးပုံးများ\nအကြောင်း  ဇာတ်ကား ',
    posterUrl: null,
    coverUrl: null,
    thumbnailUrl: null,
    genre: 'Drama',
    releaseYear: 2026,
    duration: 100,
    rating: 8,
    accessType: 'FREE' as const,
    ageRating: null,
  };
  const seriesRow = {
    id: 'series-1',
    title: 'Rain Season',
    description: 'A series',
    descriptionMm: 'ဇာတ်လမ်းတွဲ',
    posterUrl: null,
    coverUrl: null,
    genre: 'Drama',
    releaseYear: 2026,
    rating: 0,
    accessType: 'SUBSCRIPTION' as const,
  };

  it('reads descriptionMm for movies and series, and not for books (Book has no such column)', () => {
    expect(MOVIE_CARD_SELECT).toMatchObject({
      description: true,
      descriptionMm: true,
    });
    expect(SERIES_CARD_SELECT).toMatchObject({
      description: true,
      descriptionMm: true,
    });
    expect(BOOK_CARD_SELECT).not.toHaveProperty('descriptionMm');
  });

  it('a movie card carries both texts, each collapsed like the other', () => {
    expect(movieCard(movieRow)).toMatchObject({
      type: 'MOVIE',
      description: 'A film about lanterns',
      descriptionMm: 'မီးပုံးများ အကြောင်း ဇာတ်ကား',
    });
  });

  it('a series card carries both texts', () => {
    expect(seriesCard(seriesRow)).toMatchObject({
      type: 'SERIES',
      description: 'A series',
      descriptionMm: 'ဇာတ်လမ်းတွဲ',
    });
  });

  it.each([null, '', '   '])(
    'descriptionMm is null when the title has no Burmese text (%p), so the client falls back to the English one',
    (descriptionMm) => {
      expect(movieCard({ ...movieRow, descriptionMm })).toHaveProperty(
        'descriptionMm',
        null,
      );
      expect(seriesCard({ ...seriesRow, descriptionMm })).toHaveProperty(
        'descriptionMm',
        null,
      );
    },
  );

  it('shortens a long Burmese description the way it shortens the English one', () => {
    const card = movieCard({
      ...movieRow,
      descriptionMm: 'မြို့ငယ်လေး '.repeat(80),
    });

    expect(card.descriptionMm!.length).toBeLessThanOrEqual(DESCRIPTION_PREVIEW);
    expect(card.descriptionMm!.endsWith('…')).toBe(true);
  });

  it('a book card always answers descriptionMm: null', () => {
    expect(
      bookCard({
        id: 'book-1',
        title: 'Golden Letters',
        author: 'Ma Ma',
        description: 'A book',
        coverUrl: null,
      }),
    ).toMatchObject({
      type: 'BOOK',
      description: 'A book',
      descriptionMm: null,
    });
  });
});
