import { Prisma } from '../generated/prisma/client';

/**
 * Value-level hygiene for everything that lands in an audit row's `before`,
 * `after`, `changes` and `metadata` columns.
 *
 * Snapshots are built from Prisma rows by the pickers in audit-snapshots.ts,
 * but a picker is a whitelist of FIELDS, not of VALUES — a whitelisted field
 * can still be a Decimal, a Date, a BigInt, a 40 kB description or a nested
 * JSON document. This module makes whatever comes through storable as plain
 * JSON, bounded in size, and free of anything secret-shaped, so no caller
 * has to remember to do any of that.
 */

/** Keys whose values are never stored, whatever they hold. */
export const REDACTED_KEY_PATTERN = /password|secret|token|otp|hash|refresh/i;

export const REDACTED_VALUE = '[redacted]';

/** Strings longer than this are replaced by a `{ _truncated }` marker. */
export const MAX_STRING_LENGTH = 2000;

/** How much of a truncated string is kept, for a human to recognise it. */
export const STRING_PREVIEW_LENGTH = 200;

/**
 * Objects/arrays nested deeper than this are flattened to a JSON string
 * (itself capped at MAX_STRING_LENGTH) rather than stored structurally.
 * Depth 0 is the snapshot itself; its direct values sit at depth 1.
 */
export const MAX_DEPTH = 4;

export interface TruncatedString {
  _truncated: true;
  length: number;
  preview: string;
}

export interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isDecimal(value: unknown): value is Prisma.Decimal {
  return Prisma.Decimal.isDecimal(value);
}

/** Decimal / Date / BigInt → JSON-native scalar; everything else untouched. */
function toJsonScalar(value: unknown): unknown {
  if (isDecimal(value)) return value.toNumber();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function truncateString(value: string): string | TruncatedString {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return {
    _truncated: true,
    length: value.length,
    preview: value.slice(0, STRING_PREVIEW_LENGTH),
  };
}

/**
 * `JSON.stringify` with object keys sorted at every level and the same
 * scalar coercions as sanitizeValue, so two snapshots compare by content
 * rather than by key order or by Decimal-vs-number representation.
 * `undefined` is normalised to null so a missing key equals an explicit null.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForCompare(value)) ?? 'null';
}

function normalizeForCompare(value: unknown): unknown {
  if (value === undefined) return null;
  const scalar = toJsonScalar(value);
  if (Array.isArray(scalar)) return scalar.map(normalizeForCompare);
  if (isPlainObject(scalar)) {
    return Object.fromEntries(
      Object.keys(scalar)
        .sort()
        .map((key) => [key, normalizeForCompare(scalar[key])]),
    );
  }
  if (typeof scalar === 'function' || typeof scalar === 'symbol') return null;
  return scalar;
}

/**
 * One value, made storable. Exported for the service, which applies it to
 * the `from`/`to` of every change entry as well as to whole snapshots.
 */
export function sanitizeValue(value: unknown, depth = 1): unknown {
  const scalar = toJsonScalar(value);

  if (scalar === null || scalar === undefined) return scalar;
  if (typeof scalar === 'string') return truncateString(scalar);
  if (typeof scalar === 'number')
    return Number.isFinite(scalar) ? scalar : null;
  if (typeof scalar === 'boolean') return scalar;
  if (typeof scalar === 'function' || typeof scalar === 'symbol') {
    return undefined;
  }

  if (Array.isArray(scalar) || isPlainObject(scalar)) {
    if (depth > MAX_DEPTH) {
      return truncateString(stableStringify(redactDeep(scalar)));
    }
    if (Array.isArray(scalar)) {
      return scalar.map((item) => sanitizeValue(item, depth + 1) ?? null);
    }
    const out: PlainObject = {};
    for (const [key, item] of Object.entries(scalar)) {
      if (REDACTED_KEY_PATTERN.test(key)) {
        out[key] = REDACTED_VALUE;
        continue;
      }
      const sanitized = sanitizeValue(item, depth + 1);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }

  // Class instances that are not Decimal/Date (a Prisma model with a
  // prototype, a Map, …) — keep whatever they serialise to, nothing more.
  return sanitizeValue(JSON.parse(JSON.stringify(scalar) ?? 'null'), depth);
}

/** Redaction only, for the part of a value that is about to be stringified. */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        REDACTED_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactDeep(item),
      ]),
    );
  }
  return value;
}

/**
 * Deep-clones a snapshot into something safe to persist:
 *  - values under a secret-shaped KEY (password, token, otp, hash, …) become
 *    '[redacted]' at any depth;
 *  - Decimal → number, Date → ISO string, BigInt → number;
 *  - strings over MAX_STRING_LENGTH → `{ _truncated, length, preview }`;
 *  - objects/arrays nested deeper than MAX_DEPTH → a capped JSON string;
 *  - `undefined`/function values are dropped.
 * Null/undefined in → null out, so callers can pass an optional row through.
 */
export function sanitizeSnapshot(
  snapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (snapshot === null || snapshot === undefined) return null;
  // Depth 0 is the snapshot itself, so its direct values sit at depth 1.
  const sanitized = sanitizeValue(snapshot, 0);
  return isPlainObject(sanitized) ? sanitized : null;
}

interface NamedRef {
  id: unknown;
  name?: unknown;
}

function isNamedRefList(value: unknown): value is NamedRef[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isPlainObject(item) && 'id' in item)
  );
}

const byId = (a: NamedRef, b: NamedRef) =>
  String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;

/** "Action, Drama" rather than two uuids — what the admin renders. */
function refLabels(list: NamedRef[]): unknown[] {
  return [...list]
    .sort(byId)
    .map((item) => (item.name === undefined ? item.id : item.name));
}

/**
 * Top-level differences between two snapshots, as `{ field, from, to }`.
 *
 * Keys are the union of both objects (before's order first, then whatever
 * only after has). Values compare by stable JSON, so key order, Decimal vs
 * number and Date vs ISO string never register as changes. A relation list
 * (`[{ id, name }]` on both sides) compares as a SET by id, and when it
 * differs the entry carries the sorted NAME lists as from/to so the change
 * reads as "Action, Drama → Action" instead of two arrays of ids.
 */
export function diffSnapshots(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): AuditChange[] {
  const left = before ?? {};
  const right = after ?? {};
  const fields = [
    ...Object.keys(left),
    ...Object.keys(right).filter((key) => !(key in left)),
  ];

  const changes: AuditChange[] = [];
  for (const field of fields) {
    const from = left[field];
    const to = right[field];

    if (isNamedRefList(from) && isNamedRefList(to)) {
      const fromIds = [...from].sort(byId).map((item) => String(item.id));
      const toIds = [...to].sort(byId).map((item) => String(item.id));
      if (stableStringify(fromIds) !== stableStringify(toIds)) {
        changes.push({ field, from: refLabels(from), to: refLabels(to) });
      }
      continue;
    }

    if (stableStringify(from) !== stableStringify(to)) {
      changes.push({ field, from: from ?? null, to: to ?? null });
    }
  }
  return changes;
}
