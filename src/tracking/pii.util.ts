/**
 * Server-side masking of the two pieces of personal data the Tracking views
 * expose: a user's phone number and the IP address a request came from.
 *
 * Masking happens HERE, in the backend, and never by hiding a column in the
 * admin client — a caller without `TRACKING.PII_VIEW` must not be able to
 * read the real value out of the network tab. Every tracking read path runs
 * its phone/IP fields through `presentPhone`/`presentIp` with the caller's
 * resolved permission, so adding a field to a response cannot accidentally
 * leak one: there is no code path that returns the raw column.
 */

/**
 * The obscured run, a FIXED five characters wide regardless of how much was
 * hidden — so the mask cannot be used to infer the length of what it hides.
 */
export const PII_MASK_RUN = '*****';

/** Fully-masked value, for inputs too short to reveal anything from. */
export const PII_FULL_MASK = '***';

/**
 * Reveals the first two and last three characters of a phone number:
 * `09250495369` -> `09*****369`.
 *
 * Deliberately format-agnostic — it masks whatever string is stored rather
 * than reformatting it, so a local `09…` number and an E.164 `+95…` number
 * both mask without this helper needing to know Myanmar's dialling rules.
 * The last three digits are what an operator uses to match a number against
 * a support ticket; the leading two just say which form it is in.
 */
export function maskPhoneNumber(
  phone: string | null | undefined,
): string | null {
  if (phone === null || phone === undefined) return null;
  const value = phone.trim();
  if (!value) return null;
  if (value.length <= 5) return PII_FULL_MASK;
  return `${value.slice(0, 2)}${PII_MASK_RUN}${value.slice(-3)}`;
}

/**
 * Blanks the final segment of an IP address, keeping the network it belongs
 * to: `203.0.113.7` -> `203.0.113.***`, `2001:db8::1` -> `2001:db8::***`.
 *
 * The network half is the operationally useful part — "these four accounts
 * are on one connection" is exactly what the Phone/IP view is for, and it
 * stays answerable from the masked form. The host half, the part that
 * identifies one machine, is what goes.
 */
export function maskIpAddress(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  const value = ip.trim();
  if (!value) return null;

  const lastDot = value.lastIndexOf('.');
  if (lastDot > 0) return `${value.slice(0, lastDot + 1)}${PII_FULL_MASK}`;

  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0) return `${value.slice(0, lastColon + 1)}${PII_FULL_MASK}`;

  return PII_FULL_MASK;
}

/** A phone as this caller may see it. */
export function presentPhone(
  phone: string | null | undefined,
  canViewPii: boolean,
): string | null {
  if (phone === null || phone === undefined) return null;
  return canViewPii ? phone : maskPhoneNumber(phone);
}

/** An IP as this caller may see it. */
export function presentIp(
  ip: string | null | undefined,
  canViewPii: boolean,
): string | null {
  if (ip === null || ip === undefined) return null;
  return canViewPii ? ip : maskIpAddress(ip);
}
