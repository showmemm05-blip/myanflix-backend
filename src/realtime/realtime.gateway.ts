import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ClientPlatform, UserStatus } from '../generated/prisma/client';
import {
  resolveClientIp,
  resolveClientPlatform,
} from '../common/storage/request-host.context';
import { PeakUsersService } from '../peak-users/peak-users.service';
import { UsersService } from '../users/users.service';
import type { JwtPayload } from '../auth/types/jwt-payload.type';

function adminRoom(): string {
  return 'admins';
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

export interface DepositCreatedPayload {
  id: string;
  userId: string;
  username: string;
  /** Cosmetic label the user set; `username` above stays the login identity. */
  displayName: string | null;
  amount: number;
  paymentMethod: string;
  accountName: string | null;
  reference: string;
  status: string;
  createdAt: Date;
}

export interface DepositUpdatedPayload {
  id: string;
  status: string;
  amount: number;
  paymentMethod: string;
  reference: string;
  rejectionReason?: string | null;
  approvedAt?: Date | null;
  receivingAccountType?: string | null;
  receivingAccountSubname?: string | null;
  receivingAccountName?: string | null;
  receivingAccountNumber?: string | null;
  receivingTransactionCode?: string | null;
  receivingTransactionTime?: string | null;
}

export interface WithdrawalCreatedPayload {
  id: string;
  userId: string;
  username: string;
  /** Cosmetic label the user set; `username` above stays the login identity. */
  displayName: string | null;
  amount: number;
  accountType: string;
  accountName: string;
  accountNumber: string;
  /** Only set for bank-transfer account types — part of the user's own request snapshot. */
  bankName?: string | null;
  status: string;
  createdAt: Date;
}

export interface WithdrawalUpdatedPayload {
  id: string;
  status: string;
  amount: number;
  accountType: string;
  accountName: string;
  accountNumber: string;
  bankName?: string | null;
  rejectionReason?: string | null;
  approvedAt?: Date | null;
  transferAccountType?: string | null;
  transferAccountSubname?: string | null;
  transferAccountName?: string | null;
  transferAccountNumber?: string | null;
  transferTransactionCode?: string | null;
  transferTransactionTime?: string | null;
}

export interface NotificationCreatedPayload {
  id: string;
  type: string;
  title: string;
  message: string;
  payload: unknown;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Deliberately minimal — just enough for a listener to decide "does this
 * affect what I'm looking at" and refetch. Carrying the full balance/ledger
 * payload here would need this event to reach into Decimal-to-number
 * conversion and account-shape concerns that belong to the callers, not the
 * gateway; a refetch-on-signal pattern (mirroring how admin's deposit/
 * withdrawal lists already work) keeps this event cheap and always correct.
 */
export interface PaymentAccountUpdatedPayload {
  paymentAccountId: string;
}

/** One live audience socket, as the presence map remembers it. */
interface ConnectedUserSocket {
  userId: string;
  platform: ClientPlatform;
  ip: string | null;
  connectedAt: Date;
}

/**
 * One currently-online user, however many sockets they hold.
 *
 * `platforms` is what makes the web/mobile split honest: someone reading on
 * their phone while a laptop tab is still open is ONE active user who is
 * present on both. `platform`/`ip` describe their most recent connection —
 * the single value a one-row-per-user table shows — while `since` reaches
 * back to their earliest still-open socket, i.e. when they actually came
 * online.
 */
export interface ActiveSocketUser {
  userId: string;
  platform: ClientPlatform;
  platforms: ClientPlatform[];
  ip: string | null;
  since: Date;
}

/**
 * Socket.IO gateway attached to the same HTTP server Nest already runs (no
 * separate port, no Docker/compose change needed). Auth happens here in
 * handleConnection rather than via the HTTP JwtAuthGuard, since Socket.IO
 * connections never go through Nest's HTTP guard pipeline.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  /**
   * Sockets belonging to role USER, keyed by socket id — the concurrent
   * -audience peak count and the admin's live "who is online" list. Admin/
   * staff sockets (dashboards) are deliberately excluded from both: they are
   * operators, not audience.
   *
   * It used to hold just the user id; it now holds where that socket came
   * from as well. Peak counting is unchanged either way — it has always
   * counted DISTINCT user ids, so two tabs were and still are one user.
   */
  private readonly connectedUserSockets = new Map<
    string,
    ConnectedUserSocket
  >();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly peakUsersService: PeakUsersService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('No token provided');

      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const user = await this.usersService.findByIdOrThrow(payload.sub);
      if (user.status !== UserStatus.ACTIVE)
        throw new Error('Account is not active');

      client.data.userId = user.id;
      client.data.role = user.role;

      await client.join(userRoom(user.id));
      if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
        await client.join(adminRoom());
      }

      if (user.role === 'USER') {
        this.connectedUserSockets.set(client.id, {
          userId: user.id,
          platform: this.platformOf(client),
          ip: this.ipOf(client),
          connectedAt: new Date(),
        });
        const distinctUsers = this.distinctUserIds().size;
        // Fire-and-forget — peak tracking must never block or break the
        // connection path.
        this.peakUsersService
          .recordConcurrent(distinctUsers)
          .catch((error: Error) =>
            this.logger.warn(
              `Failed to record concurrent peak: ${error.message}`,
            ),
          );
      }
    } catch (error) {
      this.logger.debug(
        `Rejecting socket connection: ${(error as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    // Room membership is discarded with the socket; only the concurrent
    // USER-count bookkeeping needs explicit cleanup.
    this.connectedUserSockets.delete(client.id);
  }

  /**
   * Everyone currently holding at least one audience socket, one entry per
   * USER — never per socket. Feeds GET /tracking/active-users, which unions
   * it with recently-active sessions.
   *
   * Returned newest-first by `since` so the list leads with who just
   * arrived. A user is dropped from it the moment their last socket closes;
   * "recently active but not connected" is the session table's job, not
   * this map's.
   */
  getActiveUsers(): ActiveSocketUser[] {
    const byUser = new Map<string, ConnectedUserSocket[]>();
    for (const entry of this.connectedUserSockets.values()) {
      const existing = byUser.get(entry.userId);
      if (existing) existing.push(entry);
      else byUser.set(entry.userId, [entry]);
    }

    return [...byUser.entries()]
      .map(([userId, sockets]) => {
        const ordered = [...sockets].sort(
          (a, b) => a.connectedAt.getTime() - b.connectedAt.getTime(),
        );
        const newest = ordered[ordered.length - 1];
        return {
          userId,
          platform: newest.platform,
          platforms: [...new Set(ordered.map((s) => s.platform))],
          ip: newest.ip,
          since: ordered[0].connectedAt,
        };
      })
      .sort((a, b) => b.since.getTime() - a.since.getTime());
  }

  /** The count PeakUsersService has always been given: distinct users, not sockets. */
  private distinctUserIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.connectedUserSockets.values())
      ids.add(entry.userId);
    return ids;
  }

  /**
   * Which client opened this socket. Both apps declare it in the handshake
   * (`auth: { token, platform }`); the user-agent fallback and UNKNOWN
   * default are shared with the HTTP path so a socket and a request from the
   * same app never disagree.
   */
  private platformOf(client: Socket): ClientPlatform {
    const declared: unknown = client.handshake.auth?.['platform'];
    return resolveClientPlatform(
      typeof declared === 'string' ? declared : undefined,
      client.handshake.headers['user-agent'] ?? null,
    );
  }

  /**
   * The socket's client IP. `handshake.address` is the peer address, which
   * behind nginx/the cache server is the proxy — so the forwarded header
   * wins, exactly as it does for HTTP requests.
   */
  private ipOf(client: Socket): string | null {
    return resolveClientIp(
      client.handshake.headers['x-forwarded-for'],
      client.handshake.address,
    );
  }

  private extractToken(client: Socket): string | undefined {
    const fromAuth = client.handshake.auth?.['token'];
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

    return undefined;
  }

  notifyAdminsDepositCreated(payload: DepositCreatedPayload): void {
    this.server.to(adminRoom()).emit('deposit.created', payload);
  }

  /**
   * Broadcast to BOTH the depositing user's own room and the shared admins
   * room — status changes (approve/reject) and receiving-account saves need
   * to reach every open admin session, not just the user who deposited, so
   * a second admin tab reflects another admin's action without a manual
   * refresh. Same event name in both rooms is fine: each side's listener
   * only cares about the fields relevant to it (the admin table merges by
   * `id` into its existing row; the user's own client only ever receives
   * this for deposits it already knows about).
   */
  notifyUserDepositUpdated(
    userId: string,
    payload: DepositUpdatedPayload,
  ): void {
    this.server.to([userRoom(userId), adminRoom()]).emit('deposit.updated', payload);
  }

  notifyUserNotificationCreated(
    userId: string,
    payload: NotificationCreatedPayload,
  ): void {
    this.server.to(userRoom(userId)).emit('notification.created', payload);
  }

  notifyUserBalanceUpdated(userId: string, balance: number): void {
    this.server.to(userRoom(userId)).emit('wallet.balanceUpdated', { balance });
  }

  notifyAdminsWithdrawalCreated(payload: WithdrawalCreatedPayload): void {
    this.server.to(adminRoom()).emit('withdrawal.created', payload);
  }

  /** Mirrors notifyUserDepositUpdated's dual-room broadcast — see its doc comment. */
  notifyUserWithdrawalUpdated(
    userId: string,
    payload: WithdrawalUpdatedPayload,
  ): void {
    this.server.to([userRoom(userId), adminRoom()]).emit('withdrawal.updated', payload);
  }

  /**
   * Fired whenever a PaymentAccount's balance/ledger changes for any reason
   * (manual credit/debit, a deposit/withdrawal linking or re-linking to an
   * account) — admins-only, since these are internal bookkeeping accounts a
   * regular user never sees. Callers must only invoke this AFTER their own
   * `$transaction` has committed (mirroring every other notify* call site in
   * this codebase), never from inside PaymentAccountLedgerService's
   * `applyMovement` itself, which runs inside the caller's transaction and
   * could still roll back.
   */
  notifyAdminsPaymentAccountUpdated(payload: PaymentAccountUpdatedPayload): void {
    this.server.to(adminRoom()).emit('payment-account.updated', payload);
  }
}
