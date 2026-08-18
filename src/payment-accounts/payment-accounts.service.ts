import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Permission } from '../roles/permission.enum';
import { roleHasPermission } from '../roles/role-permissions.map';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { CreatePaymentAccountDto } from './dto/create-payment-account.dto';
import type { UpdatePaymentAccountDto } from './dto/update-payment-account.dto';
import type { CreatePaymentMethodTypeDto } from './dto/create-payment-method-type.dto';
import type { UpdatePaymentMethodTypeDto } from './dto/update-payment-method-type.dto';
import type { PaymentAccountTransactionQueryDto } from './dto/payment-account-transaction-query.dto';
import type { AllPaymentAccountTransactionsQueryDto } from './dto/all-payment-account-transactions-query.dto';
import type { CreateManualPaymentAccountTransactionDto } from './dto/create-manual-payment-account-transaction.dto';
import { PaymentAccountLedgerService } from './payment-account-ledger.service';

const ADMIN_INCLUDE = {
  createdBy: { select: { id: true, username: true } },
  updatedBy: { select: { id: true, username: true } },
} satisfies Prisma.PaymentAccountInclude;

type AdminRow = Prisma.PaymentAccountGetPayload<{
  include: typeof ADMIN_INCLUDE;
}>;
type PublicRow = Pick<
  AdminRow,
  'id' | 'type' | 'accountName' | 'accountNumber' | 'bankName' | 'note'
>;

/**
 * The customer on a deposit/withdrawal. Phone signups get a machine-generated
 * username (`user_959…`), so that alone reads as anonymous — the phone,
 * avatar, account status and wallet balance are what actually let an admin
 * tell *who* this is and whether the account is in good standing, without
 * leaving the transaction.
 */
const USER_REF = {
  select: {
    id: true,
    username: true,
    phone: true,
    avatar: true,
    role: true,
    status: true,
    createdAt: true,
    lastLoginAt: true,
    wallet: { select: { balance: true } },
  },
} as const;
const STAFF_REF = { select: { id: true, username: true } } as const;
const ACCOUNT_REF = {
  select: { id: true, type: true, subname: true, accountName: true },
} as const;

/**
 * Joins everything the admin transaction-details panel can show in the same
 * query that lists the rows. A ledger row on its own only records *that*
 * money moved — the deposit/withdrawal it came from is what explains **why**,
 * and who it was for. Pulling both in here is what lets an admin open a row
 * and read the whole story without navigating to the Deposits or Withdrawals
 * page to reconstruct it.
 */
const TRANSACTION_INCLUDE = {
  paymentAccount: {
    select: {
      id: true,
      type: true,
      subname: true,
      accountName: true,
      accountNumber: true,
      bankName: true,
      note: true,
      isActive: true,
    },
  },
  performedBy: { select: { id: true, username: true, role: true } },
  relatedDeposit: {
    include: {
      user: USER_REF,
      approvedBy: STAFF_REF,
      declaredPaymentAccount: ACCOUNT_REF,
      receivingPaymentAccount: ACCOUNT_REF,
    },
  },
  relatedWithdrawal: {
    include: {
      user: USER_REF,
      approvedBy: STAFF_REF,
      transferPaymentAccount: ACCOUNT_REF,
    },
  },
} satisfies Prisma.PaymentAccountTransactionInclude;

type TransactionRow = Prisma.PaymentAccountTransactionGetPayload<{
  include: typeof TRANSACTION_INCLUDE;
}>;
type TransactionCustomer = NonNullable<TransactionRow['relatedDeposit']>['user'];

@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentAccountLedgerService: PaymentAccountLedgerService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly minioService: MinioService,
  ) {}

  /**
   * Same "one endpoint, row+field-shaped by viewer role" idiom already used
   * by subscription plans / movies / series: a caller without
   * PAYMENT_ACCOUNT_MANAGE, WITHDRAWAL_MANAGE, or DEPOSIT_MANAGE only ever
   * sees active accounts, and only the fields they actually need to send a
   * deposit to — never audit metadata (who created/edited it, when, or its
   * active/inactive history) or `subname` (the internal label). Withdrawal
   * and deposit reviewers also get the admin shape — despite lacking
   * PAYMENT_ACCOUNT_MANAGE itself — because recording which of our accounts
   * sent a payout or received a deposit (see TransferAccountCell /
   * ReceivingAccountCell in the admin app) needs to tell same-type accounts
   * apart by their subname.
   */
  async findAll(viewerRole: Role) {
    const canManage =
      roleHasPermission(viewerRole, Permission.PAYMENT_ACCOUNT_MANAGE) ||
      roleHasPermission(viewerRole, Permission.WITHDRAWAL_MANAGE) ||
      roleHasPermission(viewerRole, Permission.DEPOSIT_MANAGE);

    if (!canManage) {
      const accounts = await this.prisma.paymentAccount.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      return accounts.map((a) => this.toPublicResponse(a));
    }

    const accounts = await this.prisma.paymentAccount.findMany({
      orderBy: { createdAt: 'asc' },
      include: ADMIN_INCLUDE,
    });
    return accounts.map((a) => this.toAdminResponse(a));
  }

  async getTypes() {
    const types = await this.prisma.paymentMethodType.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return types.map((t) => this.toTypeResponse(t));
  }

  async createType(dto: CreatePaymentMethodTypeDto) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { label: dto.label },
    });
    if (existing) {
      throw new ConflictException(
        'A payment method with this name already exists',
      );
    }
    const created = await this.prisma.paymentMethodType.create({
      data: {
        label: dto.label,
        requiresBankName: dto.requiresBankName ?? false,
        logoUrl: dto.logoUrl,
      },
    });
    return this.toTypeResponse(created);
  }

  async updateType(id: string, dto: UpdatePaymentMethodTypeDto) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Payment method not found');

    const nextLabel = dto.label !== undefined ? dto.label : existing.label;
    if (nextLabel !== existing.label) {
      const clash = await this.prisma.paymentMethodType.findUnique({
        where: { label: nextLabel },
      });
      if (clash) {
        throw new ConflictException(
          'A payment method with this name already exists',
        );
      }
    }

    if (nextLabel !== existing.label) {
      // Renaming propagates to every account currently on this method, so
      // the catalog and existing accounts never drift out of sync — the
      // whole point of "label is the single source of truth" (see the
      // PaymentAccount.type doc comment in schema.prisma).
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.paymentAccount.updateMany({
          where: { type: existing.label },
          data: { type: nextLabel },
        });
        return tx.paymentMethodType.update({
          where: { id },
          data: {
            label: nextLabel,
            requiresBankName: dto.requiresBankName,
            logoUrl: dto.logoUrl,
          },
        });
      });
      return this.toTypeResponse(updated);
    }

    const updated = await this.prisma.paymentMethodType.update({
      where: { id },
      data: { requiresBankName: dto.requiresBankName, logoUrl: dto.logoUrl },
    });
    return this.toTypeResponse(updated);
  }

  async removeType(id: string) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Payment method not found');

    const accountsInUse = await this.prisma.paymentAccount.count({
      where: { type: existing.label },
    });
    if (accountsInUse > 0) {
      throw new ConflictException(
        `${accountsInUse} payment account(s) still use this method. Delete or reassign them first.`,
      );
    }

    await this.prisma.paymentMethodType.delete({ where: { id } });
    return { deleted: true };
  }

  async findOne(id: string) {
    const account = await this.prisma.paymentAccount.findUnique({
      where: { id },
      include: ADMIN_INCLUDE,
    });
    if (!account) throw new NotFoundException('Payment account not found');
    return this.toAdminResponse(account);
  }

  async create(dto: CreatePaymentAccountDto, actorUserId: string) {
    const account = await this.prisma.paymentAccount.create({
      data: {
        ...dto,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      include: ADMIN_INCLUDE,
    });
    return this.toAdminResponse(account);
  }

  async update(id: string, dto: UpdatePaymentAccountDto, actorUserId: string) {
    await this.assertExists(id);
    const account = await this.prisma.paymentAccount.update({
      where: { id },
      data: { ...dto, updatedByUserId: actorUserId },
      include: ADMIN_INCLUDE,
    });
    return this.toAdminResponse(account);
  }

  async remove(id: string) {
    await this.assertExists(id);
    const inUse = await this.prisma.paymentAccountTransaction.count({
      where: { paymentAccountId: id },
    });
    if (inUse > 0) {
      throw new ConflictException(
        'This account has transaction history and cannot be deleted. Deactivate it instead.',
      );
    }
    await this.prisma.paymentAccount.delete({ where: { id } });
    return { deleted: true };
  }

  /** Manual Add/Remove Money — delegates the actual balance/ledger write to PaymentAccountLedgerService, then formats the response. */
  async recordTransaction(
    accountId: string,
    dto: CreateManualPaymentAccountTransactionDto,
    actorUserId: string,
  ) {
    const { account, entry } = await this.paymentAccountLedgerService.recordManualEntry(
      accountId,
      dto,
      actorUserId,
    );
    // recordManualEntry owns and has already committed its own transaction
    // by the time we're back here, so it's safe to notify now.
    this.realtimeGateway.notifyAdminsPaymentAccountUpdated({ paymentAccountId: accountId });
    return {
      account: this.toAdminResponse({
        ...account,
        createdBy: null,
        updatedBy: null,
      }),
      entry: {
        id: entry.id,
        paymentAccountId: entry.paymentAccountId,
        type: entry.type,
        amount: decimalToNumber(entry.amount),
        balanceBefore: decimalToNumber(entry.balanceBefore),
        balanceAfter: decimalToNumber(entry.balanceAfter),
        referenceCode: entry.referenceCode,
        note: entry.note,
        relatedDepositId: entry.relatedDepositId,
        relatedWithdrawalId: entry.relatedWithdrawalId,
        performedByUserId: entry.performedByUserId,
        createdAt: entry.createdAt,
      },
    };
  }

  /** Per-account transaction history — backs the detail page's history table. */
  async getTransactions(accountId: string, query: PaymentAccountTransactionQueryDto) {
    await this.assertExists(accountId);
    return this.queryTransactions({ ...query, paymentAccountId: accountId });
  }

  /** Cross-account transaction view — backs the central transactions page. */
  async getAllTransactions(query: AllPaymentAccountTransactionsQueryDto) {
    return this.queryTransactions(query);
  }

  private async queryTransactions(
    query: PaymentAccountTransactionQueryDto & { paymentAccountId?: string },
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentAccountTransactionWhereInput = {
      paymentAccountId: query.paymentAccountId,
      type: query.type,
      createdAt:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
              lte: query.dateTo ? new Date(query.dateTo) : undefined,
            }
          : undefined,
      amount:
        query.amountMin !== undefined || query.amountMax !== undefined
          ? { gte: query.amountMin, lte: query.amountMax }
          : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentAccountTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: TRANSACTION_INCLUDE,
      }),
      this.prisma.paymentAccountTransaction.count({ where }),
    ]);

    return {
      items: items.map((t) => this.toTransactionResponse(t)),
      total,
      page,
      limit,
    };
  }

  /**
   * Deliberately passes through every column on the row and its related
   * records rather than a hand-picked subset — the details panel's whole
   * purpose is completeness, and a field omitted here is a field an admin
   * can't see anywhere. Only Decimals need touching, since they'd otherwise
   * serialize as strings.
   */
  private toTransactionResponse(t: TransactionRow) {
    return {
      id: t.id,
      paymentAccountId: t.paymentAccountId,
      paymentAccount: t.paymentAccount,
      type: t.type,
      amount: decimalToNumber(t.amount),
      balanceBefore: decimalToNumber(t.balanceBefore),
      balanceAfter: decimalToNumber(t.balanceAfter),
      referenceCode: t.referenceCode,
      note: t.note,
      relatedDepositId: t.relatedDepositId,
      relatedWithdrawalId: t.relatedWithdrawalId,
      performedByUserId: t.performedByUserId,
      performedBy: t.performedBy,
      createdAt: t.createdAt,
      relatedDeposit: t.relatedDeposit
        ? {
            ...t.relatedDeposit,
            amount: decimalToNumber(t.relatedDeposit.amount),
            // Numbers-or-null like DepositsService.toResponse: null means the
            // snapshot was never captured, distinguishable from a real 0.
            walletBalanceBefore:
              t.relatedDeposit.walletBalanceBefore == null
                ? null
                : decimalToNumber(t.relatedDeposit.walletBalanceBefore),
            walletBalanceAfter:
              t.relatedDeposit.walletBalanceAfter == null
                ? null
                : decimalToNumber(t.relatedDeposit.walletBalanceAfter),
            user: this.toCustomer(t.relatedDeposit.user),
          }
        : null,
      relatedWithdrawal: t.relatedWithdrawal
        ? {
            ...t.relatedWithdrawal,
            amount: decimalToNumber(t.relatedWithdrawal.amount),
            user: this.toCustomer(t.relatedWithdrawal.user),
          }
        : null,
    };
  }

  /**
   * Flattens the wallet join to a plain balance — a user with no wallet row
   * yet reports null, not 0, since those mean different things. The raw
   * avatar object key is replaced by a per-request playback URL.
   */
  private toCustomer(user: TransactionCustomer) {
    const { wallet, avatar, ...rest } = user;
    return {
      ...rest,
      avatarUrl: avatar ? this.minioService.playbackUrl(avatar) : null,
      walletBalance: wallet ? decimalToNumber(wallet.balance) : null,
    };
  }

  private async assertExists(id: string) {
    const exists = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Payment account not found');
  }

  private toPublicResponse(a: PublicRow) {
    return {
      id: a.id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      note: a.note,
    };
  }

  private toAdminResponse(a: AdminRow) {
    return {
      id: a.id,
      type: a.type,
      subname: a.subname,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      note: a.note,
      isActive: a.isActive,
      balance: decimalToNumber(a.balance),
      totalIn: decimalToNumber(a.totalIn),
      totalOut: decimalToNumber(a.totalOut),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      createdBy: a.createdBy,
      updatedBy: a.updatedBy,
    };
  }

  /**
   * `value` is kept alongside `label` purely for client-shape backward
   * compatibility (types.find(t => t.value === account.type)) — the two
   * are always identical, since `label` itself is what's stored in
   * PaymentAccount.type. Every mutation (create/update) must go through
   * this too, not just getTypes() — returning a raw Prisma row instead
   * silently drops `value`, which breaks selecting the freshly
   * created/renamed method in the admin UI until the next refetch.
   */
  private toTypeResponse(t: {
    id: string;
    label: string;
    requiresBankName: boolean;
    logoUrl: string | null;
  }) {
    return {
      id: t.id,
      value: t.label,
      label: t.label,
      requiresBankName: t.requiresBankName,
      logoUrl: this.minioService.imageUrl(t.logoUrl),
    };
  }
}
