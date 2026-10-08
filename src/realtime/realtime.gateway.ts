import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ClientPlatform, Role, UserStatus } from '../generated/prisma/client';
import { resolveClientPlatform } from '../common/storage/request-host.context';
import { trustedClientIp } from '../config/trusted-proxies';
import { PeakUsersService } from '../peak-users/peak-users.service';
import { UsersService } from '../users/users.service';
import type { JwtPayload } from '../auth/types/jwt-payload.type';
import {
  type AccountAccessEvent,
  SessionRevocationService,
  isAccessTokenRevoked,
} from '../auth/session-revocation.service';
import {
  PermissionResolverService,
  type PermissionSubject,
} from '../roles/permission-resolver.service';
import type { Permission } from '../roles/permission-catalogue';

/**
 * H-3: the permissions that gate a realtime room. Every staff event goes to
 * the room of the permission that gates the same data over REST — never to
 * a room picked by the legacy role enum — so a push reaches exactly the
 * staff who could have fetched it:
 *
 * - deposit.created/updated/verification     -> DEPOSITS.VIEW
 * - withdrawal.created/updated/verification  -> WITHDRAWALS.VIEW
 * - bank-transaction.created/updated         -> BANK_TRANSACTIONS.VIEW
 * - payment-account.updated (an id only)     -> PAYMENT_ACCOUNTS.VIEW or FINANCE.VIEW
 */
const REALTIME_PERMISSIONS = [
  'DEPOSITS.VIEW',
  'WITHDRAWALS.VIEW',
  'BANK_TRANSACTIONS.VIEW',
  'PAYMENT_ACCOUNTS.VIEW',
  'FINANCE.VIEW',
] as const satisfies readonly Permission[];

type RealtimePermission = (typeof REALTIME_PERMISSIONS)[number];

const PERMISSION_ROOM_PREFIX = 'perm:';

export function permissionRoom(permission: RealtimePermission): string {
  return `${PERMISSION_ROOM_PREFIX}${permission}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** What this gateway keeps on `socket.data` (socket.io types it as `any`). */
interface SocketData {
  userId?: string;
  role?: Role;
  machine?: 'phone-monitor';
}

/** What room syncing needs of a socket — a live Socket or a fetchSockets() entry. */
interface RoomMember {
  rooms: Set<string>;
  join(rooms: string | string[]): unknown;
  leave(room: string): unknown;
}

/**
 * The phone-monitor desktop app's sockets. Since bank_transactions
 * (store-first ingestion) nothing is emitted INTO this room any more — a
 * transfer that arrives first matches when the deposit is created, one
 * that arrives later matches at ingestion, so the old "post your outbox
 * now" nudge had no third case left to cover. The handshake and the room
 * stay: the phone-monitor uses the open socket as its "live link"
 * connectivity indicator. Never a user room, never counted as audience.
 */
function bankMonitorRoom(): string {
  return 'bank-monitors';
}

export interface DepositCreatedPayload {
  id: string;
  userId: string;
  username: string;
  /** Cosmetic label the user set; `username` above stays the login identity. */
  displayName: string | null;
  /** Contact identities, so the admin's live row can show one without a refetch. */
  phone: string | null;
  email: string | null;
  amount: number;
  paymentMethod: string;
  accountName: string | null;
  reference: string;
  /** Which of OUR accounts the user says they paid into — the Destination Account column reads it on a live-prepended row. */
  declaredPaymentAccountId: string | null;
  status: string;
  createdAt: Date;
  /** Pre-bank flags computed at create time (twins, velocity) — a DEPOSITS.VIEW-room event, so safe here. */
  matchStatus: string;
  riskLevel: string | null;
  riskReasons: string[];
}

/**
 * Bank-verification state of one deposit, for the DEPOSITS.VIEW room ONLY — the
 * user-facing `deposit.updated` must never carry a fraud score.
 */
export interface DepositVerificationPayload {
  id: string;
  matchStatus: string;
  riskLevel: string | null;
  riskReasons: string[];
  receivingAmount: number | null;
  receivingTransactionCode: string | null;
  receivingTransactionAt: Date | null;
  bankCheckedAt: Date | null;
  hasBankScreenshot: boolean;
  /** The bank_transactions row that claimed it, so the dialog can link to it. */
  bankTransactionId: string | null;
  /** The bank's "from" name (M-16) — beside the depositor's own name in the dialog. */
  bankCounterparty: string | null;
}

export interface WithdrawalVerificationPayload {
  id: string;
  matchStatus: string;
  riskLevel: string | null;
  riskReasons: string[];
  transferAmount: number | null;
  transferTransactionCode: string | null;
  transferTransactionAt: Date | null;
  bankCheckedAt: Date | null;
  hasBankScreenshot: boolean;
  bankTransactionId: string | null;
}

/**
 * One stored phone notification for the admin "Bank transactions" page —
 * the list item without the payment-account join (the page already holds
 * the accounts). `view` is the read-time derivation (UNCLAIMED after 48 h);
 * the screenshot key itself never leaves the server.
 */
export interface BankTransactionPayload {
  id: string;
  deviceSerial: string;
  paymentAccountId: string;
  direction: string;
  amount: number;
  currency: string;
  txCode: string;
  txCodeLast6: string;
  occurredAt: Date;
  postedAt: Date;
  counterparty: string | null;
  detailStatus: string | null;
  state: string;
  view: 'MATCHED' | 'WAITING' | 'AMBIGUOUS' | 'UNCLAIMED';
  linkedDepositId: string | null;
  linkedWithdrawalId: string | null;
  matchedAt: Date | null;
  hasScreenshot: boolean;
  createdAt: Date;
}

export interface DepositUpdatedPayload {
  id: string;
  /**
   * What this update is about. `status` is a decision (approve/reject) and
   * reaches the user; `receiving_account` is admin bookkeeping (which of OUR
   * accounts the money landed in) and is emitted to staff only — see
   * notifyAdminsDepositUpdated. Clients use it to tell "you were approved"
   * from "an admin corrected a field you never see".
   */
  change: 'status' | 'receiving_account';
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
  /** Contact identities, so the admin's live row can show one without a refetch. */
  phone: string | null;
  email: string | null;
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
  /** Mirrors DepositUpdatedPayload.change — `transfer_account` is staff-only bookkeeping. */
  change: 'status' | 'transfer_account';
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
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private accessEvents?: Subscription;

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

  /**
   * How many audience sockets each USER currently holds, kept in step with
   * connectedUserSockets (a user is removed when their last socket closes).
   * Its size is the distinct-user count the peak tracker is given — read in
   * O(1) instead of rebuilding a set of every connected socket on each
   * connect, which made a mass reconnect after a restart O(n²).
   */
  private readonly userSocketCounts = new Map<string, number>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly peakUsersService: PeakUsersService,
    private readonly permissionResolver: PermissionResolverService,
    private readonly sessions: SessionRevocationService,
  ) {}

  /**
   * Listens for account-access changes (H-3/H-21): a revoked, suspended,
   * deleted or closed account loses every socket at once, and a role
   * permission edit re-checks the rooms of every open staff socket.
   */
  onModuleInit(): void {
    this.accessEvents = this.sessions.events.subscribe(
      (event: AccountAccessEvent) => {
        if (event.kind === 'user') this.disconnectUser(event.userId);
        else void this.resyncStaffRooms();
      },
    );
  }

  onModuleDestroy(): void {
    this.accessEvents?.unsubscribe();
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      // Machine handshake FIRST: the phone-monitor presents the shared
      // BANK_EVENTS_TOKEN (never a JWT) and only ever joins its own room —
      // it is neither a user nor an admin, so it must not fall through to
      // the user path below, enter connectedUserSockets, or count as
      // audience. An unset token means ingestion is disabled: refuse.
      const machineToken: unknown = client.handshake.auth?.['machineToken'];
      if (typeof machineToken === 'string' && machineToken.length > 0) {
        const expected = this.configService.get<string>('BANK_EVENTS_TOKEN');
        if (!expected || !tokensMatch(machineToken, expected)) {
          throw new Error('Machine token rejected');
        }
        (client.data as SocketData).machine = 'phone-monitor';
        await client.join(bankMonitorRoom());
        return;
      }

      const token = this.extractToken(client);
      if (!token) throw new Error('No token provided');

      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Narrow read: only the columns checked here (no password hash).
      const user = await this.usersService.findAuthSubject(payload.sub);
      if (!user) throw new Error('User not found');
      if (user.status !== UserStatus.ACTIVE)
        throw new Error('Account is not active');
      // H-21: the same cutoff JwtStrategy applies to HTTP requests.
      if (isAccessTokenRevoked(payload, user.sessionsRevokedAt))
        throw new Error('Session has been signed out');

      const data = client.data as SocketData;
      data.userId = user.id;
      data.role = user.role;

      await client.join(userRoom(user.id));
      // H-3: staff join one room per permission they actually hold, resolved
      // through their AppRole. A customer account never joins one.
      if (user.role !== Role.USER) {
        await this.syncPermissionRooms(client, user);
      }

      if (user.role === 'USER') {
        this.trackUserSocket(client.id, {
          userId: user.id,
          platform: this.platformOf(client),
          ip: this.ipOf(client),
          connectedAt: new Date(),
        });
        const distinctUsers = this.userSocketCounts.size;
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
    this.untrackUserSocket(client.id);
  }

  private trackUserSocket(socketId: string, entry: ConnectedUserSocket): void {
    // A socket id is only ever connected once; never count one twice.
    if (this.connectedUserSockets.has(socketId))
      this.untrackUserSocket(socketId);
    this.connectedUserSockets.set(socketId, entry);
    this.userSocketCounts.set(
      entry.userId,
      (this.userSocketCounts.get(entry.userId) ?? 0) + 1,
    );
  }

  private untrackUserSocket(socketId: string): void {
    const entry = this.connectedUserSockets.get(socketId);
    if (!entry) return;
    this.connectedUserSockets.delete(socketId);
    const remaining = (this.userSocketCounts.get(entry.userId) ?? 1) - 1;
    if (remaining > 0) this.userSocketCounts.set(entry.userId, remaining);
    else this.userSocketCounts.delete(entry.userId);
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

  /**
   * Puts a staff socket in exactly the permission rooms its account holds
   * now: leaves the ones it lost, joins the ones it gained.
   */
  private async syncPermissionRooms(
    socket: RoomMember,
    user: PermissionSubject,
  ): Promise<void> {
    const granted = await this.permissionResolver.permissionsFor(user);
    const wanted = new Set(
      REALTIME_PERMISSIONS.filter((permission) => granted.has(permission)).map(
        permissionRoom,
      ),
    );
    for (const room of [...socket.rooms]) {
      if (room.startsWith(PERMISSION_ROOM_PREFIX) && !wanted.has(room)) {
        await socket.leave(room);
      }
    }
    const missing = [...wanted].filter((room) => !socket.rooms.has(room));
    if (missing.length > 0) await socket.join(missing);
  }

  /** Every socket of one account, on every tab and device, is closed. */
  private disconnectUser(userId: string): void {
    if (!this.server) return;
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  /**
   * A role's permissions changed: re-reads every open staff socket's account
   * and re-syncs its rooms (closing it if the account is no longer active).
   * Customer and phone-monitor sockets hold no permission rooms, so they are
   * skipped. Never throws — it runs off an event, not a request.
   */
  private async resyncStaffRooms(): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        const data = socket.data as SocketData;
        if (!data.userId || data.role === Role.USER) continue;

        const user = await this.usersService.findById(data.userId);
        if (!user || user.status !== UserStatus.ACTIVE) {
          socket.disconnect(true);
          continue;
        }
        await this.syncPermissionRooms(socket, user);
      }
    } catch (error) {
      this.logger.warn(
        `Could not re-check staff socket rooms: ${(error as Error).message}`,
      );
    }
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
   * The socket's client IP. `handshake.address` is the peer address; the
   * forwarded header is believed only when that peer is a proxy listed in
   * TRUSTED_PROXIES — the same rule as HTTP requests and the rate limiter
   * (config/trusted-proxies.ts, M-5), so a client cannot pick the address
   * the live "active users" list shows for it.
   */
  private ipOf(client: Socket): string | null {
    return trustedClientIp(
      client.handshake.headers['x-forwarded-for'],
      client.handshake.address,
    );
  }

  private extractToken(client: Socket): string | undefined {
    const fromAuth: unknown = client.handshake.auth?.['token'];
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

    return undefined;
  }

  notifyAdminsDepositCreated(payload: DepositCreatedPayload): void {
    this.server
      .to(permissionRoom('DEPOSITS.VIEW'))
      .emit('deposit.created', payload);
  }

  /**
   * To EVERY connected client, users and admins alike: the public list of
   * business accounts changed. A deactivated account has to leave the
   * deposit picker on every phone and browser at once — not on the next
   * cache expiry, when a user may already be typing a transfer to it.
   * Payload-free on purpose: the list is tiny and public, so clients simply
   * refetch it rather than trusting a partial patch.
   */
  notifyPaymentAccountsChanged(): void {
    this.server.emit('payment-accounts.changed', {});
  }

  /**
   * A DECISION on a deposit (approve/reject, `change: 'status'`): broadcast
   * to BOTH the depositing user's own room and the DEPOSITS.VIEW room. The
   * user's client toasts and refetches on it; every open staff session that
   * may see deposits gets it too, so a second admin tab reflects another
   * admin's action without a manual refresh. Same event name in both rooms is fine: each side's
   * listener only cares about the fields relevant to it (the admin table
   * merges by `id` into its existing row; the user's own client only ever
   * receives this for deposits it already knows about).
   *
   * NOT for receiving-account edits — those go through
   * notifyAdminsDepositUpdated, which never touches the user's room.
   */
  notifyUserDepositUpdated(
    userId: string,
    payload: DepositUpdatedPayload,
  ): void {
    this.server
      .to([userRoom(userId), permissionRoom('DEPOSITS.VIEW')])
      .emit('deposit.updated', payload);
  }

  /**
   * Admin bookkeeping on a deposit (`change: 'receiving_account'`): an admin
   * corrected which of OUR business accounts the money landed in, or its
   * transaction code/time. Emitted as the SAME `deposit.updated` event so the
   * admin table's existing merge-by-`id` handler keeps every open admin
   * session in sync — but to the DEPOSITS.VIEW room ONLY. The user never displays
   * these fields and must never be pinged about them: the website's wallet
   * hook toasts "Deposit approved" on any `deposit.updated` whose status is
   * APPROVED, so routing an account edit through the user's room made every
   * admin correction pop up as a fresh approval on the user's screen.
   */
  notifyAdminsDepositUpdated(payload: DepositUpdatedPayload): void {
    this.server
      .to(permissionRoom('DEPOSITS.VIEW'))
      .emit('deposit.updated', payload);
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
    this.server
      .to(permissionRoom('WITHDRAWALS.VIEW'))
      .emit('withdrawal.created', payload);
  }

  /** Mirrors notifyUserDepositUpdated's dual-room broadcast — see its doc comment. */
  notifyUserWithdrawalUpdated(
    userId: string,
    payload: WithdrawalUpdatedPayload,
  ): void {
    this.server
      .to([userRoom(userId), permissionRoom('WITHDRAWALS.VIEW')])
      .emit('withdrawal.updated', payload);
  }

  /**
   * Mirrors notifyAdminsDepositUpdated — a transfer-account edit
   * (`change: 'transfer_account'`, the account WE paid out from) is admin
   * bookkeeping the user never sees, so it goes to the WITHDRAWALS.VIEW room ONLY;
   * the user's room would otherwise toast "Withdrawal approved" again.
   */
  notifyAdminsWithdrawalUpdated(payload: WithdrawalUpdatedPayload): void {
    this.server
      .to(permissionRoom('WITHDRAWALS.VIEW'))
      .emit('withdrawal.updated', payload);
  }

  /**
   * Fired whenever a PaymentAccount's balance/ledger changes for any reason
   * (manual credit/debit, a deposit/withdrawal linking or re-linking to an
   * account) — to the PAYMENT_ACCOUNTS.VIEW and FINANCE.VIEW rooms (the
   * payment-account pages and the finance overview), since these are
   * internal bookkeeping accounts a regular user never sees. The payload is
   * an id alone, so it tells a FINANCE.VIEW holder nothing it could not read. Callers must only invoke this AFTER their own
   * `$transaction` has committed (mirroring every other notify* call site in
   * this codebase), never from inside PaymentAccountLedgerService's
   * `applyMovement` itself, which runs inside the caller's transaction and
   * could still roll back.
   */
  notifyAdminsPaymentAccountUpdated(
    payload: PaymentAccountUpdatedPayload,
  ): void {
    this.server
      .to([
        permissionRoom('PAYMENT_ACCOUNTS.VIEW'),
        permissionRoom('FINANCE.VIEW'),
      ])
      .emit('payment-account.updated', payload);
  }

  /**
   * Bank-verification change on a deposit (a phone-monitor match, a risk
   * recompute, a staff review) — DEPOSITS.VIEW room ONLY. The depositing user's
   * room deliberately never receives it: a user must not see their own
   * fraud score, and `deposit.updated` (which does reach them) never gains
   * these fields.
   */
  notifyAdminsDepositVerificationUpdated(
    payload: DepositVerificationPayload,
  ): void {
    this.server
      .to(permissionRoom('DEPOSITS.VIEW'))
      .emit('deposit.verification', payload);
  }

  /** Mirrors notifyAdminsDepositVerificationUpdated — WITHDRAWALS.VIEW only. */
  notifyAdminsWithdrawalVerificationUpdated(
    payload: WithdrawalVerificationPayload,
  ): void {
    this.server
      .to(permissionRoom('WITHDRAWALS.VIEW'))
      .emit('withdrawal.verification', payload);
  }

  /**
   * A phone notification was stored (BANK_TRANSACTIONS.VIEW room only — it
   * carries the business account's money movements, and no seeded role but
   * Super Admin may read them). Emitted only AFTER the per-event
   * transaction committed, like every notify* here.
   */
  notifyAdminsBankTransactionCreated(payload: BankTransactionPayload): void {
    this.server
      .to(permissionRoom('BANK_TRANSACTIONS.VIEW'))
      .emit('bank-transaction.created', payload);
  }

  /** Link / unlink / state change / screenshot attach on a stored row — BANK_TRANSACTIONS.VIEW only. */
  notifyAdminsBankTransactionUpdated(payload: BankTransactionPayload): void {
    this.server
      .to(permissionRoom('BANK_TRANSACTIONS.VIEW'))
      .emit('bank-transaction.updated', payload);
  }
}

/**
 * Constant-time equality for the machine token. Both sides are hashed
 * first so the buffers compared are always the same length — a raw
 * timingSafeEqual would throw (and leak the expected length) on a
 * presented token of a different size. Shared with MachineTokenGuard.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
