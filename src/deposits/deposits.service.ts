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
import { depositSnapshot } from '../audit/audit-snapshots';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { VerificationFilter } from '../common/dto/verification-filter';
import {
  countRecentDepositsByUser,
  depositVerificationPayload,
  findDepositTwins,
  recomputeDepositTwins,
  updateDepositRisk,
} from '../bank-events/deposit-risk';
import {
  NO_BANK_TRANSACTION_AFTER_MS,
  type RiskReason,
  normalizeReasons,
  referenceTwinReasons,
  scoreVerification,
  velocityReasons,
  verificationView,
} from '../bank-events/risk-rules';
import {
  BankMatchStatus,
  BankRiskLevel,
  DepositStatus,
  NotificationType,
  Prisma,
  TransactionType,
} from '../generated/prisma/client';
import type { Deposit } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateDepositDto } from './dto/create-deposit.dto';
import type { CreateManualDepositDto } from './dto/create-manual-deposit.dto';
import type { ApproveDepositDto } from './dto/approve-deposit.dto';
import type { RejectDepositDto } from './dto/reject-deposit.dto';
import type { DepositQueryDto } from './dto/deposit-query.dto';
import type { UpdateReceivingAccountDto } from './dto/update-receiving-account.dto';
import type { VerificationReviewDto } from './dto/verification-review.dto';

/**
 * Shown verbatim by the admin, website and mobile clients — keep the text
 * identical at every throw site.
 */
const DUPLICATE_REFERENCE_MESSAGE =
  'A deposit with this transaction reference already exists';

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Audit-log label: the real-world payment reference plus whose deposit it is. */
function depositLabel(deposit: {
  reference: string;
  user?: { username: string } | null;
}): string {
  return deposit.user
    ? `${deposit.reference} · @${deposit.user.username}`
    : deposit.reference;
}

/**
 * Only the "which of OUR accounts received it" record — the fields
 * updateReceivingAccount may change — so its audit row diffs exactly that.
 */
function receivingAccountSnapshot(deposit: Partial<Deposit>) {
  const {
    receivingAccountType,
    receivingAccountSubname,
    receivingAccountName,
    receivingAccountNumber,
    receivingTransactionCode,
    receivingTransactionTime,
    receivingPaymentAccountId,
  } = depositSnapshot(deposit);
  return {
    receivingAccountType,
    receivingAccountSubname,
    receivingAccountName,
    receivingAccountNumber,
    receivingTransactionCode,
    receivingTransactionTime,
    receivingPaymentAccountId,
  };
}

/**
 * The reasons that only exist because a bank event was applied to the row.
 * `unlink` strips exactly these; the reference/velocity reasons describe
 * the submission itself and survive an unlink.
 */
const BANK_EVENT_REASONS: readonly RiskReason[] = [
  'AMOUNT_MISMATCH',
  'CODE_MISMATCH',
  'SUBMITTED_BEFORE_TRANSFER',
  'TIME_GAP_TOO_LARGE',
  'AMBIGUOUS_MATCH',
];

const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  phone: true,
  email: true,
} satisfies Prisma.UserSelect;

/**
 * The columns a depositor must never see about their own row: the bank's
 * values, the fraud score, whether evidence exists. Stripped by toResponse,
 * re-added (derived, key-less) only by toAdminResponse.
 */
const USER_HIDDEN_DEPOSIT_KEYS = [
  'receivingAmount',
  'receivingTransactionAt',
  'receivingScreenshotKey',
  'receivingEventKey',
  'bankCheckedAt',
  'matchStatus',
  'riskLevel',
  'riskReasons',
  'declaredTransferAt',
] as const satisfies readonly (keyof Deposit)[];

/** A shallow copy without the given keys (typed so the result still has the rest). */
function omitKeys<T extends object, K extends string>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly financeSettingsService: FinanceSettingsService,
    private readonly paymentAccountLedgerService: PaymentAccountLedgerService,
    private readonly audit: AuditService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * PENDING/APPROVED deposits block reuse of the same reference; REJECTED
   * ones don't, so a user can resubmit under the same real-world payment
   * reference after a mistaken rejection. The guarantee is the partial
   * unique index deposits_reference_active_key (schema.prisma): the
   * findFirst pre-check below is only the friendly fast path, and a
   * concurrent duplicate that slips past it surfaces as P2002 on insert,
   * mapped to the same 409. Balance never moves here.
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
      throw new ConflictException(DUPLICATE_REFERENCE_MESSAGE);
    }

    // The insert and the create-time risk flags commit together (Q13): the
    // new row's own DUPLICATE_REFERENCE / SHARED / VELOCITY reasons, and
    // the twin recompute on every other row carrying this reference. Both
    // are indexed lookups (reference, (userId, createdAt)) — never a scan.
    let created: { deposit: Deposit; changedTwinIds: string[] };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposit.create({
          data: {
            userId,
            amount: dto.amount,
            paymentMethod: dto.paymentMethod,
            accountName: dto.accountName,
            reference: dto.reference,
            declaredPaymentAccountId: dto.paymentAccountId,
          },
        });
        return this.applyCreateTimeRules(tx, deposit, 'deposit_create');
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(DUPLICATE_REFERENCE_MESSAGE);
      }
      throw error;
    }
    const { deposit } = created;

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true, displayName: true, phone: true, email: true },
    });

    this.realtimeGateway.notifyAdminsDepositCreated({
      id: deposit.id,
      userId: deposit.userId,
      username: user.username,
      displayName: user.displayName,
      phone: user.phone,
      email: user.email,
      amount: decimalToNumber(deposit.amount),
      paymentMethod: deposit.paymentMethod,
      accountName: deposit.accountName,
      reference: deposit.reference,
      status: deposit.status,
      createdAt: deposit.createdAt,
      matchStatus: deposit.matchStatus,
      riskLevel: deposit.riskLevel,
      riskReasons: deposit.riskReasons,
    });
    await this.pushVerificationUpdates(created.changedTwinIds);

    // The seconds-fast path: the phone-monitor flushes its outbox now
    // instead of at its next tick. A hint only — its own schedule delivers
    // the event even if no monitor is connected.
    this.realtimeGateway.notifyBankMonitorsNudge({
      kind: 'deposit',
      paymentAccountId: deposit.declaredPaymentAccountId,
    });

    return this.toResponse(deposit);
  }

  /**
   * Q13/Q14's shared half: the reference-twin and velocity reasons for a
   * freshly inserted row, written onto it (audited as a system
   * risk_update — the create itself is user self-service, which the audit
   * log deliberately does not record), plus the twin recompute. Bank
   * values stay null; the row can be PENDING_REVIEW/SUSPICIOUS before any
   * bank event arrives.
   */
  private async applyCreateTimeRules(
    tx: Prisma.TransactionClient,
    deposit: Deposit,
    trigger: 'deposit_create' | 'deposit_manual_create',
  ): Promise<{ deposit: Deposit; changedTwinIds: string[] }> {
    const twins = await findDepositTwins(tx, deposit.reference, deposit.id);
    const recent = await countRecentDepositsByUser(
      tx,
      deposit.userId,
      deposit.createdAt,
    );
    const reasons = [
      ...referenceTwinReasons(deposit, twins),
      ...velocityReasons(recent),
    ];
    const metadata = { trigger, anchorDepositId: deposit.id };
    const changedTwins = await recomputeDepositTwins(
      tx,
      this.audit,
      deposit,
      twins,
      metadata,
    );
    if (reasons.length === 0) {
      return { deposit, changedTwinIds: changedTwins.map((t) => t.id) };
    }
    const score = scoreVerification(reasons, false);
    await updateDepositRisk(tx, this.audit, deposit, score, metadata);
    return {
      deposit: { ...deposit, ...score },
      changedTwinIds: changedTwins.map((t) => t.id),
    };
  }

  /** Admins-room realtime push for rows whose verification state changed — after commit only. */
  private async pushVerificationUpdates(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.deposit.findMany({
      where: { id: { in: [...ids] } },
    });
    for (const row of rows) {
      this.realtimeGateway.notifyAdminsDepositVerificationUpdated(
        depositVerificationPayload(row),
      );
    }
  }

  async findAllForUser(userId: string, query: DepositQueryDto) {
    return this.findAll({ ...query, userId });
  }

  /**
   * Q11 — the admin list with the five verification tabs. `all`,
   * `verified` and `needs_review` are ordinary Prisma filters (matchStatus
   * equality lands on the full deposits_matchStatus_createdAt_idx, which a
   * bound parameter can use). The two OPEN-SET tabs go through
   * findOpenAdmin: their predicate must be literal SQL for the partial
   * deposits_open_createdAt_idx to be chosen.
   */
  async findAllAdmin(query: DepositQueryDto) {
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

    const where: Prisma.DepositWhereInput = {
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
      this.prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: ADMIN_USER_SELECT } },
      }),
      this.prisma.deposit.count({ where }),
    ]);

    return {
      items: items.map((d) => ({
        ...this.toAdminResponse(d, now),
        user: d.user,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * The "awaiting bank" (open set, younger than the window) and "no bank
   * transaction" (open set, older than it — the computed-never-swept rule
   * as a WHERE clause) tabs. Page of ids from the partial index in
   * createdAt order, then a primary-key fetch of exactly those rows with
   * their user. A non-PENDING status filter can match nothing here and
   * short-circuits without a query.
   */
  private async findOpenAdmin(
    query: DepositQueryDto,
    verification: 'awaiting_bank' | 'no_bank_transaction',
    page: number,
    limit: number,
    now: Date,
  ) {
    if (query.status && query.status !== DepositStatus.PENDING) {
      return { items: [], total: 0, page, limit };
    }
    const cutoff = new Date(now.getTime() - NO_BANK_TRANSACTION_AFTER_MS);
    const predicate = Prisma.sql`status = 'PENDING'::"DepositStatus"
      AND "bankCheckedAt" IS NULL
      AND ${
        verification === 'awaiting_bank'
          ? Prisma.sql`"createdAt" >= ${cutoff}`
          : Prisma.sql`"createdAt" < ${cutoff}`
      }
      ${query.dateFrom ? Prisma.sql`AND "createdAt" >= ${new Date(query.dateFrom)}` : Prisma.empty}
      ${query.dateTo ? Prisma.sql`AND "createdAt" <= ${new Date(query.dateTo)}` : Prisma.empty}
      ${query.userId ? Prisma.sql`AND "userId" = ${query.userId}` : Prisma.empty}`;

    const [idRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM deposits WHERE ${predicate}
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ),
      this.prisma.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT count(*)::int AS n FROM deposits WHERE ${predicate}`,
      ),
    ]);
    const ids = idRows.map((row) => row.id);
    const total = Number(countRows[0]?.n ?? 0);
    if (ids.length === 0) return { items: [], total, page, limit };

    const rows = await this.prisma.deposit.findMany({
      where: { id: { in: ids } },
      include: { user: { select: ADMIN_USER_SELECT } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((d) => ({ ...this.toAdminResponse(d, now), user: d.user }));
    return { items, total, page, limit };
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
  async approve(
    depositId: string,
    admin: AuthenticatedUser,
    dto: ApproveDepositDto = {},
  ) {
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
        include: { user: { select: ADMIN_USER_SELECT } },
      });
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: deposit.userId },
      });

      // Inside the transaction, so the audit row commits with the approval
      // (and rolls back with it). The verification state at the moment of
      // approval travels in the metadata — "the admin approved a SUSPICIOUS
      // row" must be readable from the log without a join.
      await this.audit.record({
        action: 'deposit.approve',
        actor: admin,
        target: {
          type: 'deposit',
          id: depositId,
          label: depositLabel(updated),
        },
        before: depositSnapshot(deposit),
        after: depositSnapshot(updated),
        metadata: {
          creditedPaymentAccountId: accountToCredit,
          matchStatus: updated.matchStatus,
          riskLevel: updated.riskLevel,
          riskReasons: updated.riskReasons,
        },
        tx,
      });

      // Q14 — the approved row's twins learn that this reference now sits
      // on an APPROVED row; its own stored reasons are untouched.
      const twins = await findDepositTwins(tx, deposit.reference, deposit.id);
      const changedTwins = await recomputeDepositTwins(
        tx,
        this.audit,
        deposit,
        twins,
        { trigger: 'deposit_approve', anchorDepositId: deposit.id },
      );

      return {
        deposit: updated,
        notification,
        balance: wallet.balance,
        accountToCredit,
        changedTwinIds: changedTwins.map((twin) => twin.id),
      };
    });

    if (result.accountToCredit) {
      this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
        paymentAccountId: result.accountToCredit,
      });
    }
    await this.pushVerificationUpdates(result.changedTwinIds);

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

    return {
      ...this.toAdminResponse(result.deposit),
      user: result.deposit.user,
    };
  }

  /**
   * Admin records a deposit that already happened (money visibly landed in
   * one of OUR accounts) — created directly in APPROVED state, so it mirrors
   * approve()'s side effects exactly in one transaction: destination-account
   * ledger credit via syncDepositLink, wallet credit, Transaction row and
   * DEPOSIT_APPROVED notification. Sockets are emitted only after the
   * transaction has actually committed, same as approve(). A concurrent
   * duplicate reference that slips past the pre-check fails the insert
   * (partial unique index → P2002), rolling back before any money moves.
   */
  async createManual(dto: CreateManualDepositDto, admin: AuthenticatedUser) {
    const result = await this.prisma
      .$transaction(async (tx) => {
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
          throw new ConflictException(DUPLICATE_REFERENCE_MESSAGE);
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
            payload: {
              depositId: deposit.id,
              amount: deposit.amount.toNumber(),
            },
          },
        });

        // An admin-recorded deposit is a row with a reference: it and its
        // twins learn about each other exactly as a user-submitted one does.
        const flagged = await this.applyCreateTimeRules(
          tx,
          deposit,
          'deposit_manual_create',
        );

        const created = await tx.deposit.findUniqueOrThrow({
          where: { id: deposit.id },
          include: { user: { select: ADMIN_USER_SELECT } },
        });
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userId: deposit.userId },
        });

        await this.audit.record({
          action: 'deposit.manual_create',
          actor: admin,
          target: {
            type: 'deposit',
            id: created.id,
            label: depositLabel(created),
          },
          after: depositSnapshot(created),
          metadata: {
            destinationPaymentAccountId: dto.destinationPaymentAccountId,
          },
          tx,
        });

        return {
          deposit: created,
          notification,
          balance: wallet.balance,
          changedTwinIds: flagged.changedTwinIds,
        };
      })
      .catch((error: unknown) => {
        // Postgres aborts the transaction on 23505, so the mapping must live
        // outside $transaction (same shape as WalletAdjustmentsService.adjust).
        // The loser fails at tx.deposit.create, before the ledger credit,
        // wallet credit, Transaction row, notification and audit row — so
        // nothing is written and the socket emits below never run.
        if (isUniqueViolation(error)) {
          throw new ConflictException(DUPLICATE_REFERENCE_MESSAGE);
        }
        throw error;
      });

    this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
      paymentAccountId: dto.destinationPaymentAccountId,
    });
    await this.pushVerificationUpdates(result.changedTwinIds);

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

    return {
      ...this.toAdminResponse(result.deposit),
      user: result.deposit.user,
    };
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
        include: { user: { select: ADMIN_USER_SELECT } },
      });

      await this.audit.record({
        action: 'deposit.reject',
        actor: admin,
        target: {
          type: 'deposit',
          id: depositId,
          label: depositLabel(updated),
        },
        before: depositSnapshot(deposit),
        after: depositSnapshot(updated),
        metadata: { reason: dto.reason },
        tx,
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

    return {
      ...this.toAdminResponse(result.deposit),
      user: result.deposit.user,
    };
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
        include: { user: { select: ADMIN_USER_SELECT } },
      });

      // `updatedDeposit` is read after syncDepositLink's claim, so its
      // receivingPaymentAccountId already reflects the re-link.
      await this.audit.record({
        action: 'deposit.receiving_account_update',
        actor: admin,
        target: {
          type: 'deposit',
          id: depositId,
          label: depositLabel(updatedDeposit),
        },
        before: receivingAccountSnapshot(deposit),
        after: receivingAccountSnapshot(updatedDeposit),
        metadata: { oldPaymentAccountId, newPaymentAccountId },
        tx,
      });

      return {
        deposit: updatedDeposit,
        oldPaymentAccountId,
        newPaymentAccountId,
      };
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
      this.realtimeGateway.notifyAdminsPaymentAccountUpdated({
        paymentAccountId,
      });
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

    return { ...this.toAdminResponse(updated), user: updated.user };
  }

  /**
   * A staff decision on a flagged row (PATCH /deposits/:id/verification).
   *   clear  — reviewed, no issue: reasons emptied, level unscored; the
   *            status becomes MATCHED only when bank values are present
   *            and none of them actually disagree with the user (a hard
   *            mismatch cleared by hand still is not "every check passed").
   *   confirm_suspicious — the admin agrees: SUSPICIOUS / HIGH, reasons kept.
   *   unlink — the bank values were attached to the wrong row (the amount
   *            fallback path can do that): wipe every bank column and the
   *            screenshot so the row re-enters the open set; the reasons
   *            that describe the submission itself (twins, velocity) stay.
   *            PENDING only — an approved deposit keeps its evidence.
   * A later twin recompute re-derives status from the stored reasons, so a
   * `confirm_suspicious` on a row with no reasons can be undone by its
   * twins changing; the audit trail keeps the admin's decision either way.
   */
  async reviewVerification(
    depositId: string,
    dto: VerificationReviewDto,
    admin: AuthenticatedUser,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Deposit not found');

      let data: Prisma.DepositUpdateInput;
      if (dto.action === 'clear') {
        const hasBankValues = deposit.bankCheckedAt !== null;
        const hardMismatch = deposit.riskReasons.some(
          (reason) =>
            reason === 'AMOUNT_MISMATCH' || reason === 'CODE_MISMATCH',
        );
        data = {
          matchStatus:
            hasBankValues && !hardMismatch
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
        if (deposit.bankCheckedAt === null) {
          throw new BadRequestException(
            'This deposit has no bank event to unlink',
          );
        }
        if (deposit.status !== DepositStatus.PENDING) {
          throw new BadRequestException(
            'Only a pending deposit can have its bank event unlinked',
          );
        }
        const kept = normalizeReasons(deposit.riskReasons).filter(
          (reason) => !BANK_EVENT_REASONS.includes(reason),
        );
        data = {
          receivingAmount: null,
          receivingTransactionCode: null,
          receivingTransactionTime: null,
          receivingTransactionAt: null,
          receivingEventKey: null,
          receivingScreenshotKey: null,
          bankCheckedAt: null,
          ...scoreVerification(kept, false),
        };
      }

      const updated = await tx.deposit.update({
        where: { id: depositId },
        data,
        include: { user: { select: ADMIN_USER_SELECT } },
      });

      await this.audit.record({
        action: 'deposit.verification_review',
        actor: admin,
        target: {
          type: 'deposit',
          id: depositId,
          label: depositLabel(updated),
        },
        before: depositSnapshot(deposit),
        after: depositSnapshot(updated),
        metadata: { action: dto.action, note: dto.note ?? null },
        tx,
      });

      return {
        deposit: updated,
        screenshotToDelete:
          dto.action === 'unlink' ? deposit.receivingScreenshotKey : null,
      };
    });

    // After commit: the object is evidence only while the row points at it.
    // A failed delete is logged, never surfaced — the row is already clean.
    if (result.screenshotToDelete) {
      await this.minioService
        .deleteObject(result.screenshotToDelete)
        .catch((error: Error) =>
          this.logger.warn(
            `Could not delete bank screenshot ${result.screenshotToDelete}: ${error.message}`,
          ),
        );
    }
    this.realtimeGateway.notifyAdminsDepositVerificationUpdated(
      depositVerificationPayload(result.deposit),
    );

    return {
      ...this.toAdminResponse(result.deposit),
      user: result.deposit.user,
    };
  }

  /**
   * GET /deposits/:id/bank-screenshot — the bank-notification screenshot,
   * streamed from private storage to a staff member holding
   * DEPOSITS.BANK_EVIDENCE. Never a URL: the object lives under documents/,
   * which the cache server denies and nothing can sign.
   */
  async getBankScreenshot(depositId: string): Promise<StreamableFile> {
    const deposit = await this.prisma.deposit.findUnique({
      where: { id: depositId },
      select: { receivingScreenshotKey: true },
    });
    if (!deposit) throw new NotFoundException('Deposit not found');
    if (!deposit.receivingScreenshotKey) {
      throw new NotFoundException('This deposit has no bank screenshot');
    }
    const object = await this.minioService.getObjectStream(
      deposit.receivingScreenshotKey,
    );
    if (!object) {
      throw new NotFoundException('This deposit has no bank screenshot');
    }
    return new StreamableFile(object.stream, {
      type: 'image/png',
      disposition: `inline; filename="bank-${depositId}.png"`,
      ...(object.contentLength !== null && { length: object.contentLength }),
    });
  }

  /**
   * The USER-SAFE shape (/deposits, /deposits/me): what the depositor may
   * see about their own row. Every bank-verification column is stripped
   * here — a user must never see their own fraud score, the bank's values,
   * or that a screenshot exists.
   */
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
    const visible = omitKeys(deposit, USER_HIDDEN_DEPOSIT_KEYS);
    return {
      ...visible,
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

  /**
   * The STAFF shape: the user-safe shape plus the bank side, with the
   * read-time NO_BANK_TRANSACTION derivation (Q12) applied — `matchStatus`
   * is the VIEW value, `riskReasons` stored ∪ derived, `riskLevel` raised
   * to at least MEDIUM when derived. The screenshot key itself never leaves
   * the server; only `hasBankScreenshot` does.
   */
  private toAdminResponse(
    deposit: Parameters<DepositsService['toResponse']>[0] & {
      receivingAmount?: unknown;
      receivingTransactionAt?: Date | null;
      receivingScreenshotKey?: string | null;
      bankCheckedAt?: Date | null;
      matchStatus?: BankMatchStatus;
      riskLevel?: BankRiskLevel | null;
      riskReasons?: string[];
      declaredTransferAt?: Date | null;
    },
    now: Date = new Date(),
  ) {
    const view = verificationView(
      {
        status: deposit.status,
        bankCheckedAt: deposit.bankCheckedAt ?? null,
        createdAt: deposit.createdAt,
        matchStatus: deposit.matchStatus ?? BankMatchStatus.UNVERIFIED,
        riskLevel: deposit.riskLevel ?? null,
        riskReasons: deposit.riskReasons ?? [],
      },
      now,
    );
    return {
      ...this.toResponse(deposit),
      receivingAmount:
        deposit.receivingAmount == null
          ? null
          : decimalToNumber(deposit.receivingAmount as never),
      receivingTransactionAt: deposit.receivingTransactionAt ?? null,
      bankCheckedAt: deposit.bankCheckedAt ?? null,
      matchStatus: view.matchStatus,
      riskLevel: view.riskLevel,
      riskReasons: view.riskReasons,
      hasBankScreenshot: Boolean(deposit.receivingScreenshotKey),
      declaredTransferAt: deposit.declaredTransferAt ?? null,
    };
  }
}
