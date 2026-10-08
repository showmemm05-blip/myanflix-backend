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
 *   user_959123456789@x.com → g_959123456789  (never a phone account's name)
 */
export function deriveUsernameBase(email: string): string {
  const local = email.split('@')[0].toLowerCase();
  const base = local
    .replace(/[^a-z0-9_.]/g, '_')
    .replace(/[_.]{2,}/g, '_')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/^[_.]+|[_.]+$/g, '');

  const padded = base.length < 3 ? (base ? `user_${base}` : 'user') : base;
  return reserveFromPhoneShape(padded);
}

/**
 * `user_<digits>` is the username a phone sign-up synthesizes for the phone
 * with those digits (AuthService.verifyPhoneOtp), so a Google account whose
 * e-mail local part spells `user_959123456789@…` must never be granted that
 * exact name — it would pre-claim a stranger's phone account name (M-20).
 * Those get `g_<digits>` instead (same length class, still a legal username,
 * ≥ 3 characters since the digits are never empty).
 */
function reserveFromPhoneShape(base: string): string {
  const match = /^user_(\d+)$/.exec(base);
  return match ? `g_${match[1]}` : base;
}
