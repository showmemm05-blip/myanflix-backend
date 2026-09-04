/**
 * Leaves room for a numeric collision suffix (`_2` … `_20`) or a 6-hex one
 * under RegisterDto's 32-character ceiling.
 */
const MAX_BASE_LENGTH = 24;

/**
 * Turns a Google e-mail's local part into a username that satisfies
 * RegisterDto's rule (/^[a-zA-Z0-9_.]+$/, 3..32 chars) so the value is a
 * legal username anywhere in the app. Pure; collision handling lives in
 * GoogleAuthService.pickUsername.
 *
 *   John.Doe@gmail.com → john.doe      a.b+tag@x.com → a.b_tag
 *   j@x.com → user_j                   ___@x.com / non-Latin → user
 */
export function deriveUsernameBase(email: string): string {
  const local = email.split('@')[0].toLowerCase();
  const base = local
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/[_.]{2,}/g, '_')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/^[_.]+|[_.]+$/g, '');

  if (base.length < 3) {
    return base ? `user_${base}` : 'user';
  }
  return base;
}
