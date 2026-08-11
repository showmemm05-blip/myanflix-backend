import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  NotificationType,
  TransactionType,
  WithdrawalStatus,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import type { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import type { UpdateTransferAccountDto } from './dto/update-transfer-account.dto';
import type { WithdrawalQueryDto } from './dto/withdrawal-query.dto';

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly financeSettingsService: FinanceSettingsService,
  ) {}

  /**
   * Balance is never touched here — only checked, so a rejected or
   * still-pending request never affects what the user can spend elsewhere.
   * This check is inherently a snapshot (other pending withdrawals aren't
   * reserved against it), which is fine: the real safety net is
   * `debitWithinTransaction`'s atomic `balance >= amount` guard at
   * approval time, which re-checks against whatever the balance actually
   * is then and fails the approval outright if it's no longer sufficient.
   */
  async create(userId: string, dto: CreateWithdrawalDto) {
    const { minWithdrawalAmount, maxWithdrawalAmount } =
      await this.financeSettingsService.getLimits();
    if (dto.amount < minWithdrawalAmount || dto.amount > maxWithdrawalAmount) {
      throw new BadRequestException(
        `Withdrawal amount must be between ${minWithdrawalAmount.toLocaleString('en-US')} and ${maxWithdrawalAmount.toLocaleString('en-US')} Ks`,
      );
    }

    const wallet = await this.walletService.getByUserId(userId);
    if (dto.amount > decimalToNumber(wallet.balance)) {
      throw new BadRequestException(
        'Withdrawal amount exceeds your available wallet balance',
      );
    }

    const withdrawal = await this.prisma.withdrawal.create({
      data: {
        userId,
        amount: dto.amount,
        accountType: dto.accountType,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true },
    });

    this.realtimeGateway.notifyAdminsWithdrawalCreated({
      id: withdrawal.id,
      userId: withdrawal.userId,
      username: user.username,
      amount: decimalToNumber(withdrawal.amount),
      accountType: withdrawal.accountType,
      accountName: withdrawal.accountName,
      accountNumber: withdrawal.accountNumber,
      status: withdrawal.status,
      createdAt: withdrawal.createdAt,
    });

    return this.toResponse(withdrawal);
  }

  async findAllForUser(userId: string, query: WithdrawalQueryDto) {
    return this.findAll({ ...query, userId });
  }

  /** Pending requests first — see the WithdrawalStatus enum doc comment in schema.prisma for why `orderBy: 'asc'` alone achieves this. */
  async findAllAdmin(query: WithdrawalQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { status: query.status, userId: query.userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: { id: true, username: true, email: true, phone: true },
          },
        },
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return {
      items: items.map((w) => ({ ...this.toResponse(w), user: w.user })),
      total,
      page,
      limit,
    };
  }

  private async findAll(query: WithdrawalQueryDto & { userId: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { userId: query.userId, status: query.status };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return { items: items.map((w) => this.toResponse(w)), total, page, limit };
  }

  /**
   * Atomically claims the withdrawal (only succeeds if it's still PENDING),
   * debits the wallet, and records the ledger + notification entries — all
   * inside one transaction. `debitWithinTransaction` re-checks the balance
   * atomically at this exact moment (not just at request time) and throws
   * if it's no longer sufficient, which rolls back the whole transaction —
   * including the PENDING->APPROVED claim — leaving the withdrawal PENDING
   * for the admin to retry or reject. A race between two approve() calls
   * (or an approve racing a reject) can only ever debit the wallet once,
   * for the same reason deposits' approve() can only ever credit once.
   */
  async approve(withdrawalId: string, admin: AuthenticatedUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');

      const claim = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: WithdrawalStatus.PENDING },
        data: {
          status: WithdrawalStatus.APPROVED,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException(
          'This withdrawal has already been approved or rejected',
        );
      }

      await this.walletService.debitWithinTransaction(
        tx,
        withdrawal.userId,
        withdrawal.amount.toNumber(),
      );

      await tx.transaction.create({
        data: {
          userId: withdrawal.userId,
          type: TransactionType.WITHDRAWAL,
          amount: withdrawal.amount,
          status: 'COMPLETED',
        },
      });

      const notification = await tx.notification.create({
        data: {
          userId: withdrawal.userId,
          type: NotificationType.WITHDRAWAL_APPROVED,
          title: 'Withdrawal approved',
          message: `Your withdrawal of ${withdrawal.amount.toString()} Ks has been approved and deducted from your balance.`,
          payload: {
            withdrawalId: withdrawal.id,
            amount: withdrawal.amount.toNumber(),
          },
        },
      });

      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: {
          user: {
            select: { id: true, username: true, email: true, phone: true },
          },
        },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: withdrawal.userId },
      });

      return { withdrawal: updated, notification, balance: wallet.balance };
    });

    this.realtimeGateway.notifyUserWithdrawalUpdated(result.withdrawal.userId, {
      id: result.withdrawal.id,
      status: result.withdrawal.status,
      amount: decimalToNumber(result.withdrawal.amount),
      accountType: result.withdrawal.accountType,
      accountName: result.withdrawal.accountName,
      accountNumber: result.withdrawal.accountNumber,
      approvedAt: result.withdrawal.approvedAt,
    });
    this.realtimeGateway.notifyUserNotificationCreated(
      result.withdrawal.userId,
      {
        id: result.notification.id,
        type: result.notification.type,
        title: result.notification.title,
        message: result.notification.message,
        payload: result.notification.payload,
        isRead: result.notification.isRead,
        createdAt: result.notification.createdAt,
      },
    );
    this.realtimeGateway.notifyUserBalanceUpdated(
      result.withdrawal.userId,
      decimalToNumber(result.balance),
    );

    return {
      ...this.toResponse(result.withdrawal),
      user: result.withdrawal.user,
    };
  }

  /** Same atomic claim pattern as approve() — never touches the wallet or ledger. */
  async reject(
    withdrawalId: string,
    admin: AuthenticatedUser,
    dto: RejectWithdrawalDto,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');

      const claim = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: WithdrawalStatus.PENDING },
        data: {
          status: WithdrawalStatus.REJECTED,
          rejectionReason: dto.reason,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException(
          'This withdrawal has already been approved or rejected',
        );
      }

      const notification = await tx.notification.create({
        data: {
          userId: withdrawal.userId,
          type: NotificationType.WITHDRAWAL_REJECTED,
          title: 'Withdrawal rejected',
          message: `Your withdrawal of ${withdrawal.amount.toString()} Ks was rejected: ${dto.reason}`,
          payload: { withdrawalId: withdrawal.id, reason: dto.reason },
        },
      });

      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: {
          user: {
            select: { id: true, username: true, email: true, phone: true },
          },
        },
      });
      return { withdrawal: updated, notification };
    });

    this.realtimeGateway.notifyUserWithdrawalUpdated(result.withdrawal.userId, {
      id: result.withdrawal.id,
      status: result.withdrawal.status,
      amount: decimalToNumber(result.withdrawal.amount),
      accountType: result.withdrawal.accountType,
      accountName: result.withdrawal.accountName,
      accountNumber: result.withdrawal.accountNumber,
      rejectionReason: result.withdrawal.rejectionReason,
    });
    this.realtimeGateway.notifyUserNotificationCreated(
      result.withdrawal.userId,
      {
        id: result.notification.id,
        type: result.notification.type,
        title: result.notification.title,
        message: result.notification.message,
        payload: result.notification.payload,
        isRead: result.notification.isRead,
        createdAt: result.notification.createdAt,
      },
    );

    return {
      ...this.toResponse(result.withdrawal),
      user: result.withdrawal.user,
    };
  }

  /**
   * Records OUR account — the one we sent the money FROM — after approval.
   * Entirely separate from accountType/accountName/accountNumber (the
   * user's own destination account), which this never touches, along with
   * status/approvedAt/wallet/ledger. Plain update, not the atomic-claim
   * transaction approve()/reject() use (no PENDING race to guard against).
   */
  async updateTransferAccount(
    withdrawalId: string,
    dto: UpdateTransferAccountDto,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (withdrawal.status !== WithdrawalStatus.APPROVED) {
      throw new BadRequestException(
        'The transfer account can only be edited for an approved withdrawal',
      );
    }

    const updated = await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        transferAccountType: dto.transferAccountType,
        transferAccountName: dto.transferAccountName,
        transferAccountNumber: dto.transferAccountNumber,
      },
      include: {
        user: {
          select: { id: true, username: true, email: true, phone: true },
        },
      },
    });

    this.realtimeGateway.notifyUserWithdrawalUpdated(updated.userId, {
      id: updated.id,
      status: updated.status,
      amount: decimalToNumber(updated.amount),
      accountType: updated.accountType,
      accountName: updated.accountName,
      accountNumber: updated.accountNumber,
      approvedAt: updated.approvedAt,
      transferAccountType: updated.transferAccountType,
      transferAccountName: updated.transferAccountName,
      transferAccountNumber: updated.transferAccountNumber,
    });

    return { ...this.toResponse(updated), user: updated.user };
  }

  private toResponse(withdrawal: {
    id: string;
    userId: string;
    amount: unknown;
    accountType: string;
    accountName: string;
    accountNumber: string;
    status: WithdrawalStatus;
    rejectionReason: string | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    transferAccountType?: string | null;
    transferAccountName?: string | null;
    transferAccountNumber?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...withdrawal,
      amount: decimalToNumber(withdrawal.amount as never),
    };
  }
}
