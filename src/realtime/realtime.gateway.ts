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
import { UserStatus } from '../generated/prisma/client';
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

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
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
    } catch (error) {
      this.logger.debug(
        `Rejecting socket connection: ${(error as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(): void {
    // Nothing to clean up — room membership is discarded with the socket.
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
