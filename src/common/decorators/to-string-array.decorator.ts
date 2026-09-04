import { Transform } from 'class-transformer';

/**
 * Normalizes a query param into `string[]` before validation, accepting BOTH
 * wire shapes the catalog's clients (and hand-typed deep links) produce:
 *
 *   ?genres=Action,Drama          -> ['Action', 'Drama']   (CSV — the canonical form)
 *   ?genres=Action&genres=Drama   -> ['Action', 'Drama']   (repeated param)
 *   ?genres[]=Action              -> ['Action']            (bracketed/axios serializers)
 *
 * CSV values are trimmed and empties dropped, so `?genres=` and `?genres=,,`
 * both validate as an absent filter rather than a bogus one. Runs before the
 * class-validator decorators, which then validate each element.
 */
export function ToStringArray(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === undefined || value === null) return value as undefined;
    return Array.isArray(value)
      ? value.map(String)
      : String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  });
}
