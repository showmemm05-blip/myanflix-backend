import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  DepositStatus,
  NotificationType,
  TransactionType,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateDepositDto } from './dto/create-deposit.dto';
import type { RejectDepositDto } from './dto/reject-deposit.dto';
import type { DepositQueryDto } from './dto/deposit-query.dto';

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * PENDING/APPROVED deposits block reuse of the same reference; REJECTED
   * ones don't, so a user can resubmit under the same real-world payment
   * reference after a mistaken rejection. Balance never moves here.
   */
  async create(userId: string, dto: CreateDepositDto) {
    const duplicate = await this.prisma.deposit.findFirst({
      where: {
        reference: dto.reference,
        status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
      },
    });
    if (duplicate) {
      throw new ConflictException('A deposit with this transaction reference already exists');
    }

    const deposit = await this.prisma.deposit.create({
      data: {
        userId,
        amount: dto.amount,
        paymentMethod: dto.paymentMethod,
        reference: dto.reference,
      },
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true },
    });

    this.realtimeGateway.notifyAdminsDepositCreated({
      id: deposit.id,
      userId: deposit.userId,
      username: user.username,
      amount: decimalToNumber(deposit.amount),
      paymentMethod: deposit.paymentMethod,
      reference: deposit.reference,
      status: deposit.status,
      createdAt: deposit.createdAt,
    });

    return this.toResponse(deposit);
  }

  async findAllForUser(userId: string, query: DepositQueryDto) {
    return this.findAll({ ...query, userId });
  }

  async findAllAdmin(query: DepositQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { status: query.status, userId: query.userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      this.prisma.deposit.count({ where }),
    ]);

    return {
      items: items.map((d) => ({ ...this.toResponse(d), user: d.user })),
      total,
      page,
      limit,
    };
  }

  private async findAll(query: DepositQueryDto & { userId: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { userId: query.userId, status: query.status };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.deposit.count({ where }),
    ]);

    return { items: items.map((d) => this.toResponse(d)), total, page, limit };
  }

  /**
   * Atomically claims the deposit (only succeeds if it's still PENDING),
   * credits the wallet, and records the ledger + notification entries — all
   * inside one transaction so a race between two approve() calls (or an
   * approve racing a reject) can only ever credit the wallet once. Sockets
   * are emitted only after the transaction has actually committed.
   */
  async approve(depositId: string, admin: AuthenticatedUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Deposit not found');

      const claim = await tx.deposit.updateMany({
        where: { id: depositId, status: DepositStatus.PENDING },
        data: { status: DepositStatus.APPROVED, approvedByUserId: admin.id, approvedAt: new Date() },
      });
      if (claim.count !== 1) {
        throw new ConflictException('This deposit has already been approved or rejected');
      }

      await this.walletService.creditWithinTransaction(tx, deposit.userId, deposit.amount.toNumber());

      await tx.transaction.create({
        data: {
          userId: deposit.userId,
          type: TransactionType.DEPOSIT,
          amount: deposit.amount,
          status: 'COMPLETED',
        },
      });

      const notification = await tx.notification.create({
        data: {
          userId: deposit.userId,
          type: NotificationType.DEPOSIT_APPROVED,
          title: 'Deposit approved',
          message: `Your deposit of ${deposit.amount.toString()} Ks has been approved and your balance has been updated.`,
          payload: { depositId: deposit.id, amount: deposit.amount.toNumber() },
        },
      });

      const updated = await tx.deposit.findUniqueOrThrow({
        where: { id: depositId },
        include: { user: { select: { id: true, username: true, email: true } } },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: deposit.userId } });

      return { deposit: updated, notification, balance: wallet.balance };
    });

    this.realtimeGateway.notifyUserDepositUpdated(result.deposit.userId, {
      id: result.deposit.id,
      status: result.deposit.status,
      amount: decimalToNumber(result.deposit.amount),
      paymentMethod: result.deposit.paymentMethod,
      reference: result.deposit.reference,
      approvedAt: result.deposit.approvedAt,
    });
    this.realtimeGateway.notifyUserNotificationCreated(result.deposit.userId, {
      id: result.notification.id,
      type: result.notification.type,
      title: result.notification.title,
      message: result.notification.message,
      payload: result.notification.payload,
      isRead: result.notification.isRead,
      createdAt: result.notification.createdAt,
    });
    this.realtimeGateway.notifyUserBalanceUpdated(result.deposit.userId, decimalToNumber(result.balance));

    return { ...this.toResponse(result.deposit), user: result.deposit.user };
  }

  /** Same atomic claim pattern as approve() — never touches the wallet or ledger. */
  async reject(depositId: string, admin: AuthenticatedUser, dto: RejectDepositDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Deposit not found');

      const claim = await tx.deposit.updateMany({
        where: { id: depositId, status: DepositStatus.PENDING },
        data: {
          status: DepositStatus.REJECTED,
          rejectionReason: dto.reason,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException('This deposit has already been approved or rejected');
      }

      const notification = await tx.notification.create({
        data: {
          userId: deposit.userId,
          type: NotificationType.DEPOSIT_REJECTED,
          title: 'Deposit rejected',
          message: `Your deposit of ${deposit.amount.toString()} Ks was rejected: ${dto.reason}`,
          payload: { depositId: deposit.id, reason: dto.reason },
        },
      });

      const updated = await tx.deposit.findUniqueOrThrow({
        where: { id: depositId },
        include: { user: { select: { id: true, username: true, email: true } } },
      });
      return { deposit: updated, notification };
    });

    this.realtimeGateway.notifyUserDepositUpdated(result.deposit.userId, {
      id: result.deposit.id,
      status: result.deposit.status,
      amount: decimalToNumber(result.deposit.amount),
      paymentMethod: result.deposit.paymentMethod,
      reference: result.deposit.reference,
      rejectionReason: result.deposit.rejectionReason,
    });
    this.realtimeGateway.notifyUserNotificationCreated(result.deposit.userId, {
      id: result.notification.id,
      type: result.notification.type,
      title: result.notification.title,
      message: result.notification.message,
      payload: result.notification.payload,
      isRead: result.notification.isRead,
      createdAt: result.notification.createdAt,
    });

    return { ...this.toResponse(result.deposit), user: result.deposit.user };
  }

  private toResponse(deposit: {
    id: string;
    userId: string;
    amount: unknown;
    paymentMethod: string;
    reference: string;
    status: DepositStatus;
    rejectionReason: string | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...deposit,
      amount: decimalToNumber(deposit.amount as never),
    };
  }
}
