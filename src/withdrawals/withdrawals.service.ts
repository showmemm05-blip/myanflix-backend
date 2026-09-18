import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { withdrawalSnapshot } from '../audit/audit-snapshots';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { VerificationFilter } from '../common/dto/verification-filter';
import type { VerificationReviewDto } from '../deposits/dto/verification-review.dto';
import {
  findWithdrawalCodeTwins,
  flagWithdrawalCodeTwins,
  updateWithdrawalRisk,
  withdrawalVerificationPayload,
} from '../bank-events/withdrawal-risk';
import {
  PAYOUT_CODE_TWIN_REASONS,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  type RiskReason,
  normalizeReasons,
  reasonsEqual,
  replaceReasonClass,
  scoreVerification,
  withdrawalVerificationView,
} from '../bank-events/risk-rules';
import {
  BankMatchStatus,
  BankRiskLevel,
  NotificationType,
  Prisma,
  TransactionType,
  WithdrawalStatus,
} from '../generated/prisma/client';
import type { Withdrawal } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import type { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import type { UpdateTransferAccountDto } from './dto/update-transfer-account.dto';
import type { WithdrawalQueryDto } from './dto/withdrawal-query.dto';

/** The reasons a bank event puts on a withdrawal — what `unlink` strips. */
const BANK_EVENT_REASONS: readonly RiskReason[] = ['AMBIGUOUS_MATCH'];

const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/** The columns a user must never see about their own payout — see DepositsService. */
const USER_HIDDEN_WITHDRAWAL_KEYS = [
  'transferAmount',
  'transferTransactionAt',
  'transferScreenshotKey',
  'transferEventKey',
  'bankCheckedAt',
  'matchStatus',
  'riskLevel',
  'riskReasons',
] as const satisfies readonly (keyof Withdrawal)[];

function omitKeys<T extends object, K extends string>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

/** Audit-log label: a withdrawal has no reference, so amount plus whose it is. */
function withdrawalLabel(withdrawal: {
  amount: unknown;
  user?: { username: string } | null;
}): string {
  const amount = `${decimalToNumber(withdrawal.amount as never)} Ks`;
  return withdrawal.user ? `${amount} · @${withdrawal.user.username}` : amount;
}

/**
 * Only the "which of OUR accounts we sent it from" record — the fields
 * updateTransferAccount may change — so its audit row diffs exactly that.
 */
function transferAccountSnapshot(withdrawal: Partial<Withdrawal>) {
  const {
    transferAccountType,
    transferAccountSubname,
    transferAccountName,
    transferAccountNumber,
    transferTransactionCode,
    transferTransactionTime,
    transferPaymentAccountId,
  } = withdrawalSnapshot(withdrawal);
  return {
    transferAccountType,
    transferAccountSubname,
    transferAccountName,
    transferAccountNumber,
    transferTransactionCode,
    transferTransactionTime,
    transferPaymentAccountId,
  };
}

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly financeSettingsService: FinanceSettingsService,
    private readonly paymentAccountLedgerService: PaymentAccountLedgerService,
    private readonly audit: AuditService,
    private readonly minioService: MinioService,
  ) {}

  /** Admins-room realtime push for rows whose verification state changed — after commit only. */
  private async pushVerificationUpdates(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.withdrawal.findMany({
      where: { id: { in: [...ids] } },
    });
    for (const row of rows) {
      this.realtimeGateway.notifyAdminsWithdrawalVerificationUpdated(
        withdrawalVerificationPayload(row),
      );
    }
  }

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
        // Snapshot of what the user asked for on THIS request — deliberately
        // taken straight from the DTO with no profile lookup anywhere in this
        // method, so a payout always reflects the details submitted with it.
        bankName: dto.bankName ?? null,
      },
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true, displayName: true, phone: true, email: true },
    });

    this.realtimeGateway.notifyAdminsWithdrawalCreated({
      id: withdrawal.id,
      userId: withdrawal.userId,
      username: user.username,
      displayName: user.displayName,
      phone: user.phone,
      email: user.email,
      amount: decimalToNumber(withdrawal.amount),
      accountType: withdrawal.accountType,
      accountName: withdrawal.accountName,
      accountNumber: withdrawal.accountNumber,
      bankName: withdrawal.bankName,
      status: withdrawal.status,
      createdAt: withdrawal.createdAt,
    });

    return this.toResponse(withdrawal);
  }

  async findAllForUser(userId: string, query: WithdrawalQueryDto) {
    return this.findAll({ ...query, userId });
  }

  /**
   * Pending requests first — see the WithdrawalStatus enum doc comment in
   * schema.prisma for why `orderBy: 'asc'` alone achieves this. The five
   * verification tabs mirror DepositsService.findAllAdmin: `verified` /
   * `needs_review` are matchStatus filters on the full composite index; the
   * two open-payout tabs go through findOpenAdmin with a literal predicate.
   */
  async findAllAdmin(query: WithdrawalQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const verification: VerificationFilter = query.verification ?? 'all';
    const now = new Date();

    if (
      verification === 'awaiting_bank' ||
      verification === 'no_bank_transaction'
    ) {
      return this.findOpenAdmin(query, verification, page, limit, now);
    }

    const where: Prisma.WithdrawalWhereInput = {
      status: query.status,
      userId: query.userId,
      createdAt:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
      ...(verification === 'verified' && {
        matchStatus: BankMatchStatus.MATCHED,
      }),
      ...(verification === 'needs_review' && {
        matchStatus: {
          in: [BankMatchStatus.PENDING_REVIEW, BankMatchStatus.SUSPICIOUS],
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: ADMIN_USER_SELECT } },
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return {
      items: items.map((w) => ({
        ...this.toAdminResponse(w, now),
        user: w.user,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * "Awaiting bank" = the open payout set (APPROVED, never bank-checked, no
   * code keyed in by hand) approved inside the payout window; "no bank
   * transaction" = the same set approved longer ago than that. Both are
   * served by the partial withdrawals_open_payout_idx — bounded by the
   * open set, never by history. A non-APPROVED status filter can match
   * nothing here and short-circuits.
   */
  private async findOpenAdmin(
    query: WithdrawalQueryDto,
    verification: 'awaiting_bank' | 'no_bank_transaction',
    page: number,
    limit: number,
    now: Date,
  ) {
    if (query.status && query.status !== WithdrawalStatus.APPROVED) {
      return { items: [], total: 0, page, limit };
    }
    const cutoff = new Date(now.getTime() - WITHDRAWAL_PAYOUT_WINDOW_MS);
    const predicate = Prisma.sql`status = 'APPROVED'::"WithdrawalStatus"
      AND "bankCheckedAt" IS NULL
      AND "transferTransactionCode" IS NULL
      AND ${
        verification === 'awaiting_bank'
          ? Prisma.sql`"approvedAt" >= ${cutoff}`
          : Prisma.sql`"approvedAt" < ${cutoff}`
      }
      ${query.dateFrom ? Prisma.sql`AND "createdAt" >= ${new Date(query.dateFrom)}` : Prisma.empty}
      ${query.dateTo ? Prisma.sql`AND "createdAt" <= ${new Date(query.dateTo)}` : Prisma.empty}
      ${query.userId ? Prisma.sql`AND "userId" = ${query.userId}` : Prisma.empty}`;

    const [idRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM withdrawals WHERE ${predicate}
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ),
      this.prisma.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT count(*)::int AS n FROM withdrawals WHERE ${predicate}`,
      ),
    ]);
    const ids = idRows.map((row) => row.id);
    const total = Number(countRows[0]?.n ?? 0);
    if (ids.length === 0) return { items: [], total, page, limit };

    const rows = await this.prisma.withdrawal.findMany({
      where: { id: { in: ids } },
      include: { user: { select: ADMIN_USER_SELECT } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((w) => ({ ...this.toAdminResponse(w, now), user: w.user }));
    return { items, total, page, limit };
  }

  private async findAll(query: WithdrawalQueryDto & { userId: string }) {
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
        include: { user: { select: ADMIN_USER_SELECT } },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: withdrawal.userId },
      });

      // Inside the transaction, so the audit row commits with the approval
      // (and rolls back with it).
      await this.audit.record({
        action: 'withdrawal.approve',
        actor: admin,
        target: {
          type: 'withdrawal',
          id: withdrawalId,
          label: withdrawalLabel(updated),
        },
        before: withdrawalSnapshot(withdrawal),
        after: withdrawalSnapshot(updated),
        tx,
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

    // Staff pay out right after approving, so the "You sent …" notification
    // is seconds away: nudge the phone-monitor now. No account is known yet
    // — the matcher keys on amount + approvedAt, account only when recorded.
    this.realtimeGateway.notifyBankMonitorsNudge({
      kind: 'withdrawal',
      paymentAccountId: null,
    });

    return {
      ...this.toAdminResponse(result.withdrawal),
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
        include: { user: { select: ADMIN_USER_SELECT } },
      });
      await this.audit.record({
        action: 'withdrawal.reject',
        actor: admin,
        target: {
          type: 'withdrawal',
          id: withdrawalId,
          label: withdrawalLabel(updated),
        },
        before: withdrawalSnapshot(withdrawal),
        after: withdrawalSnapshot(updated),
        metadata: { reason: dto.reason },
        tx,
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
      ...this.toAdminResponse(result.withdrawal),
      user: result.withdrawal.user,
    };
  }

  /**
   * Records OUR account — the one we sent the money FROM — after approval.
   * Entirely separate from accountType/accountName/accountNumber (the
   * user's own destination account), which this never touches, along with
   * status/approvedAt/wallet ledger.
   *
   * Wrapped in its own $transaction (unlike the plain update() this used to
   * be) so the payment-account ledger sync (which may post a reversal + a
   * fresh WITHDRAWAL_OUT when re-linking to a different account) and the
   * Withdrawal row update commit atomically.
   */
  async updateTransferAccount(
    withdrawalId: string,
    dto: UpdateTransferAccountDto,
    admin: AuthenticatedUser,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (withdrawal.status !== WithdrawalStatus.APPROVED) {
        throw new BadRequestException(
          'The transfer account can only be edited for an approved withdrawal',
        );
      }

      const oldPaymentAccountId = withdrawal.transferPaymentAccountId;
      const newPaymentAccountId = dto.paymentAccountId ?? null;

      await this.paymentAccountLedgerService.syncWithdrawalLink(
        tx,
        withdrawal,
        newPaymentAccountId,
        dto.transferTransactionCode,
        admin.id,
      );

      const updatedWithdrawal = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          transferAccountType: dto.transferAccountType,
          // Explicitly nulled (not left undefined) when absent, so a manual
          // edit that no longer matches the originally-picked catalog entry
          // can't leave a stale subname behind from a previous save.
          transferAccountSubname: dto.transferAccountSubname ?? null,
          transferAccountName: dto.transferAccountName,
          transferAccountNumber: dto.transferAccountNumber,
          transferTransactionCode: dto.transferTransactionCode,
          transferTransactionTime: dto.transferTransactionTime,
        },
        include: { user: { select: ADMIN_USER_SELECT } },
      });

      // `updatedWithdrawal` is read after syncWithdrawalLink's claim, so its
      // transferPaymentAccountId already reflects the re-link.
      await this.audit.record({
        action: 'withdrawal.transfer_account_update',
        actor: admin,
        target: {
          type: 'withdrawal',
          id: withdrawalId,
          label: withdrawalLabel(updatedWithdrawal),
        },
        before: transferAccountSnapshot(withdrawal),
        after: transferAccountSnapshot(updatedWithdrawal),
        metadata: { oldPaymentAccountId, newPaymentAccountId },
        tx,
      });

      // Q8 — the double-payout gap, flagged whichever way the code arrives:
      // this row and every other one carrying the same code get
      // DUPLICATE_PAYOUT_CODE (or lose it, if the code just changed to one
      // nobody else has). Flag, never block — the money decision is the
      // admin's.
      const twins = await findWithdrawalCodeTwins(
        tx,
        dto.transferTransactionCode,
        withdrawalId,
      );
      const metadata = {
        trigger: 'transfer_account_update',
        anchorWithdrawalId: withdrawalId,
      };
      const ownReasons = replaceReasonClass(
        updatedWithdrawal.riskReasons,
        PAYOUT_CODE_TWIN_REASONS,
        twins.length > 0 ? ['DUPLICATE_PAYOUT_CODE'] : [],
      );
      const changedIds: string[] = [];
      if (!reasonsEqual(ownReasons, updatedWithdrawal.riskReasons)) {
        await updateWithdrawalRisk(
          tx,
          this.audit,
          updatedWithdrawal,
          scoreVerification(
            ownReasons,
            updatedWithdrawal.bankCheckedAt !== null,
          ),
          metadata,
        );
        changedIds.push(withdrawalId);
      }
      const changedTwins = await flagWithdrawalCodeTwins(
        tx,
        this.audit,
        twins,
        metadata,
      );
      changedIds.push(...changedTwins.map((twin) => twin.id));

      return {
        withdrawal: updatedWithdrawal,
        oldPaymentAccountId,
        newPaymentAccountId,
        changedIds,
      };
    });
    const updated = result.withdrawal;
    await this.pushVerificationUpdates(result.changedIds);

    // Both sides of a re-link can have their balance changed by
    // syncWithdrawalLink's reversal-then-forward — notify each distinct
    // account actually involved.
    for (const paymentAccountId of new Set(
      [result.oldPaymentAccountId, result.newPaymentAccountId].filter(
        (id): id is string => id !== null,
      ),
    )) {
      this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
        paymentAccountId,
      });
    }

    this.realtimeGateway.notifyUserWithdrawalUpdated(updated.userId, {
      id: updated.id,
      status: updated.status,
      amount: decimalToNumber(updated.amount),
      accountType: updated.accountType,
      accountName: updated.accountName,
      accountNumber: updated.accountNumber,
      bankName: updated.bankName,
      approvedAt: updated.approvedAt,
      transferAccountType: updated.transferAccountType,
      transferAccountSubname: updated.transferAccountSubname,
      transferAccountName: updated.transferAccountName,
      transferAccountNumber: updated.transferAccountNumber,
      transferTransactionCode: updated.transferTransactionCode,
      transferTransactionTime: updated.transferTransactionTime,
    });

    return { ...this.toAdminResponse(updated), user: updated.user };
  }

  /**
   * A staff decision on a flagged withdrawal — the mirror of
   * DepositsService.reviewVerification (same three verbs, same audit
   * shape). `unlink` wipes the bank-written transfer* values and the
   * screenshot so the row re-enters the open payout set; the code an admin
   * typed by hand is never touched by it (that row is not in the open set
   * and was never matched).
   */
  async reviewVerification(
    withdrawalId: string,
    dto: VerificationReviewDto,
    admin: AuthenticatedUser,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');

      let data: Prisma.WithdrawalUpdateInput;
      if (dto.action === 'clear') {
        data = {
          matchStatus:
            withdrawal.bankCheckedAt !== null
              ? BankMatchStatus.MATCHED
              : BankMatchStatus.UNVERIFIED,
          riskLevel: null,
          riskReasons: [],
        };
      } else if (dto.action === 'confirm_suspicious') {
        data = {
          matchStatus: BankMatchStatus.SUSPICIOUS,
          riskLevel: BankRiskLevel.HIGH,
        };
      } else {
        if (withdrawal.bankCheckedAt === null) {
          throw new BadRequestException(
            'This withdrawal has no bank event to unlink',
          );
        }
        const kept = normalizeReasons(withdrawal.riskReasons).filter(
          (reason) => !BANK_EVENT_REASONS.includes(reason),
        );
        data = {
          transferAmount: null,
          transferTransactionCode: null,
          transferTransactionTime: null,
          transferTransactionAt: null,
          transferEventKey: null,
          transferScreenshotKey: null,
          bankCheckedAt: null,
          ...scoreVerification(kept, false),
        };
      }

      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data,
        include: { user: { select: ADMIN_USER_SELECT } },
      });

      await this.audit.record({
        action: 'withdrawal.verification_review',
        actor: admin,
        target: {
          type: 'withdrawal',
          id: withdrawalId,
          label: withdrawalLabel(updated),
        },
        before: withdrawalSnapshot(withdrawal),
        after: withdrawalSnapshot(updated),
        metadata: { action: dto.action, note: dto.note ?? null },
        tx,
      });

      return {
        withdrawal: updated,
        screenshotToDelete:
          dto.action === 'unlink' ? withdrawal.transferScreenshotKey : null,
      };
    });

    if (result.screenshotToDelete) {
      await this.minioService
        .deleteObject(result.screenshotToDelete)
        .catch((error: Error) =>
          this.logger.warn(
            `Could not delete bank screenshot ${result.screenshotToDelete}: ${error.message}`,
          ),
        );
    }
    this.realtimeGateway.notifyAdminsWithdrawalVerificationUpdated(
      withdrawalVerificationPayload(result.withdrawal),
    );

    return {
      ...this.toAdminResponse(result.withdrawal),
      user: result.withdrawal.user,
    };
  }

  /** GET /withdrawals/:id/bank-screenshot — see DepositsService.getBankScreenshot. */
  async getBankScreenshot(withdrawalId: string): Promise<StreamableFile> {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      select: { transferScreenshotKey: true },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    if (!withdrawal.transferScreenshotKey) {
      throw new NotFoundException('This withdrawal has no bank screenshot');
    }
    const object = await this.minioService.getObjectStream(
      withdrawal.transferScreenshotKey,
    );
    if (!object) {
      throw new NotFoundException('This withdrawal has no bank screenshot');
    }
    return new StreamableFile(object.stream, {
      type: 'image/png',
      disposition: `inline; filename="bank-${withdrawalId}.png"`,
      ...(object.contentLength !== null && { length: object.contentLength }),
    });
  }

  /**
   * The USER-SAFE shape (/withdrawals, /withdrawals/me). Every
   * bank-verification column is stripped — a user never sees a fraud score.
   */
  private toResponse(withdrawal: {
    id: string;
    userId: string;
    amount: unknown;
    accountType: string;
    accountName: string;
    accountNumber: string;
    bankName?: string | null;
    status: WithdrawalStatus;
    rejectionReason: string | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    transferAccountType?: string | null;
    transferAccountSubname?: string | null;
    transferAccountName?: string | null;
    transferAccountNumber?: string | null;
    transferTransactionCode?: string | null;
    transferTransactionTime?: string | null;
    transferPaymentAccountId?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const visible = omitKeys(withdrawal, USER_HIDDEN_WITHDRAWAL_KEYS);
    return {
      ...visible,
      amount: decimalToNumber(withdrawal.amount as never),
    };
  }

  /** The STAFF shape — mirrors DepositsService.toAdminResponse with transfer* naming. */
  private toAdminResponse(
    withdrawal: Parameters<WithdrawalsService['toResponse']>[0] & {
      transferAmount?: unknown;
      transferTransactionAt?: Date | null;
      transferScreenshotKey?: string | null;
      bankCheckedAt?: Date | null;
      matchStatus?: BankMatchStatus;
      riskLevel?: BankRiskLevel | null;
      riskReasons?: string[];
    },
    now: Date = new Date(),
  ) {
    const view = withdrawalVerificationView(
      {
        status: withdrawal.status,
        bankCheckedAt: withdrawal.bankCheckedAt ?? null,
        transferTransactionCode: withdrawal.transferTransactionCode ?? null,
        approvedAt: withdrawal.approvedAt,
        matchStatus: withdrawal.matchStatus ?? BankMatchStatus.UNVERIFIED,
        riskLevel: withdrawal.riskLevel ?? null,
        riskReasons: withdrawal.riskReasons ?? [],
      },
      now,
    );
    return {
      ...this.toResponse(withdrawal),
      transferAmount:
        withdrawal.transferAmount == null
          ? null
          : decimalToNumber(withdrawal.transferAmount as never),
      transferTransactionAt: withdrawal.transferTransactionAt ?? null,
      bankCheckedAt: withdrawal.bankCheckedAt ?? null,
      matchStatus: view.matchStatus,
      riskLevel: view.riskLevel,
      riskReasons: view.riskReasons,
      hasBankScreenshot: Boolean(withdrawal.transferScreenshotKey),
    };
  }
}
