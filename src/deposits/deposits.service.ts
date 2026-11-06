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
import {
  CLOSED_ACCOUNT_MESSAGE,
  lockAccountStatus,
} from '../users/account-status-lock';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FinanceSettingsService } from '../finance-settings/finance-settings.service';
import { PaymentAccountLedgerService } from '../payment-accounts/payment-account-ledger.service';
import { AuditService } from '../audit/audit.service';
import { depositSnapshot } from '../audit/audit-snapshots';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
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
  depositSearchWhere,
  depositVerificationWhere,
} from './deposit-admin-query';
import {
  BANK_TRANSACTION_LINK_INCLUDE,
  countRecentDepositsByUser,
  depositVerificationPayload,
  findDepositTwins,
  recomputeDepositTwins,
  updateDepositRisk,
} from '../bank-events/deposit-risk';
import {
  claimDepositWithTransaction,
  openDepositRowOf,
} from '../bank-events/deposit-matcher';
import {
  bankTransactionPayload,
  findOpenReceivedTransactions,
  unlinkByDeposit,
} from '../bank-transactions/bank-transaction-store';
import {
  NO_BANK_TRANSACTION_AFTER_MS,
  type RiskReason,
  amountsEqual,
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
  Role,
  TransactionType,
  UserStatus,
} from '../generated/prisma/client';
import type { Deposit } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import type { CreateDepositDto } from './dto/create-deposit.dto';
import type { CreateManualDepositDto } from './dto/create-manual-deposit.dto';
import type { ManualDepositUserLookupDto } from './dto/manual-deposit-user-lookup.dto';
import type { ApproveDepositDto } from './dto/approve-deposit.dto';
import type { RejectDepositDto } from './dto/reject-deposit.dto';
import type { DepositQueryDto } from './dto/deposit-query.dto';
import type { UpdateReceivingAccountDto } from './dto/update-receiving-account.dto';
import type { VerificationReviewDto } from './dto/verification-review.dto';

/**
 * Shown verbatim by the admin, website and mobile clients — keep the text
 * identical at every throw site.
 */
/** Shown verbatim by the apps — keep it a sentence a depositor can act on. */
export const INACTIVE_PAYMENT_ACCOUNT_MESSAGE =
  'This payment account is no longer accepting deposits. Please choose another account.';

const DUPLICATE_REFERENCE_MESSAGE =
  'A deposit with this transaction reference already exists';

/**
 * M-11/M-14: a staff member never moves money on their OWN account. Shown
 * verbatim by the admin app's error toast.
 */
export const SELF_APPROVE_DEPOSIT_MESSAGE =
  'You cannot approve a deposit into your own account';
export const SELF_REJECT_DEPOSIT_MESSAGE =
  'You cannot reject a deposit into your own account';
export const SELF_MANUAL_DEPOSIT_MESSAGE =
  'You cannot record a deposit into your own account';
export const MANUAL_DEPOSIT_CUSTOMER_ONLY_MESSAGE =
  'Manual deposits can only be recorded for customer accounts';

/** M-15/M-7: the bank saw a different amount — an explicit decision is required. */
export const AMOUNT_MISMATCH_OVERRIDE_REQUIRED_MESSAGE =
  'The bank saw a different amount than the user typed. To approve, choose to credit the bank amount and give a reason.';
export const AMOUNT_MISMATCH_REASON_REQUIRED_MESSAGE =
  'A reason is required to credit the bank amount instead of the typed amount';

/**
 * DB-003: the phone's bank event landed on the row between the approval's
 * read and its claim — the row is still PENDING, but it now carries bank
 * values the staff member never saw. Shown verbatim by the admin's toast.
 */
export const DEPOSIT_CHANGED_DURING_APPROVAL_MESSAGE =
  'The deposit changed while you were approving — reload and try again';

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
  // M-16: compares the transfer's sender name — gone once the transfer is.
  'COUNTERPARTY_MISMATCH',
  // SEC-004: "the transfer has no picture yet" — gone once the transfer is.
  'NO_SCREENSHOT',
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
    private readonly storageService: StorageService,
  ) {}

  /**
   * The caller's OWN PENDING/APPROVED deposits block reuse of the same
   * reference (a double submit); REJECTED ones don't, so a user can
   * resubmit under the same real-world payment reference after a mistaken
   * rejection. Another user's deposit never blocks it (H-11): the 6-digit
   * last-6 is not a secret, so a global rule let whoever typed it first
   * own it and refused the real payer. That twin is stored instead and
   * the create-time rules flag both rows (DUPLICATE_REFERENCE, plus
   * SHARED_REFERENCE_ACROSS_USERS on the same amount) for staff review;
   * the matcher never picks between two open twins (AMBIGUOUS). The
   * guarantee is the partial unique index deposits_user_reference_active_key
   * (schema.prisma): the findFirst pre-check below is only the friendly
   * fast path, and a concurrent duplicate that slips past it surfaces as
   * P2002 on insert, mapped to the same 409. Balance never moves here.
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
        userId,
        reference: dto.reference,
        status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
      },
    });
    if (duplicate) {
      throw new ConflictException(DUPLICATE_REFERENCE_MESSAGE);
    }

    // The account the user says they paid into must still be one we take
    // deposits on. The public list hides deactivated accounts, but a client
    // that loaded the list before the admin flipped the switch still holds
    // it — this is the check that cannot be cached away. Same wording on
    // both failures: to the user the account is simply gone.
    if (dto.paymentAccountId) {
      const account = await this.prisma.paymentAccount.findUnique({
        where: { id: dto.paymentAccountId },
        select: { isActive: true },
      });
      if (!account || !account.isActive) {
        throw new BadRequestException(INACTIVE_PAYMENT_ACCOUNT_MESSAGE);
      }
    }

    // The insert, the create-time risk flags and the bank-transaction claim
    // commit together (Q13 + Q-BT1): the new row's own DUPLICATE_REFERENCE
    // / SHARED / VELOCITY reasons, the twin recompute on every other row
    // carrying this reference, and — when the phone already stored the
    // transfer carrying this code — the claim of that transaction. All
    // indexed lookups (reference, (userId, createdAt), the open-set
    // partial index) — never a scan.
    let created: {
      deposit: Deposit;
      changedTwinIds: string[];
      linkedTransactionId: string | null;
    };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // H-16: an account closed while this request was in flight takes no
        // new deposit (see lockAccountStatus) — nor does one suspended or
        // banned meanwhile, the same refusal JwtStrategy gives.
        if ((await lockAccountStatus(tx, userId)) !== UserStatus.ACTIVE) {
          throw new UnauthorizedException('This account is no longer active');
        }
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
        const flagged = await this.applyCreateTimeRules(
          tx,
          deposit,
          'deposit_create',
        );
        return this.claimWaitingTransaction(tx, flagged);
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

    // POST-claim values: an admin's live row must show the same state a
    // refetch would.
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
      declaredPaymentAccountId: deposit.declaredPaymentAccountId,
      status: deposit.status,
      createdAt: deposit.createdAt,
      matchStatus: deposit.matchStatus,
      riskLevel: deposit.riskLevel,
      riskReasons: deposit.riskReasons,
    });
    await this.pushVerificationUpdates([
      ...(created.linkedTransactionId ? [deposit.id] : []),
      ...created.changedTwinIds,
    ]);
    if (created.linkedTransactionId) {
      await this.pushBankTransactionUpdate(created.linkedTransactionId);
    }

    // No phone-monitor nudge any more: a transfer that arrived first was
    // just claimed above; one that arrives later matches at ingestion.
    // There is no third case for a hint to cover.
    return this.toResponse(deposit);
  }

  /**
   * The reverse lookup (Q-BT1): the phone may have stored this deposit's
   * "You received …" transfer minutes (or a day) BEFORE the user got round
   * to submitting. Exactly one open transaction for (declared account,
   * reference) → claim it exactly as ingestion would (bank values, the full
   * rule set re-derived, deposit.bank_match + bank_transaction.link audit
   * rows, the link) in the same transaction as the insert, so the deposit
   * is verified the instant it exists. Two or more (a second phone
   * capturing the same notification under a new key, or two full codes
   * sharing a last-6) → AMBIGUOUS_MATCH on the NEW deposit only, the
   * transactions untouched — never guess; the admin resolves and the
   * phone's Resend or a later post lands on the 1-row branch. None → the
   * deposit simply waits for ingestion. Only when the depositor declared
   * an account: without one there is no key to look up by.
   *
   * createManual is deliberately NOT given this: it inserts an APPROVED
   * row, outside the open set by status, so a reverse lookup there would
   * find transactions it may not claim.
   */
  private async claimWaitingTransaction(
    tx: Prisma.TransactionClient,
    flagged: { deposit: Deposit; changedTwinIds: string[] },
  ): Promise<{
    deposit: Deposit;
    changedTwinIds: string[];
    linkedTransactionId: string | null;
  }> {
    const { deposit } = flagged;
    if (!deposit.declaredPaymentAccountId) {
      return { ...flagged, linkedTransactionId: null };
    }
    const waiting = await findOpenReceivedTransactions(
      tx,
      deposit.declaredPaymentAccountId,
      deposit.reference,
    );
    if (waiting.length === 0) {
      return { ...flagged, linkedTransactionId: null };
    }
    if (waiting.length === 1) {
      const claimed = await claimDepositWithTransaction(
        tx,
        this.audit,
        openDepositRowOf(deposit),
        waiting[0],
        [],
        new Date(),
        'deposit_create',
      );
      const twinIds = new Set(flagged.changedTwinIds);
      for (const id of claimed.touchedDepositIds) {
        if (id !== deposit.id) twinIds.add(id);
      }
      return {
        deposit: claimed.deposit,
        changedTwinIds: [...twinIds],
        linkedTransactionId: waiting[0].id,
      };
    }
    const score = scoreVerification(
      [...deposit.riskReasons, 'AMBIGUOUS_MATCH'],
      false,
    );
    await updateDepositRisk(tx, this.audit, deposit, score, {
      trigger: 'deposit_create',
      reason: 'AMBIGUOUS_BANK_TRANSACTIONS',
      candidateTransactionIds: waiting.map((row) => row.id),
    });
    return {
      deposit: { ...deposit, ...score },
      changedTwinIds: flagged.changedTwinIds,
      linkedTransactionId: null,
    };
  }

  /** Q-BT8 — the linked transaction by primary key, after commit, to the admins room. */
  private async pushBankTransactionUpdate(id: string): Promise<void> {
    const row = await this.prisma.bankTransaction.findUnique({
      where: { id },
    });
    if (row) {
      this.realtimeGateway.notifyAdminsBankTransactionUpdated(
        bankTransactionPayload(row),
      );
    }
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
      include: BANK_TRANSACTION_LINK_INCLUDE,
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
   * deposits_open_createdAt_idx to be chosen — unless a search is set
   * (H-24): the search already narrows the rows, so a searched open tab
   * takes the ordinary path with the same predicate in Prisma form.
   */
  async findAllAdmin(query: DepositQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const verification: VerificationFilter = query.verification ?? 'all';
    const now = new Date();
    const search = depositSearchWhere(query.search);
    const openTab =
      verification === 'awaiting_bank' ||
      verification === 'no_bank_transaction';

    if (openTab && !search) {
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
      ...(search && {
        AND: [
          ...(openTab ? [depositVerificationWhere(verification, now)] : []),
          search,
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
   * GET /deposits/stats (H-24) — the admin queue's stat cards and tab
   * counts, computed by the database over every row matching the same
   * filters as the list (date range, user, search), never summed from one
   * loaded page. Faceted like the tabs themselves: the per-status totals
   * follow the selected verification tab but not the status filter, and
   * the five verification counts follow the status filter but not the
   * selected tab. page/limit are accepted and ignored.
   */
  async getAdminStats(query: DepositQueryDto): Promise<AdminMoneyStats> {
    const now = new Date();
    const base: Prisma.DepositWhereInput[] = [
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
      depositSearchWhere(query.search) ?? {},
    ];

    const [grouped, tabCounts] = await Promise.all([
      this.prisma.deposit.groupBy({
        by: ['status'],
        where: {
          AND: [
            ...base,
            depositVerificationWhere(query.verification ?? 'all', now),
          ],
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      Promise.all(
        VERIFICATION_FILTERS.map((tab) =>
          this.prisma.deposit.count({
            where: {
              AND: [
                ...base,
                { status: query.status },
                depositVerificationWhere(tab, now),
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
      include: {
        user: { select: ADMIN_USER_SELECT },
        ...BANK_TRANSACTION_LINK_INCLUDE,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((d) => ({ ...this.toAdminResponse(d, now), user: d.user }));
    return { items, total, page, limit };
  }

  /**
   * GET /deposits/:id — one row in the STAFF shape, so the admin's bank
   * transactions page can open a linked deposit's Verification Details
   * without paging the list for it. Primary key + the two one-column
   * joins.
   */
  async findOneAdmin(depositId: string) {
    const deposit = await this.prisma.deposit.findUnique({
      where: { id: depositId },
      include: {
        user: { select: ADMIN_USER_SELECT },
        ...BANK_TRANSACTION_LINK_INCLUDE,
      },
    });
    if (!deposit) throw new NotFoundException('Deposit not found');
    return { ...this.toAdminResponse(deposit), user: deposit.user };
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
      // M-11/M-14: whoever approves is never the account being credited.
      if (deposit.userId === admin.id) {
        throw new ForbiddenException(SELF_APPROVE_DEPOSIT_MESSAGE);
      }

      // M-15/M-7: the bank's amount, when the phone saw one, is the money
      // that really arrived. When it differs from what the user typed the
      // approval needs an explicit, reasoned decision — and then it is the
      // BANK amount that is credited, never the typed one. Decided before
      // the claim, so a refused approval leaves the row PENDING untouched.
      const bankAmount = deposit.receivingAmount;
      const amountMismatch =
        bankAmount !== null && !amountsEqual(bankAmount, deposit.amount);
      const overrideReason = dto.overrideReason?.trim() ?? '';
      if (amountMismatch) {
        if (dto.creditBankAmount !== true) {
          throw new ConflictException(
            AMOUNT_MISMATCH_OVERRIDE_REQUIRED_MESSAGE,
          );
        }
        if (overrideReason.length === 0) {
          throw new BadRequestException(
            AMOUNT_MISMATCH_REASON_REQUIRED_MESSAGE,
          );
        }
      }
      const creditedAmount: Prisma.Decimal =
        amountMismatch && bankAmount !== null ? bankAmount : deposit.amount;

      // The row's amount becomes the credited amount, so the wallet, the
      // ledger, the user's own deposit history and the totals all tell the
      // same story; the typed amount survives in the audit row's "before".
      //
      // DB-003: the claim is keyed on the bank-checked state this
      // transaction READ, not only on PENDING. The matcher's own claim
      // (deposit-matcher.ts) sets bankCheckedAt under the row lock, so a
      // phone event that lands between the read above and this write makes
      // the re-checked row no longer match (Prisma renders null as IS NULL)
      // — count 0, nothing credited, and the staff member reloads into the
      // M-15 decision instead of the typed amount being credited past it.
      const claim = await tx.deposit.updateMany({
        where: {
          id: depositId,
          status: DepositStatus.PENDING,
          bankCheckedAt: deposit.bankCheckedAt,
        },
        data: {
          status: DepositStatus.APPROVED,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
          ...(amountMismatch && { amount: creditedAmount }),
        },
      });
      if (claim.count !== 1) {
        // One primary-key read on the failure path only, to tell the two
        // causes apart for the person clicking.
        const current = await tx.deposit.findUnique({
          where: { id: depositId },
          select: { status: true },
        });
        throw new ConflictException(
          current?.status === DepositStatus.PENDING
            ? DEPOSIT_CHANGED_DURING_APPROVAL_MESSAGE
            : 'This deposit has already been approved or rejected',
        );
      }
      const credited = { ...deposit, amount: creditedAmount };

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
        credited,
        accountToCredit,
        deposit.reference,
        admin.id,
      );

      const creditedWallet = await this.walletService.creditWithinTransaction(
        tx,
        deposit.userId,
        creditedAmount.toNumber(),
      );

      // Snapshot the wallet balance around this credit onto the deposit row,
      // inside the same transaction — creditWithinTransaction returns the
      // post-credit wallet, so before = after - amount can never drift from
      // the credit that produced it.
      await tx.deposit.update({
        where: { id: depositId },
        data: {
          walletBalanceBefore: creditedWallet.balance.minus(creditedAmount),
          walletBalanceAfter: creditedWallet.balance,
        },
      });

      await tx.transaction.create({
        data: {
          userId: deposit.userId,
          type: TransactionType.DEPOSIT,
          amount: creditedAmount,
          status: 'COMPLETED',
        },
      });

      const notification = await tx.notification.create({
        data: {
          userId: deposit.userId,
          type: NotificationType.DEPOSIT_APPROVED,
          title: 'Deposit approved',
          message: `Your deposit of ${creditedAmount.toString()} Ks has been approved and your balance has been updated.`,
          payload: { depositId: deposit.id, amount: creditedAmount.toNumber() },
        },
      });

      const updated = await tx.deposit.findUniqueOrThrow({
        where: { id: depositId },
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
          // M-15/M-7: what was credited, and — on an override — the typed
          // and bank amounts plus the staff member's reason, in the log
          // itself: "the admin credited the bank amount because …" must be
          // readable without a join.
          creditedAmount: decimalToNumber(creditedAmount),
          ...(amountMismatch && {
            amountOverride: true,
            declaredAmount: decimalToNumber(deposit.amount),
            bankAmount: decimalToNumber(creditedAmount),
            overrideReason,
          }),
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
      change: 'status',
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
   * GET /deposits/manual/users (H-15) — the customer picker of the manual
   * deposit dialog, on DEPOSITS.CREATE (the permission the deposit itself
   * needs) instead of GET /users' USERS.VIEW, which the seeded Admin role
   * does not hold. Deliberately narrow: customer accounts only (the same
   * `role: USER` scope as the Users page), never a CLOSED one (H-16: it can
   * take no money — createManual refuses it), at most 20 rows, and only the
   * four fields the picker renders — no wallet, status or e-mail. A read,
   * and the audit log records no reads, so no audit row.
   */
  async lookupUsersForManualDeposit(query: ManualDepositUserLookupDto) {
    const search = query.search.trim();
    const items = await this.prisma.user.findMany({
      where: {
        role: Role.USER,
        status: { not: UserStatus.CLOSED },
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      },
      select: { id: true, username: true, displayName: true, phone: true },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 8,
    });
    return { items };
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
    // M-11/M-14: never into the recording staff member's own account —
    // decided before anything is read or locked.
    if (dto.userId === admin.id) {
      throw new ForbiddenException(SELF_MANUAL_DEPOSIT_MESSAGE);
    }
    const result = await this.prisma
      .$transaction(async (tx) => {
        // H-16: share-locked first (see lockAccountStatus), so an account its
        // owner is closing right now is either closed already — refused
        // here — or waits for this deposit and then refuses to close. A
        // suspended or banned customer can still have a transfer recorded.
        const status = await lockAccountStatus(tx, dto.userId);
        if (!status) throw new NotFoundException('User not found');
        if (status === UserStatus.CLOSED) {
          throw new ConflictException(CLOSED_ACCOUNT_MESSAGE);
        }
        // M-11/M-14: a manual deposit is money for a CUSTOMER. The picker
        // (lookupUsersForManualDeposit) only ever offers role USER; this is
        // the same rule on the write, so a hand-built request cannot pay a
        // staff account (its own or a colleague's).
        const target = await tx.user.findUnique({
          where: { id: dto.userId },
          select: { role: true },
        });
        if (!target || target.role !== Role.USER) {
          throw new ForbiddenException(MANUAL_DEPOSIT_CUSTOMER_ONLY_MESSAGE);
        }

        // Same duplicate-reference rule create() enforces — without it, an
        // admin recording a transfer the user ALSO submitted through the app
        // would let the same real-world payment credit the wallet twice (once
        // here, once when the pending copy gets approved). Scoped to this
        // user like create() (H-11); another user's row with the same
        // reference is a twin the create-time rules flag below.
        const duplicate = await tx.deposit.findFirst({
          where: {
            userId: dto.userId,
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
          include: {
            user: { select: ADMIN_USER_SELECT },
            ...BANK_TRANSACTION_LINK_INCLUDE,
          },
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
      change: 'status',
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
   * Same atomic claim pattern as approve() — never touches the wallet or
   * ledger. M-17: a rejected row gives its bank evidence back in the same
   * transaction — the bank columns are cleared exactly as the `unlink`
   * review clears them (the event key included, or the next post would
   * re-attach the transfer to this dead row) and the bank transaction that
   * claimed it returns to UNMATCHED — so an honest resubmission under the
   * same reference claims the real transfer at create time instead of
   * drifting to "no bank transaction". The transaction row keeps its own
   * screenshot; the audit row's "before" keeps the values this row had.
   */
  async reject(
    depositId: string,
    admin: AuthenticatedUser,
    dto: RejectDepositDto,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!deposit) throw new NotFoundException('Deposit not found');
      // M-11/M-14: whoever rejects is never the account it belongs to.
      if (deposit.userId === admin.id) {
        throw new ForbiddenException(SELF_REJECT_DEPOSIT_MESSAGE);
      }

      const hadBankEvent = deposit.bankCheckedAt !== null;
      const releasedBankValues: Prisma.DepositUpdateManyMutationInput =
        hadBankEvent
          ? {
              receivingAmount: null,
              receivingTransactionCode: null,
              receivingTransactionTime: null,
              receivingTransactionAt: null,
              receivingEventKey: null,
              receivingScreenshotKey: null,
              bankCheckedAt: null,
              ...scoreVerification(
                normalizeReasons(deposit.riskReasons).filter(
                  (reason) => !BANK_EVENT_REASONS.includes(reason),
                ),
                false,
              ),
            }
          : {};
      const claim = await tx.deposit.updateMany({
        where: { id: depositId, status: DepositStatus.PENDING },
        data: {
          status: DepositStatus.REJECTED,
          rejectionReason: dto.reason,
          approvedByUserId: admin.id,
          approvedAt: new Date(),
          ...releasedBankValues,
        },
      });
      if (claim.count !== 1) {
        throw new ConflictException(
          'This deposit has already been approved or rejected',
        );
      }
      const unlinkedTransactionId = hadBankEvent
        ? await unlinkByDeposit(tx, this.audit, admin, depositId)
        : null;

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
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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
        metadata: {
          reason: dto.reason,
          ...(hadBankEvent && { unlinkedTransactionId }),
        },
        tx,
      });

      return {
        deposit: updated,
        notification,
        releasedBankEvent: hadBankEvent,
        unlinkedTransactionId,
      };
    });

    // M-17, after commit: the admins' live rows learn that the bank values
    // left this row — whenever they did, including a legacy row that had
    // bank values but no bank_transactions link — and, when a transaction
    // was given back, that it is open again.
    if (result.releasedBankEvent) {
      this.realtimeGateway.notifyAdminsDepositVerificationUpdated(
        depositVerificationPayload(result.deposit),
      );
    }
    if (result.unlinkedTransactionId) {
      await this.pushBankTransactionUpdate(result.unlinkedTransactionId);
    }

    this.realtimeGateway.notifyUserDepositUpdated(result.deposit.userId, {
      id: result.deposit.id,
      change: 'status',
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
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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

    // Admins only. Which of OUR accounts the money landed in is bookkeeping
    // the user never sees, and the user's client toasts "Deposit approved"
    // on any deposit.updated with status APPROVED — so this must never enter
    // the user's room. Other admin sessions still need it to stay in sync.
    this.realtimeGateway.notifyAdminsDepositUpdated({
      id: updated.id,
      change: 'receiving_account',
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
   *   unlink — the bank values were attached to the wrong row: wipe every
   *            bank column and the screenshot pointer so the row re-enters
   *            the open set, and put the bank transaction that claimed it
   *            back to UNMATCHED (Q-BT3) so a later deposit can claim it at
   *            create time; the reasons that describe the submission itself
   *            (twins, velocity) stay. PENDING only — an approved deposit
   *            keeps its evidence. The screenshot OBJECT is deleted only
   *            when it sits in this deposit's own legacy folder; one under
   *            documents/bank-screenshots/transactions/ is the
   *            transaction's evidence and outlives the link.
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
        include: {
          user: { select: ADMIN_USER_SELECT },
          ...BANK_TRANSACTION_LINK_INCLUDE,
        },
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

      const unlinkedTransactionId =
        dto.action === 'unlink'
          ? await unlinkByDeposit(tx, this.audit, admin, depositId)
          : null;

      const legacyScreenshot =
        dto.action === 'unlink' &&
        deposit.receivingScreenshotKey !== null &&
        this.storageService.ownsBankScreenshot(
          'deposits',
          depositId,
          deposit.receivingScreenshotKey,
        )
          ? deposit.receivingScreenshotKey
          : null;

      return {
        deposit: updated,
        unlinkedTransactionId,
        screenshotToDelete: legacyScreenshot,
      };
    });

    // After commit: a legacy object is evidence only while the row points
    // at it. A failed delete is logged, never surfaced — the row is
    // already clean.
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
    if (result.unlinkedTransactionId) {
      await this.pushBankTransactionUpdate(result.unlinkedTransactionId);
    }

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
      bankTransaction?: {
        id: string;
        counterparty?: string | null;
        deviceSerial?: string | null;
      } | null;
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
      // The stored phone notification that claimed it — one unique-index
      // probe per row, included on every admin read.
      bankTransactionId: deposit.bankTransaction?.id ?? null,
      // M-16: the bank's "from" name, beside the depositor's own name in
      // the verification dialog. Staff only — a user never sees it.
      bankCounterparty: deposit.bankTransaction?.counterparty ?? null,
      // SEC-004: which phone captured the transfer — the dialog's "posted
      // by phone" line. Staff only.
      bankDeviceSerial: deposit.bankTransaction?.deviceSerial ?? null,
    };
  }
}
