export interface JwtPayload {
  sub: string;
  /**
   * The refresh token (its `jti`) issued together with this access token —
   * the "session" a self-service password change keeps signed in. Absent on
   * tokens minted before H-21.
   */
  sid?: string;
  /** Issued-at, in seconds — set by jsonwebtoken on every signed token. */
  iat?: number;
  /**
   * Issued-at in milliseconds (H-21) — what the "sessions revoked" cutoff
   * compares against, so it has no one-second blind spot. Absent on tokens
   * minted before H-21 (their `iat` is used instead).
   */
  ims?: number;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
}
