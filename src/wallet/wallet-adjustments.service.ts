import { ConflictException, Injectable } from '@nestjs/common';
import {
  NotificationType,
  Prisma,
  TransactionType,
  WalletAdjustmentDirection,
} from '../generated/prisma/client';
import type {
  Notification,
  WalletAdjustment,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateWalletAdjustmentDto } from './dto/create-wallet-adjustment.dto';
import { WalletService } from './wallet.service';

type AdjustmentWithPerformer = WalletAdjustment & {
  performedBy: { id: string; username: string } | null;
};

/** Discriminated on `replayed` — a replay carries nothing to emit post-commit. */
type AdjustTransactionResult =
  | {
      adjustment: AdjustmentWithPerformer;
      replayed: true;
      notification: null;
      balance: null;
    }
  | {
      adjustment: AdjustmentWithPerformer;
      replayed: false;
      notification: Notification;
      balance: Prisma.Decimal;
    };

/**
 * Admin-initiated wallet balance corrections. Every adjustment atomically
 * moves the wallet balance, records a Transaction row
 * (ADJUSTMENT_CREDIT/ADJUSTMENT_DEBIT), an append-only WalletAdjustment audit
 * row, and a BALANCE_ADJUSTED notification — all in one $transaction,
 * mirroring DepositsService.approve(). Sockets are emitted only after the
 * transaction has actually committed.
 */
@Injectable()
export class WalletAdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  /**
   * `dto.idempotencyKey` makes this safe to retry: a key that has already
   * been written returns the original adjustment with `replayed: true` and
   * touches nothing — whether the duplicate arrives after the first commit
   * (the findUnique probe catches it) or races it concurrently (the unique
   * constraint rejects the loser with P2002 and the catch below refetches).
   */
  async adjust(
    userId: string,
    dto: CreateWalletAdjustmentDto,
    admin: AuthenticatedUser,
  ) {
    let result: AdjustTransactionResult;
    try {
      result = await this.prisma.$transaction(
        async (tx): Promise<AdjustTransactionResult> => {
          const existing = await tx.walletAdjustment.findUnique({
            where: { idempotencyKey: dto.idempotencyKey },
            include: { performedBy: { select: { id: true, username: true } } },
          });
          if (existing) {
            this.assertReplayMatches(existing, userId, dto);
            return {
              adjustment: existing,
              replayed: true as const,
              notification: null,
              balance: null,
            };
          }

          // The debit path keeps WalletService's gte guard — an adjustment can
          // never take a user's balance negative — and both paths throw
          // NotFound if the user has no wallet.
          const wallet =
            dto.direction === WalletAdjustmentDirection.CREDIT
              ? await this.walletService.creditWithinTransaction(
                  tx,
                  userId,
                  dto.amount,
                )
              : await this.walletService.debitWithinTransaction(
                  tx,
                  userId,
                  dto.amount,
                );

          // balanceBefore is derived arithmetically from the just-written
          // balance rather than a separate read-before-write, so it can't race
          // against a concurrent movement on the same wallet (same idiom as
          // PaymentAccountLedgerService.applyMovement).
          const amount = new Prisma.Decimal(dto.amount);
          const balanceAfter = wallet.balance;
          const balanceBefore =
            dto.direction === WalletAdjustmentDirection.CREDIT
              ? balanceAfter.minus(amount)
              : balanceAfter.plus(amount);

          const transaction = await tx.transaction.create({
            data: {
              userId,
              type:
                dto.direction === WalletAdjustmentDirection.CREDIT
                  ? TransactionType.ADJUSTMENT_CREDIT
                  : TransactionType.ADJUSTMENT_DEBIT,
              amount,
              status: 'COMPLETED',
            },
          });

          const adjustment = await tx.walletAdjustment.create({
            data: {
              userId,
              direction: dto.direction,
              amount,
              balanceBefore,
              balanceAfter,
              reason: dto.reason,
              idempotencyKey: dto.idempotencyKey,
              performedByUserId: admin.id,
              transactionId: transaction.id,
            },
            include: { performedBy: { select: { id: true, username: true } } },
          });

          // `reason` deliberately stays out of the user-facing message — it can
          // carry internal notes meant for admins only.
          const notification = await tx.notification.create({
            data: {
              userId,
              type: NotificationType.BALANCE_ADJUSTED,
              title: 'Balance adjusted',
              message: `Your wallet balance was ${
                dto.direction === WalletAdjustmentDirection.CREDIT
                  ? 'increased'
                  : 'decreased'
              } by ${amount.toString()} Ks by our support team.`,
              payload: {
                adjustmentId: adjustment.id,
                direction: dto.direction,
                amount: decimalToNumber(amount),
              },
            },
          });

          return {
            adjustment,
            replayed: false as const,
            notification,
            balance: balanceAfter,
          };
        },
      );
    } catch (error) {
      // Concurrent double-click race: both requests pass the findUnique probe
      // before either commits, the loser hits the unique constraint on
      // idempotencyKey — refetch the winner's row and replay it.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.walletAdjustment.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { performedBy: { select: { id: true, username: true } } },
        });
        if (existing) {
          this.assertReplayMatches(existing, userId, dto);
          return { ...this.toResponse(existing), replayed: true };
        }
      }
      throw error;
    }

    if (!result.replayed) {
      this.realtimeGateway.notifyUserNotificationCreated(userId, {
        id: result.notification.id,
        type: result.notification.type,
        title: result.notification.title,
        message: result.notification.message,
        payload: result.notification.payload,
        isRead: result.notification.isRead,
        createdAt: result.notification.createdAt,
      });
      this.realtimeGateway.notifyUserBalanceUpdated(
        userId,
        decimalToNumber(result.balance),
      );
    }

    return { ...this.toResponse(result.adjustment), replayed: result.replayed };
  }

  async list(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.walletAdjustment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { performedBy: { select: { id: true, username: true } } },
      }),
      this.prisma.walletAdjustment.count({ where: { userId } }),
    ]);

    return { items: items.map((a) => this.toResponse(a)), total, page, limit };
  }

  /**
   * A key replayed against a different user than it was written for is a
   * client bug (or a forged request), never a legitimate retry — reject it
   * rather than leak another user's adjustment. Likewise a replay whose
   * payload differs from the recorded row: silently returning the old row
   * would let an admin's *edited* retry (say, a corrected amount after a
   * lost response) report success while the edit is never applied.
   */
  private assertReplayMatches(
    adjustment: {
      userId: string;
      direction: WalletAdjustmentDirection;
      amount: Prisma.Decimal;
      reason: string;
    },
    userId: string,
    dto: CreateWalletAdjustmentDto,
  ): void {
    if (adjustment.userId !== userId) {
      throw new ConflictException(
        'This idempotency key was already used for a different user',
      );
    }
    if (
      adjustment.direction !== dto.direction ||
      !adjustment.amount.equals(new Prisma.Decimal(dto.amount)) ||
      adjustment.reason !== dto.reason
    ) {
      throw new ConflictException(
        'This idempotency key was already used for a different adjustment — close and reopen the dialog to record a new one',
      );
    }
  }

  private toResponse(adjustment: {
    id: string;
    userId: string;
    direction: WalletAdjustmentDirection;
    amount: Prisma.Decimal;
    balanceBefore: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    reason: string;
    idempotencyKey: string;
    transactionId: string | null;
    createdAt: Date;
    performedBy: { id: string; username: string } | null;
  }) {
    return {
      id: adjustment.id,
      userId: adjustment.userId,
      direction: adjustment.direction,
      amount: decimalToNumber(adjustment.amount),
      balanceBefore: decimalToNumber(adjustment.balanceBefore),
      balanceAfter: decimalToNumber(adjustment.balanceAfter),
      reason: adjustment.reason,
      idempotencyKey: adjustment.idempotencyKey,
      transactionId: adjustment.transactionId,
      performedBy: adjustment.performedBy,
      createdAt: adjustment.createdAt,
    };
  }
}
