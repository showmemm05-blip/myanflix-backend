import { createHash } from 'node:crypto';
import type { AgeRating } from '../generated/prisma/client';
import type {
  TmdbField,
  TmdbMatchRef,
  TmdbPreviewLineState,
} from './tmdb.types';

/**
 * Human over automatic — the one overwrite rule (PLAN.md 2.9 and 4.3 of
 * docs/movie-details-tmdb-2026-11-06), as pure functions.
 *
 * A title remembers, per field, the last value that was written
 * automatically (the staff-only JSON column `tmdbAuto`). A field is
 * UNTOUCHED while it holds either nothing (its empty placeholder) or
 * exactly that remembered value; once staff type something else it is
 * theirs. An automatic fill writes untouched fields only; a staff apply
 * writes what staff switched on. That is the whole rule, and it needs no
 * "edited by" flag that could fall out of step with the row: what the row
 * holds is compared with what was put there.
 */

/** The shape of Movie.tmdbAuto / Series.tmdbAuto. */
export interface TmdbAuto {
  v: 1;
  /** The linked TMDB entry, for display ("Inception (2010)"). */
  match?: TmdbMatchRef;
  title?: string;
  /** SHA-256 hex of the automatic description (the text itself is not copied). */
  descriptionHash?: string;
  releaseYear?: number;
  /** Movies only. */
  duration?: number;
  genre?: string;
  language?: string;
  country?: string;
  /** Movies only. */
  director?: string;
  /** Movies only. */
  ageRating?: AgeRating;
  /** The canonical stored URL of the automatic poster. */
  posterUrl?: string;
  /** The TMDB file path it came from. */
  posterPath?: string;
  coverUrl?: string;
  coverPath?: string;
  categoryIds?: string[];
  actorIds?: string[];
}

/**
 * The comparable values of a title, movie or series alike. A series has no
 * runtime, director or age rating column: its view carries their empty
 * placeholders (0, null, null) and those three fields are never asked about.
 */
export interface TmdbTitleView {
  title: string;
  description: string;
  releaseYear: number;
  duration: number;
  genre: string;
  language: string;
  country: string | null;
  director: string | null;
  ageRating: AgeRating | null;
  posterUrl: string | null;
  coverUrl: string | null;
  categoryIds: string[];
  actorIds: string[];
}

/** MinioService.keyFromPublicUrl — pictures are compared by object key, so the host a URL was saved under does not matter. */
export type ImageKeyOf = (url: string) => string | null;

/** How a field stands: nothing there, still the automatic value, or changed by staff. */
export type TmdbFieldStanding = 'empty' | 'auto' | 'hand';

const AGE_RATING_VALUES: readonly string[] = ['G', 'PG', 'PG13', 'R', 'NC17'];

const isText = (value: unknown): value is string => typeof value === 'string';
const isWholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);
const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);
const isBlank = (value: string | null | undefined): boolean =>
  typeof value !== 'string' || value.trim() === '';

/**
 * The stored JSON as a TmdbAuto, or null when the title has none (a row
 * that predates the feature, a hand-made series) or when it is not version
 * 1. A key of the wrong type is read as absent — the field then simply
 * counts as changed by hand, which is the safe side.
 */
export function readTmdbAuto(value: unknown): TmdbAuto | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return null;
  const auto: TmdbAuto = { v: 1 };
  const match = raw.match;
  if (typeof match === 'object' && match !== null && !Array.isArray(match)) {
    const { title, year } = match as Record<string, unknown>;
    if (isText(title)) {
      auto.match = { title, year: isWholeNumber(year) ? year : null };
    }
  }
  if (isText(raw.title)) auto.title = raw.title;
  if (isText(raw.descriptionHash)) auto.descriptionHash = raw.descriptionHash;
  if (isWholeNumber(raw.releaseYear)) auto.releaseYear = raw.releaseYear;
  if (isWholeNumber(raw.duration)) auto.duration = raw.duration;
  if (isText(raw.genre)) auto.genre = raw.genre;
  if (isText(raw.language)) auto.language = raw.language;
  if (isText(raw.country)) auto.country = raw.country;
  if (isText(raw.director)) auto.director = raw.director;
  if (isText(raw.ageRating) && AGE_RATING_VALUES.includes(raw.ageRating)) {
    auto.ageRating = raw.ageRating as AgeRating;
  }
  if (isText(raw.posterUrl)) auto.posterUrl = raw.posterUrl;
  if (isText(raw.posterPath)) auto.posterPath = raw.posterPath;
  if (isText(raw.coverUrl)) auto.coverUrl = raw.coverUrl;
  if (isText(raw.coverPath)) auto.coverPath = raw.coverPath;
  if (isIdList(raw.categoryIds)) auto.categoryIds = raw.categoryIds;
  if (isIdList(raw.actorIds)) auto.actorIds = raw.actorIds;
  return auto;
}

/**
 * What tmdbAuto keeps of a description: the SHA-256 of the text, outer
 * blanks ignored. Enough to tell "still the automatic text" from "edited",
 * without storing every description twice.
 */
export function descriptionHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

/** True when both lists hold the same ids, in any order. */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** True when both URLs address the same stored picture. */
export function sameImage(
  a: string | null | undefined,
  b: string | null | undefined,
  keyOf: ImageKeyOf,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const keyA = keyOf(a);
  return keyA !== null && keyA === keyOf(b);
}

/**
 * How one field of a title stands (PLAN.md 2.9):
 *
 * - `empty`: it holds its empty placeholder — description / genre /
 *   language '', duration 0, country / director / age rating / poster /
 *   cover null, no categories, no cast.
 * - `auto`: tmdbAuto has an entry for it that equals the current value (the
 *   description by its hash, a picture by its object key, a list as a set).
 * - `hand`: anything else — staff changed it.
 *
 * `title` and `releaseYear` have no empty placeholder (a title always has
 * both), so they are `auto` or `hand`; with no tmdbAuto at all they are
 * `hand`.
 */
export function fieldStanding(
  field: TmdbField,
  view: TmdbTitleView,
  auto: TmdbAuto | null,
  keyOf: ImageKeyOf,
): TmdbFieldStanding {
  const text = (
    current: string | null,
    remembered: string | undefined,
  ): TmdbFieldStanding => {
    if (isBlank(current)) return 'empty';
    return remembered !== undefined && remembered === current ? 'auto' : 'hand';
  };
  const picture = (
    current: string | null,
    remembered: string | undefined,
  ): TmdbFieldStanding => {
    if (isBlank(current)) return 'empty';
    return sameImage(current, remembered, keyOf) ? 'auto' : 'hand';
  };
  const list = (
    current: readonly string[],
    remembered: readonly string[] | undefined,
  ): TmdbFieldStanding => {
    if (current.length === 0) return 'empty';
    return remembered !== undefined && sameIdSet(current, remembered)
      ? 'auto'
      : 'hand';
  };

  switch (field) {
    case 'title':
      return auto?.title !== undefined && auto.title === view.title
        ? 'auto'
        : 'hand';
    case 'releaseYear':
      return auto?.releaseYear !== undefined &&
        auto.releaseYear === view.releaseYear
        ? 'auto'
        : 'hand';
    case 'description':
      if (isBlank(view.description)) return 'empty';
      return auto?.descriptionHash !== undefined &&
        auto.descriptionHash === descriptionHash(view.description)
        ? 'auto'
        : 'hand';
    case 'duration':
      if (view.duration === 0) return 'empty';
      return auto?.duration !== undefined && auto.duration === view.duration
        ? 'auto'
        : 'hand';
    case 'genre':
      return text(view.genre, auto?.genre);
    case 'language':
      return text(view.language, auto?.language);
    case 'country':
      return text(view.country, auto?.country);
    case 'director':
      return text(view.director, auto?.director);
    case 'ageRating':
      if (view.ageRating === null) return 'empty';
      return auto?.ageRating !== undefined && auto.ageRating === view.ageRating
        ? 'auto'
        : 'hand';
    case 'poster':
      return picture(view.posterUrl, auto?.posterUrl);
    case 'cover':
      return picture(view.coverUrl, auto?.coverUrl);
    case 'categories':
      return list(view.categoryIds, auto?.categoryIds);
    case 'cast':
      return list(view.actorIds, auto?.actorIds);
  }
}

/** Untouched = staff have not changed it by hand: empty, or still the automatic value. */
export function isUntouched(standing: TmdbFieldStanding): boolean {
  return standing !== 'hand';
}

/** `automatic` = a fill nobody reviewed (after an upload, a show created from TMDB); `staff` = Apply after the review. */
export type TmdbFillMode = 'automatic' | 'staff';

/** What a fill does with one field it is considering. */
export type TmdbFieldDecision =
  /** Write TMDB's value. */
  | 'write'
  /** TMDB has no value and the field still holds an automatic one: back to its empty placeholder. */
  | 'reset'
  /** Staff changed it and nobody asked to replace it. */
  | 'skip_hand'
  /** TMDB has no value and there is nothing of ours to take back. */
  | 'skip_no_value';

/**
 * The decision for one field (PLAN.md 2.9).
 *
 * - An automatic fill never writes a field staff changed.
 * - A staff apply writes the fields it was given — except the runtime: one
 *   that is there and is not the automatic value was measured from the real
 *   video (or typed by someone who knows it) and is never replaced.
 * - With no TMDB value, a field that still holds an automatic value goes
 *   back to its empty placeholder (it came from the previous match); a
 *   field of staff's, or an empty one, is left as it is. `title` and
 *   `releaseYear` have no placeholder and are never taken back.
 */
export function decideField(
  field: TmdbField,
  standing: TmdbFieldStanding,
  hasValue: boolean,
  mode: TmdbFillMode,
): TmdbFieldDecision {
  const staffOwned = standing === 'hand';
  if (staffOwned && (mode === 'automatic' || field === 'duration')) {
    return 'skip_hand';
  }
  if (hasValue) return 'write';
  const resettable = field !== 'title' && field !== 'releaseYear';
  return standing === 'auto' && resettable ? 'reset' : 'skip_no_value';
}

/**
 * How a line of the review stands: TMDB has nothing (`none`), the title
 * already holds TMDB's value (`same`), else the field's own standing.
 */
export function previewLineState(
  standing: TmdbFieldStanding,
  hasValue: boolean,
  same: boolean,
): TmdbPreviewLineState {
  if (!hasValue) return 'none';
  if (same) return 'same';
  return standing;
}

/**
 * A list field after a fill: what staff added stays, what the previous
 * match added leaves, the new match's entries join —
 * `(current - previous automatic) + next`, without duplicates, current
 * order first.
 */
export function mergeAutoList(
  current: readonly string[],
  previousAuto: readonly string[] | undefined,
  next: readonly string[],
): string[] {
  const leaving = new Set(previousAuto ?? []);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const id of [...current.filter((id) => !leaving.has(id)), ...next]) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

/**
 * One field's new value. `null` puts the field back to its empty
 * placeholder and forgets its automatic value; `title` and `releaseYear`
 * have no placeholder and so no null. For a list the value is the ids the
 * TMDB entry contributes, not the whole list.
 */
export type TmdbFieldChange =
  | { field: 'title'; value: string }
  | { field: 'releaseYear'; value: number }
  | { field: 'description'; value: string | null }
  | { field: 'duration'; value: number | null }
  | {
      field: 'genre' | 'language' | 'country' | 'director';
      value: string | null;
    }
  | { field: 'ageRating'; value: AgeRating | null }
  | { field: 'poster' | 'cover'; value: { url: string; path: string } | null }
  | { field: 'categories' | 'cast'; value: string[] | null };

/**
 * Applies the changes of one fill to a title's values and to its tmdbAuto,
 * returning both as new objects. Every written field's tmdbAuto entry is
 * updated; a field put back to its placeholder leaves tmdbAuto. Fields
 * that are not named are returned exactly as they came — the caller
 * writes only the named ones.
 */
export function applyChanges(
  view: TmdbTitleView,
  auto: TmdbAuto | null,
  changes: readonly TmdbFieldChange[],
): { view: TmdbTitleView; auto: TmdbAuto } {
  const next: TmdbTitleView = {
    ...view,
    categoryIds: [...view.categoryIds],
    actorIds: [...view.actorIds],
  };
  const remembered: TmdbAuto = { ...(auto ?? { v: 1 }), v: 1 };

  for (const change of changes) {
    switch (change.field) {
      case 'title':
        next.title = change.value;
        remembered.title = change.value;
        break;
      case 'releaseYear':
        next.releaseYear = change.value;
        remembered.releaseYear = change.value;
        break;
      case 'description':
        next.description = change.value ?? '';
        if (change.value === null) delete remembered.descriptionHash;
        else remembered.descriptionHash = descriptionHash(change.value);
        break;
      case 'duration':
        next.duration = change.value ?? 0;
        if (change.value === null) delete remembered.duration;
        else remembered.duration = change.value;
        break;
      case 'genre':
      case 'language':
        next[change.field] = change.value ?? '';
        if (change.value === null) delete remembered[change.field];
        else remembered[change.field] = change.value;
        break;
      case 'country':
      case 'director':
        next[change.field] = change.value;
        if (change.value === null) delete remembered[change.field];
        else remembered[change.field] = change.value;
        break;
      case 'ageRating':
        next.ageRating = change.value;
        if (change.value === null) delete remembered.ageRating;
        else remembered.ageRating = change.value;
        break;
      case 'poster':
        next.posterUrl = change.value?.url ?? null;
        if (change.value === null) {
          delete remembered.posterUrl;
          delete remembered.posterPath;
        } else {
          remembered.posterUrl = change.value.url;
          remembered.posterPath = change.value.path;
        }
        break;
      case 'cover':
        next.coverUrl = change.value?.url ?? null;
        if (change.value === null) {
          delete remembered.coverUrl;
          delete remembered.coverPath;
        } else {
          remembered.coverUrl = change.value.url;
          remembered.coverPath = change.value.path;
        }
        break;
      case 'categories':
        next.categoryIds = mergeAutoList(
          view.categoryIds,
          auto?.categoryIds,
          change.value ?? [],
        );
        if (change.value === null) delete remembered.categoryIds;
        else remembered.categoryIds = [...new Set(change.value)];
        break;
      case 'cast':
        next.actorIds = mergeAutoList(
          view.actorIds,
          auto?.actorIds,
          change.value ?? [],
        );
        if (change.value === null) delete remembered.actorIds;
        else remembered.actorIds = [...new Set(change.value)];
        break;
    }
  }
  return { view: next, auto: remembered };
}
