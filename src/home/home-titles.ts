import {
  BookStatus,
  HomePromoCtaTarget,
  MovieStatus,
  Prisma,
  SeriesStatus,
  type AccessType,
  type AgeRating,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** The ctaTargets that point at a catalogue title through `targetId`. */
export type TitleTargetType = 'MOVIE' | 'SERIES' | 'BOOK';

export const TITLE_TARGETS: readonly HomePromoCtaTarget[] = [
  HomePromoCtaTarget.MOVIE,
  HomePromoCtaTarget.SERIES,
  HomePromoCtaTarget.BOOK,
];

export function isTitleTarget(
  target: HomePromoCtaTarget | null | undefined,
): target is TitleTargetType {
  return !!target && TITLE_TARGETS.includes(target);
}

/**
 * The minimal card a home surface needs to draw a linked title — one shape
 * for all three kinds, with null where a field does not apply (a book has no
 * runtime, a movie no author). Never playback data: GET /home/showcase is
 * open to guests.
 */
export interface ShowcaseTitle {
  type: TitleTargetType;
  id: string;
  title: string;
  /** At most DESCRIPTION_PREVIEW characters, whitespace collapsed. */
  description: string;
  /**
   * The Burmese description, shortened the same way. Null when the title
   * has none — the client then shows `description` — and always for a book.
   */
  descriptionMm: string | null;
  posterUrl: string | null;
  coverUrl: string | null;
  /** Movies only. */
  thumbnailUrl: string | null;
  genre: string | null;
  releaseYear: number | null;
  /** Movies only, in minutes. */
  durationMinutes: number | null;
  /** 0-10, 0 = not rated yet. Null for books. */
  rating: number | null;
  /** FREE or SUBSCRIPTION (Premium). Null for books — they have none. */
  accessType: AccessType | null;
  /** Movies only. */
  ageRating: AgeRating | null;
  /** Books only. */
  author: string | null;
}

export const DESCRIPTION_PREVIEW = 300;

/**
 * Unicode's own "one character to a reader" splitter. A Burmese consonant
 * and the marks written on it are several code units but one character; a
 * cut between them leaves a letter with its marks torn off.
 */
const GRAPHEMES =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function* graphemes(text: string): Generator<string> {
  if (!GRAPHEMES) {
    // A runtime without the segmenter: whole code points, which
    // readerCharacters still joins to the letter they belong to.
    yield* text;
    return;
  }
  for (const { segment } of GRAPHEMES.segment(text)) yield segment;
}

const STARTS_WITH_MARK = /^\p{M}/u;

/** The Burmese stacking sign: the consonant after it is written beneath the one before. */
const STACKING_SIGN = '\u1039';

/**
 * The pieces a preview may be cut between. Unicode's splitter is not quite
 * enough for Burmese: it lets the vowel sign aa (ာ / ါ) and the visarga (း)
 * stand alone, and it splits a stacked pair after the stacking sign. So a
 * piece that starts with a mark, or follows a stacking sign, stays with the
 * letter before it.
 */
function* readerCharacters(text: string): Generator<string> {
  let letter = '';
  for (const piece of graphemes(text)) {
    if (
      letter !== '' &&
      (STARTS_WITH_MARK.test(piece) || letter.endsWith(STACKING_SIGN))
    ) {
      letter += piece;
      continue;
    }
    if (letter !== '') yield letter;
    letter = piece;
  }
  if (letter !== '') yield letter;
}

/**
 * Whitespace collapsed, and at most DESCRIPTION_PREVIEW UTF-16 units: a
 * longer text keeps the whole characters that fit in one unit less and
 * ends in an ellipsis. For plain Latin text that is exactly the first 299
 * letters, as it always was; Burmese is never cut in the middle of a letter.
 */
export function descriptionPreview(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= DESCRIPTION_PREVIEW) return flat;

  let kept = '';
  for (const character of readerCharacters(flat)) {
    if (kept.length + character.length > DESCRIPTION_PREVIEW - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

/** The preview of an optional text — null when there is none (a blank one counts as none). */
function optionalPreview(text: string | null | undefined): string | null {
  return descriptionPreview(text) || null;
}

export const MOVIE_CARD_SELECT = {
  id: true,
  title: true,
  description: true,
  descriptionMm: true,
  posterUrl: true,
  coverUrl: true,
  thumbnailUrl: true,
  genre: true,
  releaseYear: true,
  duration: true,
  rating: true,
  accessType: true,
  ageRating: true,
} satisfies Prisma.MovieSelect;

export const SERIES_CARD_SELECT = {
  id: true,
  title: true,
  description: true,
  descriptionMm: true,
  posterUrl: true,
  coverUrl: true,
  genre: true,
  releaseYear: true,
  rating: true,
  accessType: true,
} satisfies Prisma.SeriesSelect;

export const BOOK_CARD_SELECT = {
  id: true,
  title: true,
  author: true,
  description: true,
  coverUrl: true,
} satisfies Prisma.BookSelect;

type MovieCardRow = Prisma.MovieGetPayload<{
  select: typeof MOVIE_CARD_SELECT;
}>;
type SeriesCardRow = Prisma.SeriesGetPayload<{
  select: typeof SERIES_CARD_SELECT;
}>;
type BookCardRow = Prisma.BookGetPayload<{ select: typeof BOOK_CARD_SELECT }>;

export function movieCard(row: MovieCardRow): ShowcaseTitle {
  return {
    type: 'MOVIE',
    id: row.id,
    title: row.title,
    description: descriptionPreview(row.description),
    descriptionMm: optionalPreview(row.descriptionMm),
    posterUrl: row.posterUrl,
    coverUrl: row.coverUrl,
    thumbnailUrl: row.thumbnailUrl,
    genre: row.genre,
    releaseYear: row.releaseYear,
    durationMinutes: row.duration,
    rating: row.rating,
    accessType: row.accessType,
    ageRating: row.ageRating,
    author: null,
  };
}

export function seriesCard(row: SeriesCardRow): ShowcaseTitle {
  return {
    type: 'SERIES',
    id: row.id,
    title: row.title,
    description: descriptionPreview(row.description),
    descriptionMm: optionalPreview(row.descriptionMm),
    posterUrl: row.posterUrl,
    coverUrl: row.coverUrl,
    thumbnailUrl: null,
    genre: row.genre,
    releaseYear: row.releaseYear,
    durationMinutes: null,
    rating: row.rating,
    accessType: row.accessType,
    ageRating: null,
    author: null,
  };
}

export function bookCard(row: BookCardRow): ShowcaseTitle {
  return {
    type: 'BOOK',
    id: row.id,
    title: row.title,
    description: descriptionPreview(row.description),
    // A book has a single description: Book has no Burmese column.
    descriptionMm: null,
    posterUrl: null,
    coverUrl: row.coverUrl,
    thumbnailUrl: null,
    genre: null,
    releaseYear: null,
    durationMinutes: null,
    rating: null,
    accessType: null,
    ageRating: null,
    author: row.author,
  };
}

/**
 * What a regular USER may see, per kind — the same rules the catalogue
 * services apply for Role.USER: a STANDALONE movie (an episode is reached
 * through its series) that is PUBLISHED, a PUBLISHED series, a book with at
 * least one PUBLISHED edition.
 */
export const USER_VISIBLE = {
  movie: {
    status: MovieStatus.PUBLISHED,
    seriesId: null,
  } satisfies Prisma.MovieWhereInput,
  series: { status: SeriesStatus.PUBLISHED } satisfies Prisma.SeriesWhereInput,
  book: {
    editions: { some: { status: BookStatus.PUBLISHED } },
  } satisfies Prisma.BookWhereInput,
};

/** Key for a title in the maps below: `MOVIE:<id>`. */
export const titleKey = (type: TitleTargetType, id: string) => `${type}:${id}`;

export interface TitleRef {
  type: TitleTargetType;
  id: string;
}

/**
 * Loads the cards for a set of title references in at most three queries.
 * `visibleOnly` applies the USER visibility rules; without it every existing
 * row is returned (the admin list wants to show a hidden target as hidden).
 */
export async function loadTitleCards(
  prisma: PrismaService,
  refs: readonly TitleRef[],
  visibleOnly: boolean,
): Promise<Map<string, ShowcaseTitle>> {
  const idsOf = (type: TitleTargetType) => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];
  const movieIds = idsOf('MOVIE');
  const seriesIds = idsOf('SERIES');
  const bookIds = idsOf('BOOK');

  const [movies, series, books] = await Promise.all([
    movieIds.length
      ? prisma.movie.findMany({
          where: {
            id: { in: movieIds },
            ...(visibleOnly ? USER_VISIBLE.movie : { seriesId: null }),
          },
          select: MOVIE_CARD_SELECT,
        })
      : [],
    seriesIds.length
      ? prisma.series.findMany({
          where: {
            id: { in: seriesIds },
            ...(visibleOnly ? USER_VISIBLE.series : {}),
          },
          select: SERIES_CARD_SELECT,
        })
      : [],
    bookIds.length
      ? prisma.book.findMany({
          where: {
            id: { in: bookIds },
            ...(visibleOnly ? USER_VISIBLE.book : {}),
          },
          select: BOOK_CARD_SELECT,
        })
      : [],
  ]);

  const cards = new Map<string, ShowcaseTitle>();
  for (const row of movies)
    cards.set(titleKey('MOVIE', row.id), movieCard(row));
  for (const row of series)
    cards.set(titleKey('SERIES', row.id), seriesCard(row));
  for (const row of books) cards.set(titleKey('BOOK', row.id), bookCard(row));
  return cards;
}

/**
 * Which of `refs` a USER may see right now: ids only, at most three
 * primary-key lookups (one per kind present). The showcase runs this on every
 * answer it serves from memory, so a title unpublished, deleted or turned
 * into an episode on another admin page drops off the home page at once
 * instead of after the cache's TTL.
 */
export async function loadVisibleTitleKeys(
  prisma: PrismaService,
  refs: readonly TitleRef[],
): Promise<Set<string>> {
  const idsOf = (type: TitleTargetType) => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];
  const movieIds = idsOf('MOVIE');
  const seriesIds = idsOf('SERIES');
  const bookIds = idsOf('BOOK');
  const ID_ONLY = { id: true } as const;
  const none: Promise<{ id: string }[]> = Promise.resolve([]);

  const [movies, series, books]: { id: string }[][] = await Promise.all([
    movieIds.length
      ? prisma.movie.findMany({
          where: { id: { in: movieIds }, ...USER_VISIBLE.movie },
          select: ID_ONLY,
        })
      : none,
    seriesIds.length
      ? prisma.series.findMany({
          where: { id: { in: seriesIds }, ...USER_VISIBLE.series },
          select: ID_ONLY,
        })
      : none,
    bookIds.length
      ? prisma.book.findMany({
          where: { id: { in: bookIds }, ...USER_VISIBLE.book },
          select: ID_ONLY,
        })
      : none,
  ]);

  return new Set([
    ...movies.map((row) => titleKey('MOVIE', row.id)),
    ...series.map((row) => titleKey('SERIES', row.id)),
    ...books.map((row) => titleKey('BOOK', row.id)),
  ]);
}
