import { HttpStatus } from '@nestjs/common';
import { CodedHttpException } from '../common/errors/coded-http.exception';

/**
 * A title's description, once per language (owner, 2026-11-06): `description`
 * is the English / default text — what TMDB fills, and the fallback — and
 * `descriptionMm` is the Burmese one staff type by hand. The API always sends
 * both and the clients show the one for the app language, falling back to
 * the other.
 *
 * One language is enough, but a title that staff save must have at least
 * one: `description` used to be required on every save that carried it, and
 * dropping that outright would let a title lose its only description by a
 * blanked box. Rows the server makes itself (a bulk-upload placeholder, a
 * show created from TMDB that has no overview) are still born without one —
 * the rule is about what staff submit, not about every row.
 *
 * Shared by MoviesService and SeriesService so both catalogues follow the
 * one rule.
 */

/** The 400 a save gets when it would leave a title with no description in either language. */
export const DESCRIPTION_REQUIRED_CODE = 'DESCRIPTION_REQUIRED';
export const DESCRIPTION_REQUIRED_MESSAGE =
  'Add a description in at least one language (English or Burmese)';

const isBlank = (value: string | null | undefined): boolean =>
  typeof value !== 'string' || value.trim() === '';

/**
 * '' or only spaces → null; anything else is returned as it came. The
 * Burmese box clears by being blanked, and an empty string must not be
 * stored as "a Burmese description exists" — the clients fall back to
 * English on null. Same rule as the optional director / country fields.
 */
export function blankToNull<T extends string | null | undefined>(
  value: T,
): T | null {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/** Throws the coded 400 unless at least one of the two descriptions has text. */
export function assertDescriptionInSomeLanguage(
  description: string | null | undefined,
  descriptionMm: string | null | undefined,
): void {
  if (isBlank(description) && isBlank(descriptionMm)) {
    throw new CodedHttpException(
      HttpStatus.BAD_REQUEST,
      DESCRIPTION_REQUIRED_CODE,
      DESCRIPTION_REQUIRED_MESSAGE,
    );
  }
}

/**
 * The same rule for a partial update, checked against what the row will
 * hold AFTER the save: a field the request leaves out keeps its stored
 * value. A request that touches neither description is never refused — a
 * title that has none yet (a fresh upload) must stay editable in every
 * other way.
 */
export function assertDescriptionKeptInSomeLanguage(
  change: { description?: string | null; descriptionMm?: string | null },
  stored: { description?: string | null; descriptionMm?: string | null },
): void {
  if (change.description === undefined && change.descriptionMm === undefined) {
    return;
  }
  assertDescriptionInSomeLanguage(
    change.description !== undefined ? change.description : stored.description,
    change.descriptionMm !== undefined
      ? change.descriptionMm
      : stored.descriptionMm,
  );
}
