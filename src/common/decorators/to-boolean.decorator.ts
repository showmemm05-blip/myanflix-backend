import { Transform } from 'class-transformer';

/**
 * Normalizes an on/off request field into a real boolean before validation,
 * so multipart bodies (multer hands every field over as a string) and query
 * strings are read the way a human reads them:
 *
 *   'true'  / '1' / ' TRUE ' -> true
 *   'false' / '0'            -> false
 *   true / false             -> unchanged
 *   undefined / null         -> unchanged (@IsOptional decides)
 *   anything else            -> returned raw, so the following @IsBoolean()
 *                               fails and the request is a 400 — never a
 *                               silent guess. That includes the empty string.
 *
 * MUST read `obj[key]`, not `value`: with the global pipe's
 * `enableImplicitConversion` the executor coerces the property with a bare
 * `Boolean(value)` BEFORE custom transforms run (class-transformer
 * TransformOperationExecutor: `finalValue = this.transform(...)` then
 * `applyCustomTransformations(finalValue, ...)`), so a value-based transform
 * sees `true` for the raw input 'false' and cannot tell the two apart. Only the
 * source object still holds the untouched string.
 */
export function ToBoolean(): PropertyDecorator {
  return Transform(
    ({ obj, key }) => {
      const raw = (obj as Record<string, unknown>)[key];
      if (raw === undefined || raw === null || typeof raw === 'boolean') {
        return raw;
      }
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
      }
      return raw;
    },
    { toClassOnly: true },
  );
}
