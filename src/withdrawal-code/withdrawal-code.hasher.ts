import { createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PASSWORD_SALT_ROUNDS } from '../auth/password.constants';

/**
 * What a stored hash says about a typed code:
 * - `right` / `wrong`: judged.
 * - `right_rehash`: right, but stored without the pepper while one is set
 *   now — the caller should store hash() of it in the same write.
 * - `unavailable`: the hash was made with a pepper this server does not
 *   have (WITHDRAWAL_CODE_PEPPER changed or was removed). It cannot be
 *   judged at all, so no try may be counted either way.
 */
export type WithdrawalCodeMatch =
  'right' | 'right_rehash' | 'wrong' | 'unavailable';

/** `wcp1$<pepper id>$<bcrypt of the HMAC>`; a plain bcrypt hash starts with `$2`. */
const PEPPERED_HASH = /^wcp1\$([0-9a-f]{8})\$(\$2[aby]\$.+)$/;

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Hashes and checks 6-digit withdrawal codes.
 *
 * A 6-digit code has only 1,000,000 values, so bcrypt alone does not keep it
 * secret once the database leaks: every code can be tried offline in hours.
 * With WITHDRAWAL_CODE_PEPPER set, the code is first mixed with that server
 * secret (HMAC-SHA256), which never lives in the database, and only then
 * bcrypt-hashed at the password cost — a leaked database alone no longer
 * gives the codes away.
 *
 * The stored value names which pepper made it (a short id derived from the
 * secret, never the secret), so:
 * - hashes from before a pepper was set keep working and are upgraded on
 *   the next right code;
 * - a changed or removed pepper is detected ('unavailable') instead of
 *   being read as a wrong code, which would lock every user out.
 */
export class WithdrawalCodeHasher {
  private readonly pepper: { secret: string; id: string } | null;

  constructor(secret: string | undefined) {
    this.pepper = secret
      ? {
          secret,
          id: hmacHex(secret, 'myanflix:withdrawal-code:pepper-id').slice(0, 8),
        }
      : null;
  }

  get hasPepper(): boolean {
    return this.pepper !== null;
  }

  async hash(code: string): Promise<string> {
    if (!this.pepper) return bcrypt.hash(code, PASSWORD_SALT_ROUNDS);
    const mixed = await bcrypt.hash(
      this.mix(code, this.pepper.secret),
      PASSWORD_SALT_ROUNDS,
    );
    return `wcp1$${this.pepper.id}$${mixed}`;
  }

  async compare(code: string, stored: string): Promise<WithdrawalCodeMatch> {
    const peppered = PEPPERED_HASH.exec(stored);
    if (peppered) {
      if (!this.pepper || peppered[1] !== this.pepper.id) return 'unavailable';
      return (await bcrypt.compare(
        this.mix(code, this.pepper.secret),
        peppered[2],
      ))
        ? 'right'
        : 'wrong';
    }
    if (!(await bcrypt.compare(code, stored))) return 'wrong';
    return this.pepper ? 'right_rehash' : 'right';
  }

  /** 64 hex characters: well under bcrypt's 72-byte input limit. */
  private mix(code: string, secret: string): string {
    return hmacHex(secret, `myanflix:withdrawal-code:v1:${code}`);
  }
}
