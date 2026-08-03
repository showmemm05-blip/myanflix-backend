/**
 * Best-effort normalization so "09xxxxxxxx" and "+959xxxxxxxx" resolve to
 * the same phone identity. Myanmar-specific for now (this app's only
 * market) — revisit if other country codes need support.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[\s-]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('0')) return `+95${trimmed.slice(1)}`;
  if (trimmed.startsWith('95')) return `+${trimmed}`;
  return `+95${trimmed}`;
}
