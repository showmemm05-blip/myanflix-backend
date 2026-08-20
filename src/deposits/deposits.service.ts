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
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  DepositStatus,
  NotificationType,
  TransactionType,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateDepositDto } from './dto/create-deposit.dto';
import type { CreateManualDepositDto } from './dto/create-manual-deposit.dto';
import type { ApproveDepositDto } from './dto/approve-deposit.dto';
import type { RejectDepositDto } from './dto/reject-deposit.dto';
import type { DepositQueryDto } from './dto/deposit-query.dto';
import type { UpdateReceivingAccountDto } from './dto/update-receiving-account.dto';

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly financeSettingsService: FinanceSettingsService,
    private readonly paymentAccountLedgerService: PaymentAccountLedgerService,
  ) {}

  /**
   * PENDING/APPROVED deposits block reuse of the same reference; REJECTED
   * ones don't, so a user can resubmit under the same real-world payment
   * reference after a mistaken rejection. Balance never moves here.
   */
  async create(userId: string, dto: CreateDepositDto) {
    const { minDepositAmount, maxDepositAmount } =
      await this.financeSettingsService.getLimits();
    if (dto.amount < minDepositAmount || dto.amount > maxDepositAmount) {
      throw new BadRequestException(
        `Deposit amount must be between ${minDepositAmount.toLocaleString('en-US')} and ${maxDepositAmount.toLocaleString('en-US')} Ks`,
      );
    }

    const duplicate = await this.prisma.deposit.findFirst({
      where: {
        reference: dto.reference,
        status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
      },
    });
    if (duplicate) {
      throw new ConflictException(
        'A deposit with this transaction reference already exists',
      );
    }

    const deposit = await this.prisma.deposit.create({
      data: {
        userId,
        amount: dto.amount,
        paymentMethod: dto.paymentMethod,
        accountName: dto.accountName,
        reference: dto.reference,
        declaredPaymentAccountId: dto.paymentAccountId,
      },
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true, displayName: true },
    });

    this.realtimeGateway.notifyAdminsDepositCreated({
      id: deposit.id,
      userId: deposit.userId,
      username: user.username,
      displayName: user.displayName,
      amount: decimalToNumber(deposit.amount),
      paymentMethod: deposit.paymentMethod,
      accountName: deposit.accountName,
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
    const where = {
      status: query.status,
      userId: query.userId,
      createdAt:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
            },
          },
        },
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
    const where = {
      userId: query.userId,
      status: query.status,
      createdAt:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
    };

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
  async approve(depositId: string, admin: AuthenticatedUser, dto: ApproveDepositDto = {}) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Deposit not found');

      const claim = await tx.deposit.updateMany({
        where: { id: depositId, status: DepositStatus.PENDING },
        data: {
          status: DepositStatus.APPROVED,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException(
          'This deposit has already been approved or rejected',
        );
      }

      // Credits a payment account the moment this deposit is approved — no
      // separate admin step required. `dto.paymentAccountId` (an explicit
      // admin pick at approval time, including an explicit `null` to credit
      // nothing) takes precedence when present; otherwise falls back to
      // whatever the depositor declared at submission time. No-ops if
      // neither is set. An admin can still re-link or add transaction-code/
      // time detail afterward via updateReceivingAccount, which correctly
      // no-ops the ledger when the account doesn't change.
      const accountToCredit =
        dto.paymentAccountId !== undefined
          ? dto.paymentAccountId
          : deposit.declaredPaymentAccountId;
      await this.paymentAccountLedgerService.syncDepositLink(
        tx,
        deposit,
        accountToCredit,
        deposit.reference,
        admin.id,
      );

      const creditedWallet = await this.walletService.creditWithinTransaction(
        tx,
        deposit.userId,
        deposit.amount.toNumber(),
      );

      // Snapshot the wallet balance around this credit onto the deposit row,
      // inside the same transaction — creditWithinTransaction returns the
      // post-credit wallet, so before = after - amount can never drift from
      // the credit that produced it.
      await tx.deposit.update({
        where: { id: depositId },
        data: {
          walletBalanceBefore: creditedWallet.balance.minus(deposit.amount),
          walletBalanceAfter: creditedWallet.balance,
        },
      });

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
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
            },
          },
        },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: deposit.userId },
      });

      return { deposit: updated, notification, balance: wallet.balance, accountToCredit };
    });

    if (result.accountToCredit) {
      this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
        paymentAccountId: result.accountToCredit,
      });
    }

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
    this.realtimeGateway.notifyUserBalanceUpdated(
      result.deposit.userId,
      decimalToNumber(result.balance),
    );

    return { ...this.toResponse(result.deposit), user: result.deposit.user };
  }

  /**
   * Admin records a deposit that already happened (money visibly landed in
   * one of OUR accounts) — created directly in APPROVED state, so it mirrors
   * approve()'s side effects exactly in one transaction: destination-account
   * ledger credit via syncDepositLink, wallet credit, Transaction row and
   * DEPOSIT_APPROVED notification. Sockets are emitted only after the
   * transaction has actually committed, same as approve().
   */
  async createManual(dto: CreateManualDepositDto, admin: AuthenticatedUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: dto.userId } });
      if (!user) throw new NotFoundException('User not found');

      // Same duplicate-reference rule create() enforces — without it, an
      // admin recording a transfer the user ALSO submitted through the app
      // would let the same real-world payment credit the wallet twice (once
      // here, once when the pending copy gets approved).
      const duplicate = await tx.deposit.findFirst({
        where: {
          reference: dto.reference,
          status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
        },
      });
      if (duplicate) {
        throw new ConflictException(
          'A deposit with this transaction reference already exists',
        );
      }

      // Explicit existence check so a bogus destination id surfaces as a
      // 404 instead of a Prisma P2025 → 500 (the ledger layer would still
      // roll everything back, but with an opaque error).
      const destinationAccount = await tx.paymentAccount.findUnique({
        where: { id: dto.destinationPaymentAccountId },
      });
      if (!destinationAccount) {
        throw new NotFoundException('Payment account not found');
      }

      // declaredPaymentAccountId and the four receivingAccount* free-text
      // fields stay null — the admin can fill the FROM record later via the
      // existing table cell.
      const deposit = await tx.deposit.create({
        data: {
          userId: dto.userId,
          amount: dto.amount,
          paymentMethod: dto.paymentMethod,
          accountName: dto.accountName ?? null,
          reference: dto.reference,
          status: DepositStatus.APPROVED,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
          receivingTransactionCode: dto.receivingTransactionCode ?? null,
          receivingTransactionTime: dto.receivingTransactionTime ?? null,
        },
      });

      // Posts DEPOSIT_IN and credits the destination account atomically —
      // the ONLY correct way to credit it. Throws for a bogus account id,
      // rolling back the whole transaction.
      await this.paymentAccountLedgerService.syncDepositLink(
        tx,
        deposit,
        dto.destinationPaymentAccountId,
        dto.receivingTransactionCode ?? dto.reference,
        admin.id,
      );

      const creditedWallet = await this.walletService.creditWithinTransaction(
        tx,
        dto.userId,
        dto.amount,
      );

      // Same wallet-balance snapshot approve() records — see the comment
      // there; a manual deposit credits the wallet in exactly the same way.
      await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          walletBalanceBefore: creditedWallet.balance.minus(deposit.amount),
          walletBalanceAfter: creditedWallet.balance,
        },
      });

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

      const created = await tx.deposit.findUniqueOrThrow({
        where: { id: deposit.id },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
            },
          },
        },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: deposit.userId },
      });

      return { deposit: created, notification, balance: wallet.balance };
    });

    this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
      paymentAccountId: dto.destinationPaymentAccountId,
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
    this.realtimeGateway.notifyUserBalanceUpdated(
      result.deposit.userId,
      decimalToNumber(result.balance),
    );

    return { ...this.toResponse(result.deposit), user: result.deposit.user };
  }

  /** Same atomic claim pattern as approve() — never touches the wallet or ledger. */
  async reject(
    depositId: string,
    admin: AuthenticatedUser,
    dto: RejectDepositDto,
  ) {
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
        throw new ConflictException(
          'This deposit has already been approved or rejected',
        );
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
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
            },
          },
        },
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

  /**
   * Records which of OUR accounts received this deposit — entirely separate
   * from paymentMethod/accountName (the user's own submitted info, never
   * touched by this) and never touches status/wallet ledger. Mirrors
   * WithdrawalsService.updateTransferAccount.
   *
   * Wrapped in its own $transaction so the payment-account ledger sync
   * (which may post a reversal + a fresh DEPOSIT_IN when re-linking to a
   * different account) and the Deposit row update commit atomically.
   */
  async updateReceivingAccount(
    depositId: string,
    dto: UpdateReceivingAccountDto,
    admin: AuthenticatedUser,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({
        where: { id: depositId },
      });
      if (!deposit) throw new NotFoundException('Deposit not found');
      if (deposit.status !== DepositStatus.APPROVED) {
        throw new BadRequestException(
          'The receiving account can only be edited for an approved deposit',
        );
      }

      const oldPaymentAccountId = deposit.receivingPaymentAccountId;
      // PATCH semantics (see UpdateReceivingAccountDto): undefined = leave
      // the stored value untouched, explicit null = clear. The catalog link
      // and the free-text record are managed by two different admin cells,
      // and neither may clobber the other's fields by omission.
      const newPaymentAccountId =
        dto.paymentAccountId === undefined
          ? deposit.receivingPaymentAccountId
          : dto.paymentAccountId;
      const ledgerReference =
        dto.receivingTransactionCode === undefined
          ? deposit.receivingTransactionCode
          : dto.receivingTransactionCode;

      await this.paymentAccountLedgerService.syncDepositLink(
        tx,
        deposit,
        newPaymentAccountId,
        ledgerReference,
        admin.id,
      );

      const updatedDeposit = await tx.deposit.update({
        where: { id: depositId },
        data: {
          ...(dto.receivingAccountType != null && {
            receivingAccountType: dto.receivingAccountType,
          }),
          ...(dto.receivingAccountSubname !== undefined && {
            receivingAccountSubname: dto.receivingAccountSubname,
          }),
          ...(dto.receivingAccountName != null && {
            receivingAccountName: dto.receivingAccountName,
          }),
          ...(dto.receivingAccountNumber != null && {
            receivingAccountNumber: dto.receivingAccountNumber,
          }),
          ...(dto.receivingTransactionCode !== undefined && {
            receivingTransactionCode: dto.receivingTransactionCode,
          }),
          ...(dto.receivingTransactionTime != null && {
            receivingTransactionTime: dto.receivingTransactionTime,
          }),
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              phone: true,
            },
          },
        },
      });

      return { deposit: updatedDeposit, oldPaymentAccountId, newPaymentAccountId };
    });
    const updated = result.deposit;

    // Both sides of a re-link can have their balance changed by
    // syncDepositLink's reversal-then-forward — notify each distinct
    // account that's actually involved (no-ops on the client side if
    // nothing was really touched, since the reconciled fetch will show the
    // same numbers either way).
    for (const paymentAccountId of new Set(
      [result.oldPaymentAccountId, result.newPaymentAccountId].filter(
        (id): id is string => id !== null,
      ),
    )) {
      this.realtimeGateway.notifyAdminsPaymentAccountUpdated({ paymentAccountId });
    }

    this.realtimeGateway.notifyUserDepositUpdated(updated.userId, {
      id: updated.id,
      status: updated.status,
      amount: decimalToNumber(updated.amount),
      paymentMethod: updated.paymentMethod,
      reference: updated.reference,
      approvedAt: updated.approvedAt,
      receivingAccountType: updated.receivingAccountType,
      receivingAccountSubname: updated.receivingAccountSubname,
      receivingAccountName: updated.receivingAccountName,
      receivingAccountNumber: updated.receivingAccountNumber,
      receivingTransactionCode: updated.receivingTransactionCode,
      receivingTransactionTime: updated.receivingTransactionTime,
    });

    return { ...this.toResponse(updated), user: updated.user };
  }

  private toResponse(deposit: {
    id: string;
    userId: string;
    amount: unknown;
    paymentMethod: string;
    accountName?: string | null;
    reference: string;
    status: DepositStatus;
    rejectionReason: string | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    receivingAccountType?: string | null;
    receivingAccountSubname?: string | null;
    receivingAccountName?: string | null;
    receivingAccountNumber?: string | null;
    receivingTransactionCode?: string | null;
    receivingTransactionTime?: string | null;
    receivingPaymentAccountId?: string | null;
    walletBalanceBefore?: unknown;
    walletBalanceAfter?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      ...deposit,
      amount: decimalToNumber(deposit.amount as never),
      // Numbers-or-null, unlike amount: null means "never captured" (legacy
      // rows, PENDING/REJECTED) and must stay distinguishable from a real 0.
      walletBalanceBefore:
        deposit.walletBalanceBefore == null
          ? null
          : decimalToNumber(deposit.walletBalanceBefore as never),
      walletBalanceAfter:
        deposit.walletBalanceAfter == null
          ? null
          : decimalToNumber(deposit.walletBalanceAfter as never),
    };
  }
}
