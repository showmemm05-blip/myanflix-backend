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

  notifyUserDepositUpdated(
    userId: string,
    payload: DepositUpdatedPayload,
  ): void {
    this.server.to(userRoom(userId)).emit('deposit.updated', payload);
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
}
