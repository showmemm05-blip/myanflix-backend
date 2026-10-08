import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { lockAccountStatus } from '../users/account-status-lock';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { withdrawalSnapshot } from '../audit/audit-snapshots';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { WithdrawalCodeService } from '../withdrawal-code/withdrawal-code.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import {
  VERIFICATION_FILTERS,
  type VerificationFilter,
} from '../common/dto/verification-filter';
import {
  type AdminMoneyStats,
  toAdminMoneyStats,
} from '../common/utils/admin-money-stats';
import {
  withdrawalSearchWhere,
  withdrawalVerificationWhere,
} from './withdrawal-admin-query';
import type { VerificationReviewDto } from '../deposits/dto/verification-review.dto';
import { BANK_TRANSACTION_LINK_INCLUDE } from '../bank-events/deposit-risk';
import {
  findWithdrawalCodeTwins,
  flagWithdrawalCodeTwins,
  pushWithdrawalVerificationUpdates,
  updateWithdrawalRisk,
  withdrawalVerificationPayload,
} from '../bank-events/withdrawal-risk';
import {
  matchTypedCode,
  rematchParkedSentTransaction,
  type TypedCodeCheckOutcome,
} from '../bank-events/withdrawal-matcher';
import {
  findParkedSentForApproval,
  pushBankTransactionChange,
  unlinkByWithdrawal,
} from '../bank-transactions/bank-transaction-store';
import {
  PAYOUT_CODE_TWIN_REASONS,
  WITHDRAWAL_PAYOUT_WINDOW_MS,
  type RiskReason,
  codesEqual,
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
  TransactionStatus,
  TransactionType,
  UserStatus,
  WithdrawalStatus,
} from '../generated/prisma/client';
import type { Withdrawal } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import type { RejectWithdrawalDto } from './dto/reject-withdrawal.dto';
import type { UpdateTransferAccountDto } from './dto/update-transfer-account.dto';
import type { WithdrawalQueryDto } from './dto/withdrawal-query.dto';

/**
 * M-11/M-14: a staff member never settles their OWN payout. Shown verbatim
 * by the admin app's error toast.
 */
export const SELF_APPROVE_WITHDRAWAL_MESSAGE =
  'You cannot approve a withdrawal from your own account';
export const SELF_REJECT_WITHDRAWAL_MESSAGE =
  'You cannot reject a withdrawal from your own account';

/**
 * The reasons that describe a withdrawal's relation to a bank record — what
 * `unlink` strips, since unlink also wipes the code they were computed
 * from: AMBIGUOUS_MATCH (a record fitted more than one payout),
 * CODE_MISMATCH (the typed code differs from the linked record's) and
 * AMOUNT_MISMATCH (the typed code names a record of another amount).
 */
const BANK_EVENT_REASONS: readonly RiskReason[] = [
  'AMBIGUOUS_MATCH',
  'CODE_MISMATCH',
  'AMOUNT_MISMATCH',
];

/** W4 — the one reason the typed-code-vs-linked-record check owns. */
const TYPED_CODE_REASONS: readonly RiskReason[] = ['CODE_MISMATCH'];

const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/**
 * The columns a user must never see about their own payout — see
 * DepositsService. holdTransactionId is internal bookkeeping (the user sees
 * the hold as the PENDING row in their own wallet history).
 */
const USER_HIDDEN_WITHDRAWAL_KEYS = [
  'transferAmount',
  'transferTransactionAt',
  'transferScreenshotKey',
  'transferEventKey',
  'bankCheckedAt',
  'matchStatus',
  'riskLevel',
  'riskReasons',
  'holdTransactionId',
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
    private readonly storageService: StorageService,
    private readonly withdrawalCodeService: WithdrawalCodeService,
  ) {}

  /** Admins-room realtime push for rows whose verification state changed — after commit only. */
  private async pushVerificationUpdates(ids: readonly string[]): Promise<void> {
    await pushWithdrawalVerificationUpdates(
      this.prisma,
      this.realtimeGateway,
      ids,
    );
  }

  /** One row in the admin shape, read after a look-back changed it — null (logged) if the read fails. */
  private async rereadAdminRow(withdrawalId: string) {
    try {
      return await this.prisma.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
      });
    } catch (error) {
      this.logger.error(
        `re-read of withdrawal ${withdrawalId} after the bank look-back failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * W2 — after an approval committed: re-run the parked "sent" records whose
   * bank time is within CLOCK_SKEW_MS before approvedAt (Q-BT5), oldest
   * first, each through applySentEvent in its own transaction, then push
   * the admin updates exactly as ingestion does. Returns whether THIS
   * withdrawal's verification changed. Never throws: every failure is
   * logged (ids and counts only) and the approval stands.
   */
  private async recheckParkedAfterApproval(
    withdrawal: Pick<Withdrawal, 'id' | 'status' | 'amount' | 'approvedAt'>,
    admin: AuthenticatedUser,
  ): Promise<boolean> {
    if (
      withdrawal.status !== WithdrawalStatus.APPROVED ||
      withdrawal.approvedAt === null
    ) {
      return false;
    }
    let parked: { id: string }[];
    try {
      parked = await findParkedSentForApproval(
        this.prisma,
        withdrawal.amount,
        withdrawal.approvedAt,
      );
    } catch (error) {
      this.logger.error(
        `approve ${withdrawal.id}: parked-record look-up failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (parked.length === 0) return false;

    const counts: Record<string, number> = {};
    let touchedSelf = false;
    for (const record of parked) {
      try {
        const outcome = await this.prisma.$transaction((tx) =>
          rematchParkedSentTransaction(tx, this.audit, record.id, new Date(), {
            trigger: 'withdrawal_approve',
            actor: admin,
          }),
        );
        const key = outcome?.result.outcome ?? 'skipped';
        counts[key] = (counts[key] ?? 0) + 1;
        if (!outcome) continue;
        if (outcome.touchedWithdrawalIds.includes(withdrawal.id)) {
          touchedSelf = true;
        }
        await this.pushVerificationUpdates(outcome.touchedWithdrawalIds);
        if (outcome.transactionChanged) {
          await pushBankTransactionChange(
            this.prisma,
            this.realtimeGateway,
            record.id,
            'updated',
          );
        }
      } catch (error) {
        counts.error = (counts.error ?? 0) + 1;
        this.logger.error(
          `approve ${withdrawal.id}: re-run of parked record ${record.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // Counts and outcomes only — never amounts or codes in the log.
    this.logger.log(
      `approve ${withdrawal.id}: ${parked.length} parked sent record(s) re-run — ${Object.entries(
        counts,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
    return touchedSelf;
  }

  /**
   * W1 — after a transfer-account save committed: the typed code looks for
   * the parked "sent" records carrying it (matchTypedCode), in its own
   * transaction. null when it failed — logged, and the save stands.
   */
  private async recheckTypedCode(
    withdrawalId: string,
    admin: AuthenticatedUser,
  ): Promise<TypedCodeCheckOutcome | null> {
    try {
      const outcome = await this.prisma.$transaction((tx) =>
        matchTypedCode(tx, this.audit, withdrawalId, new Date(), {
          trigger: 'transfer_account_update',
          actor: admin,
        }),
      );
      if (outcome.outcome === 'ambiguous') {
        // Counts only — never the code or an amount.
        this.logger.log(
          `transfer account ${withdrawalId}: ${outcome.candidates} parked sent records share the typed code — none claimed, left for staff`,
        );
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        `transfer account ${withdrawalId}: typed-code look-back failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * C-4 — the money is HELD from the moment the request exists. One
   * transaction debits the wallet with the conditional `balance >= amount`
   * update (debitWithinTransaction), writes the hold's PENDING WITHDRAWAL
   * ledger row and inserts the request pointing at it. Two full-balance
   * requests, or a request racing a purchase, can therefore never both
   * succeed, and money staff may already be paying out is no longer
   * spendable. The plain balance read before it is only the friendly fast
   * path for the common "not enough money" case; the conditional debit is
   * the guarantee (a lost race answers 400 'Insufficient wallet balance'
   * and writes nothing). Approve finalises the hold, reject gives it back.
   * Self-service, so no audit row — the ledger row is the record.
   *
   * Withdrawal code (2026-10-05): after the amount checks (so a bad amount
   * never uses up a try) and BEFORE the hold transaction, the account's
   * 6-digit code must be right — WithdrawalCodeService throws
   * WITHDRAWAL_CODE_NOT_SET (409), _REQUIRED / _INVALID_FORMAT / _WRONG
   * (400, with triesLeft) or _LOCKED (423, with lockedUntil), and then
   * nothing is held, written or announced. The code is never stored here.
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

    await this.withdrawalCodeService.assertValidForWithdrawal(
      userId,
      dto.withdrawalCode,
    );

    const { withdrawal, balance } = await this.prisma.$transaction(
      async (tx) => {
        // H-16: an account closed while this request was in flight takes no
        // new withdrawal (see lockAccountStatus) — nor does one suspended or
        // banned meanwhile, the same refusal JwtStrategy gives. First, so
        // the lock order matches DELETE /users/me: users, then the wallet.
        if ((await lockAccountStatus(tx, userId)) !== UserStatus.ACTIVE) {
          throw new UnauthorizedException('This account is no longer active');
        }
        const held = await this.walletService.debitWithinTransaction(
          tx,
          userId,
          dto.amount,
        );
        const hold = await tx.transaction.create({
          data: {
            userId,
            type: TransactionType.WITHDRAWAL,
            amount: dto.amount,
            status: TransactionStatus.PENDING,
          },
        });
        const created = await tx.withdrawal.create({
          data: {
            userId,
            amount: dto.amount,
            accountType: dto.accountType,
            accountName: dto.accountName,
            accountNumber: dto.accountNumber,
            // Snapshot of what the user asked for on THIS request —
            // deliberately taken straight from the DTO with no profile lookup
            // anywhere in this method, so a payout always reflects the details
            // submitted with it.
            bankName: dto.bankName ?? null,
            holdTransactionId: hold.id,
          },
        });
        return { withdrawal: created, balance: held.balance };
      },
    );

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
    this.realtimeGateway.notifyUserBalanceUpdated(
      userId,
      decimalToNumber(balance),
    );

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
   * two open-payout tabs go through findOpenAdmin with a literal predicate
   * — unless a search is set (H-24): the search already narrows the rows,
   * so a searched open tab takes the ordinary path with the same predicate
   * in Prisma form.
   */
  async findAllAdmin(query: WithdrawalQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const verification: VerificationFilter = query.verification ?? 'all';
    const now = new Date();
    const search = withdrawalSearchWhere(query.search);
    const openTab =
      verification === 'awaiting_bank' ||
      verification === 'no_bank_transaction';

    if (openTab && !search) {
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
      ...(search && {
        AND: [
          ...(openTab ? [withdrawalVerificationWhere(verification, now)] : []),
          search,
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
   * GET /withdrawals/stats (H-24) — the admin queue's stat cards and tab
   * counts, computed by the database over every row matching the same
   * filters as the list (date range, user, search), never summed from one
   * loaded page. Faceted like the tabs themselves: the per-status totals
   * follow the selected verification tab but not the status filter, and
   * the five verification counts follow the status filter but not the
   * selected tab. page/limit are accepted and ignored.
   */
  async getAdminStats(query: WithdrawalQueryDto): Promise<AdminMoneyStats> {
    const now = new Date();
    const base: Prisma.WithdrawalWhereInput[] = [
      { userId: query.userId },
      {
        createdAt:
          query.dateFrom || query.dateTo
            ? {
                gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
                lte: query.dateTo ? new Date(query.dateTo) : undefined,
              }
            : undefined,
      },
      withdrawalSearchWhere(query.search) ?? {},
    ];

    const [grouped, tabCounts] = await Promise.all([
      this.prisma.withdrawal.groupBy({
        by: ['status'],
        where: {
          AND: [
            ...base,
            withdrawalVerificationWhere(query.verification ?? 'all', now),
          ],
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      Promise.all(
        VERIFICATION_FILTERS.map((tab) =>
          this.prisma.withdrawal.count({
            where: {
              AND: [
                ...base,
                { status: query.status },
                withdrawalVerificationWhere(tab, now),
              ],
            },
          }),
        ),
      ),
    ]);

    return toAdminMoneyStats(
      grouped,
      Object.fromEntries(
        VERIFICATION_FILTERS.map((tab, i) => [tab, tabCounts[i]]),
      ) as Record<VerificationFilter, number>,
    );
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
      include: {
        user: { select: ADMIN_USER_SELECT },
        ...BANK_TRANSACTION_LINK_INCLUDE,
      },
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
   * Atomically claims the withdrawal (only succeeds if it's still PENDING)
   * and records the ledger + notification entries — all inside one
   * transaction. A held request (C-4, holdTransactionId set) already had
   * its money taken at request time: approve only turns the hold's ledger
   * row COMPLETED — no second debit, no new ledger row, so it can never
   * fail for "insufficient balance" after staff have paid. A request from
   * before holds existed is approved exactly as it always was:
   * `debitWithinTransaction` re-checks the balance atomically and throws if
   * it's no longer sufficient, which rolls back the whole transaction —
   * including the PENDING->APPROVED claim — leaving the withdrawal PENDING
   * for the admin to retry or reject. A race between two approve() calls
   * (or an approve racing a reject) can only ever settle the money once,
   * for the same reason deposits' approve() can only ever credit once.
   */
  async approve(withdrawalId: string, admin: AuthenticatedUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      });
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      // M-11/M-14: the approver is never the payee.
      if (withdrawal.userId === admin.id) {
        throw new ForbiddenException(SELF_APPROVE_WITHDRAWAL_MESSAGE);
      }

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

      if (withdrawal.holdTransactionId) {
        await tx.transaction.update({
          where: { id: withdrawal.holdTransactionId },
          data: { status: TransactionStatus.COMPLETED },
        });
      } else {
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
      }

      const notification = await tx.notification.create({
        data: {
          userId: withdrawal.userId,
          type: NotificationType.WITHDRAWAL_APPROVED,
          title: 'Withdrawal approved',
          message: withdrawal.holdTransactionId
            ? `Your withdrawal of ${withdrawal.amount.toString()} Ks has been approved.`
            : `Your withdrawal of ${withdrawal.amount.toString()} Ks has been approved and deducted from your balance.`,
          payload: {
            withdrawalId: withdrawal.id,
            amount: withdrawal.amount.toNumber(),
          },
        },
      });

      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
      change: 'status',
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

    // The match must not depend on the ORDER of events. Staff sometimes pay
    // first and press approve a minute later (27 Sep: sent 01:37:01 by the
    // bank's clock, posted 01:37:27, approved 01:38:13), so the phone's
    // "You sent …" record found nothing approved and was parked UNMATCHED.
    // Now that the approval has committed, the parked records whose bank
    // time is within CLOCK_SKEW_MS BEFORE approvedAt — exactly the records
    // whose ingestion window (approvedAt ≤ bank time + CLOCK_SKEW_MS)
    // contains this approval — are re-run through applySentEvent, the same
    // function the phone's Resend runs, so the existing rules decide
    // (1 candidate → claim, ≥ 2 → AMBIGUOUS). It is the 5-minute clock rule
    // ingestion already accepts, applied from the other side: no new
    // guess. Own transaction per record, errors logged, the approval
    // stands; admin realtime only — the user never sees the bank check.
    // No phone-monitor nudge: the record is already stored.
    const rematched = await this.recheckParkedAfterApproval(
      result.withdrawal,
      admin,
    );
    const final =
      (rematched && (await this.rereadAdminRow(withdrawalId))) ||
      result.withdrawal;

    return {
      ...this.toAdminResponse(final),
      user: final.user,
    };
  }

  /**
   * Same atomic claim pattern as approve(). A held request (C-4) gets its
   * money back in the same transaction, AFTER the claim so only the call
   * that flipped PENDING -> REJECTED refunds: the wallet is credited, the
   * hold's ledger row turns FAILED and a REFUND row records the credit (so
   * every balance movement keeps exactly one ledger row). A request from
   * before holds existed never had money taken, so it moves none.
   */
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
      // M-11/M-14: whoever rejects is never the account it belongs to.
      if (withdrawal.userId === admin.id) {
        throw new ForbiddenException(SELF_REJECT_WITHDRAWAL_MESSAGE);
      }

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

      let refund: { transactionId: string; balance: Prisma.Decimal } | null =
        null;
      if (withdrawal.holdTransactionId) {
        const credited = await this.walletService.creditWithinTransaction(
          tx,
          withdrawal.userId,
          withdrawal.amount.toNumber(),
        );
        await tx.transaction.update({
          where: { id: withdrawal.holdTransactionId },
          data: { status: TransactionStatus.FAILED },
        });
        const refundRow = await tx.transaction.create({
          data: {
            userId: withdrawal.userId,
            type: TransactionType.REFUND,
            amount: withdrawal.amount,
            status: TransactionStatus.COMPLETED,
          },
        });
        refund = { transactionId: refundRow.id, balance: credited.balance };
      }

      const notification = await tx.notification.create({
        data: {
          userId: withdrawal.userId,
          type: NotificationType.WITHDRAWAL_REJECTED,
          title: 'Withdrawal rejected',
          message: refund
            ? `Your withdrawal of ${withdrawal.amount.toString()} Ks was rejected and the amount was returned to your wallet: ${dto.reason}`
            : `Your withdrawal of ${withdrawal.amount.toString()} Ks was rejected: ${dto.reason}`,
          payload: { withdrawalId: withdrawal.id, reason: dto.reason },
        },
      });

      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
        metadata: refund
          ? { reason: dto.reason, refundTransactionId: refund.transactionId }
          : { reason: dto.reason },
        tx,
      });

      return { withdrawal: updated, notification, refund };
    });

    this.realtimeGateway.notifyUserWithdrawalUpdated(result.withdrawal.userId, {
      id: result.withdrawal.id,
      change: 'status',
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
    if (result.refund) {
      this.realtimeGateway.notifyUserBalanceUpdated(
        result.withdrawal.userId,
        decimalToNumber(result.refund.balance),
      );
    }

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
   *
   * The typed code is also bank evidence: on a row the bank already
   * confirmed it is compared with the linked record (W4, CODE_MISMATCH, in
   * the same transaction — a flag, never a block), and on a row not yet
   * confirmed it looks back at the parked "sent" records AFTER the commit
   * (W1, matchTypedCode). Neither ever touches transferPaymentAccountId or
   * the ledger; that stays the admin's pick above.
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
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
      let ownReasons = replaceReasonClass(
        updatedWithdrawal.riskReasons,
        PAYOUT_CODE_TWIN_REASONS,
        twins.length > 0 ? ['DUPLICATE_PAYOUT_CODE'] : [],
      );
      // W4 — on a row the bank already confirmed, the code staff typed is
      // compared with the linked record's last 6 (ignoring case):
      // different → CODE_MISMATCH, equal → it goes. Flag, never block —
      // what staff typed is saved either way. Not bank-checked, or checked
      // before bank_transactions existed (no linked record): nothing to
      // compare, the class is left alone.
      const linked =
        updatedWithdrawal.bankCheckedAt !== null
          ? await tx.bankTransaction.findUnique({
              where: { linkedWithdrawalId: withdrawalId },
              select: { id: true, txCodeLast6: true },
            })
          : null;
      if (linked) {
        ownReasons = replaceReasonClass(
          ownReasons,
          TYPED_CODE_REASONS,
          codesEqual(dto.transferTransactionCode, linked.txCodeLast6)
            ? []
            : ['CODE_MISMATCH'],
        );
      }
      const changedIds: string[] = [];
      let saved = updatedWithdrawal;
      if (!reasonsEqual(ownReasons, updatedWithdrawal.riskReasons)) {
        const score = scoreVerification(
          ownReasons,
          updatedWithdrawal.bankCheckedAt !== null,
        );
        await updateWithdrawalRisk(
          tx,
          this.audit,
          updatedWithdrawal,
          score,
          linked ? { ...metadata, bankTransactionId: linked.id } : metadata,
        );
        saved = { ...updatedWithdrawal, ...score };
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
        withdrawal: saved,
        oldPaymentAccountId,
        newPaymentAccountId,
        changedIds,
      };
    });

    // W1 — only now that the save committed: the typed code looks back at
    // the parked "sent" records (see matchTypedCode). Its own transaction;
    // a failure is logged and never undoes or fails the save. An unchanged
    // re-save runs it again — how a row stuck before this rule gets
    // matched. The response and the pushes below show its result.
    const codeCheck = await this.recheckTypedCode(withdrawalId, admin);
    const updated =
      (codeCheck?.touchedWithdrawalIds.includes(withdrawalId) &&
        (await this.rereadAdminRow(withdrawalId))) ||
      result.withdrawal;
    await this.pushVerificationUpdates([
      ...new Set([
        ...result.changedIds,
        ...(codeCheck?.touchedWithdrawalIds ?? []),
      ]),
    ]);
    if (codeCheck?.changedTransactionId) {
      const transactionId = codeCheck.changedTransactionId;
      await pushBankTransactionChange(
        this.prisma,
        this.realtimeGateway,
        transactionId,
        'updated',
      ).catch((error: unknown) =>
        this.logger.error(
          `transfer account ${withdrawalId}: push of bank record ${transactionId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }

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

    // Admins only. The account WE paid out from is bookkeeping the user
    // never sees, and the user's client toasts "Withdrawal approved" on any
    // withdrawal.updated with status APPROVED — so this must never enter
    // the user's room. Other admin sessions still need it to stay in sync.
    this.realtimeGateway.notifyAdminsWithdrawalUpdated({
      id: updated.id,
      change: 'transfer_account',
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
   * shape). `unlink` wipes the transfer* values of the bank match — the
   * payout code included, even when staff typed it and the bank record
   * confirmed it (a code-key match), so the unlinked record cannot be
   * re-claimed by that same code — and the screenshot, so the row
   * re-enters the open payout set. A code typed by hand that the bank
   * never confirmed is refused here (no bank event to unlink).
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
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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

      // The bank transaction that claimed it goes back to UNMATCHED
      // (Q-BT3); its screenshot object is its own evidence and is never
      // deleted here — only a key in this row's legacy folder is.
      const unlinkedTransactionId =
        dto.action === 'unlink'
          ? await unlinkByWithdrawal(tx, this.audit, admin, withdrawalId)
          : null;
      const legacyScreenshot =
        dto.action === 'unlink' &&
        withdrawal.transferScreenshotKey !== null &&
        this.storageService.ownsBankScreenshot(
          'withdrawals',
          withdrawalId,
          withdrawal.transferScreenshotKey,
        )
          ? withdrawal.transferScreenshotKey
          : null;

      return {
        withdrawal: updated,
        unlinkedTransactionId,
        screenshotToDelete: legacyScreenshot,
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
    if (result.unlinkedTransactionId) {
      await pushBankTransactionChange(
        this.prisma,
        this.realtimeGateway,
        result.unlinkedTransactionId,
        'updated',
      );
    }

    return {
      ...this.toAdminResponse(result.withdrawal),
      user: result.withdrawal.user,
    };
  }

  /** GET /withdrawals/:id — one row in the STAFF shape; see DepositsService.findOneAdmin. */
  async findOneAdmin(withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        user: { select: ADMIN_USER_SELECT },
        ...BANK_TRANSACTION_LINK_INCLUDE,
      },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    return { ...this.toAdminResponse(withdrawal), user: withdrawal.user };
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
      bankTransaction?: { id: string } | null;
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
      bankTransactionId: withdrawal.bankTransaction?.id ?? null,
    };
  }
}
