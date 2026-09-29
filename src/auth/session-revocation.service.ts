import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What the realtime gateway is told after an account's access changed.
 *
 * - `user`: every socket of this account must go (its sessions were revoked,
 *   it was suspended/banned/closed, or it no longer exists). A client that
 *   still holds a valid session reconnects with a fresh token; one that does
 *   not is refused at the handshake.
 * - `permissions`: a role's permission set changed, so every staff socket
 *   re-checks which permission rooms it belongs to.
 */
export type AccountAccessEvent =
  { kind: 'user'; userId: string } | { kind: 'permissions' };

export interface RevokeAllOptions {
  /**
   * The refresh token (its `jti`, carried as `sid` in the access token) that
   * stays signed in — only for a self-service password change, so the person
   * who just changed it is not thrown out with everyone else.
   */
  exceptSessionId?: string;
  /** Write inside the caller's interactive transaction. */
  client?: Prisma.TransactionClient;
}

/**
 * True when an access token predates the account's last "revoke every
 * session". Compared to the millisecond: `ims` (set by AuthService on every
 * access token it signs) says exactly when the token was minted, so a token
 * minted earlier in the same second as the revoke is refused, and the fresh
 * pair a refresh mints right after it never is. A token from before `ims`
 * existed falls back to its `iat`, counted from the start of that second; a
 * token with no issue time at all is refused once a revoke happened.
 */
export function isAccessTokenRevoked(
  token: { iat?: number; ims?: number },
  sessionsRevokedAt: Date | null | undefined,
): boolean {
  if (!sessionsRevokedAt) return false;
  const issuedAtMs =
    typeof token.ims === 'number'
      ? token.ims
      : typeof token.iat === 'number'
        ? token.iat * 1000
        : undefined;
  if (issuedAtMs === undefined) return true;
  return issuedAtMs < sessionsRevokedAt.getTime();
}

/**
 * The one place an account's sessions are revoked (H-21), and the channel
 * that tells the realtime gateway about it (H-3).
 *
 * Global and dependent on nothing but Prisma on purpose: users, staff, roles
 * and auth all need it, and the gateway itself depends on UsersModule, so a
 * direct gateway injection from any of those would close a module cycle.
 * The gateway subscribes to `events` instead.
 *
 * Revoking = every live refresh token is marked revoked AND
 * `users.sessionsRevokedAt` is stamped, which makes JwtStrategy and the
 * socket handshake refuse every access token issued before that moment.
 */
@Injectable()
export class SessionRevocationService {
  private readonly subject = new Subject<AccountAccessEvent>();

  /** Subscribed to by RealtimeGateway. */
  readonly events: Observable<AccountAccessEvent> = this.subject.asObservable();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Revokes every session of `userId` (optionally but one). Writes only —
   * a caller inside a transaction calls `disconnectUser` AFTER it commits,
   * so a rolled-back change never kicks anyone. Without a caller
   * transaction it runs in its own.
   *
   * B2 (H-21): the account row is locked FOR UPDATE first, and the
   * sessionsRevokedAt stamp is taken only once that lock is held. A refresh
   * holds the same row FOR SHARE for its whole rotation (AuthService.refresh),
   * so a refresh already running commits its new refresh row — and an access
   * token signed before this stamp — before anything below runs, and both
   * are revoked with the rest; a refresh arriving later waits for this
   * transaction and finds its token revoked. Lock order: users, then
   * refresh_tokens — the same as the refresh.
   */
  async revokeAll(
    userId: string,
    options: RevokeAllOptions = {},
  ): Promise<void> {
    if (!options.client) {
      await this.prisma.$transaction((tx) =>
        this.revokeAll(userId, { ...options, client: tx }),
      );
      return;
    }
    const { client } = options;
    await client.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    const revokedAt = new Date();
    await client.refreshToken.updateMany({
      where: {
        userId,
        revoked: false,
        ...(options.exceptSessionId && {
          id: { not: options.exceptSessionId },
        }),
      },
      data: { revoked: true },
    });
    await client.user.update({
      where: { id: userId },
      data: { sessionsRevokedAt: revokedAt },
    });
  }

  /** `revokeAll` in its own transaction, then every socket of the account is closed. */
  async revokeAllAndDisconnect(
    userId: string,
    options: Omit<RevokeAllOptions, 'client'> = {},
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.revokeAll(userId, { ...options, client: tx }),
    );
    this.disconnectUser(userId);
  }

  /** Close every socket of this account (after the change committed). */
  disconnectUser(userId: string): void {
    this.subject.next({ kind: 'user', userId });
  }

  /** A role's permissions changed: every staff socket re-checks its rooms. */
  permissionsChanged(): void {
    this.subject.next({ kind: 'permissions' });
  }
}
