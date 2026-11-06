import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { Prisma } from '../generated/prisma/client';
import type { BankTransaction } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { PaymentAccountEvents } from '../payment-accounts/payment-account-events';
import {
  pushBankTransactionChange,
  storeTransaction,
  type StoreBankEventInput,
} from '../bank-transactions/bank-transaction-store';
import type { BankEventResult } from './bank-event.types';
import { applyReceivedEvent } from './deposit-matcher';
import { applySentEvent } from './withdrawal-matcher';
import {
  BANK_TRANSACTION_LINK_INCLUDE,
  clearDepositScreenshotReason,
  depositVerificationPayload,
} from './deposit-risk';
import { pushWithdrawalVerificationUpdates } from './withdrawal-risk';
import type {
  BankEventBatchDto,
  BankEventDto,
} from './dto/bank-event-batch.dto';
import type { BankScreenshotDto } from './dto/bank-screenshot.dto';

/**
 * A phone screencap PNG is 0.3–2 MB; 5 MB leaves headroom and stops a
 * runaway upload. Enforced by the FileInterceptor on the controller.
 */
export const MAX_BANK_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** The 8-byte PNG signature — the only image type the phone-monitor produces. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Q15 cache: the same phone posts for the same business account all day,
 * so its existence/active check is answered from memory for a minute.
 */
const ACCOUNT_CACHE_TTL_MS = 60_000;

/** The one currency every money field in this app is in. */
const SUPPORTED_CURRENCY = 'MMK';

/**
 * DB-020: bank_transactions.amount is Decimal(12,2), so anything at or
 * above 10^10 would overflow inside the per-event transaction and be
 * answered `error` — which the phone retries for ever. The DTO already
 * caps the decimals at two, so "more than this" is exactly "≥ 10^10".
 */
const MAX_BANK_EVENT_AMOUNT = 9_999_999_999.99;

/** The legacy per-row upload routes — kept for the rollout window (see attachScreenshot). */
export type LegacyBankScreenshotKind = 'deposits' | 'withdrawals';

interface CachedAccount {
  isActive: boolean | null;
  expiresAt: number;
}

/** What one event's transaction hands back for the after-commit pushes. */
interface ProcessedEvent {
  result: BankEventResult;
  transactionId: string;
  created: boolean;
  transactionChanged: boolean;
  touchedDepositIds: string[];
  touchedWithdrawalIds: string[];
}

/**
 * Orchestrates one phone-monitor batch, STORE-FIRST: every event that
 * passes validation becomes a bank_transactions row before any matching
 * is tried, so the phone posts each event once and never retries a "no
 * match" — the deposit that carries the code claims the stored row the
 * moment it is created (DepositsService.create). Each event runs in ITS
 * OWN transaction (store + match + link commit or roll back together, and
 * one bad event never rolls back its neighbours); admin realtime updates
 * go out only after that transaction committed. Events are processed
 * sequentially so two events for the same account in one batch cannot
 * race each other for a row.
 */
@Injectable()
export class BankEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BankEventsService.name);
  private readonly accountCache = new Map<string, CachedAccount>();
  /** Bumped on every invalidation, so a read already in flight is not cached. */
  private accountCacheGeneration = 0;
  private accountChanges?: Subscription;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
    private readonly paymentAccountEvents: PaymentAccountEvents,
  ) {}

  /**
   * bam-16: an admin's create, edit or delete of a payment account clears
   * the account cache at once, so a deactivated account is refused from the
   * very next bank event instead of up to ACCOUNT_CACHE_TTL_MS later.
   */
  onModuleInit(): void {
    this.accountChanges = this.paymentAccountEvents.changes.subscribe(() =>
      this.invalidateAccountCache(),
    );
  }

  onModuleDestroy(): void {
    this.accountChanges?.unsubscribe();
  }

  async processBatch(
    dto: BankEventBatchDto,
  ): Promise<{ results: BankEventResult[] }> {
    const results: BankEventResult[] = [];
    for (const event of dto.events) {
      results.push(await this.processOne(event));
    }
    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {});
    // Counts and outcomes only — never amounts or codes in the log.
    this.logger.log(
      `batch of ${results.length}: ${Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
    return { results };
  }

  private async processOne(dto: BankEventDto): Promise<BankEventResult> {
    const rejected = (reason: string): BankEventResult => ({
      idempotencyKey: dto.idempotencyKey,
      outcome: 'rejected',
      reason,
    });

    if (dto.currency && dto.currency.toUpperCase() !== SUPPORTED_CURRENCY) {
      return rejected('UNSUPPORTED_CURRENCY');
    }
    if (dto.txCode.slice(-6) !== dto.txCodeLast6) {
      return rejected('LAST6_MISMATCH');
    }
    // A permanent answer (the phone marks the row failed, never retried):
    // no real KBZPay/WavePay transfer reaches this, only a parser slip.
    if (dto.amount > MAX_BANK_EVENT_AMOUNT) {
      return rejected('AMOUNT_OUT_OF_RANGE');
    }
    const account = await this.lookupAccount(dto.paymentAccountId);
    if (account.isActive === null) return rejected('UNKNOWN_PAYMENT_ACCOUNT');
    if (!account.isActive) return rejected('INACTIVE_PAYMENT_ACCOUNT');

    const input: StoreBankEventInput = {
      idempotencyKey: dto.idempotencyKey,
      deviceSerial: dto.deviceSerial,
      paymentAccountId: dto.paymentAccountId,
      direction: dto.direction,
      amount: new Prisma.Decimal(dto.amount),
      currency: SUPPORTED_CURRENCY,
      txCode: dto.txCode,
      txCodeLast6: dto.txCodeLast6,
      occurredAt: new Date(dto.occurredAt),
      postedAt: dto.postedAt ? new Date(dto.postedAt) : null,
      counterparty: dto.counterparty ?? null,
      detailStatus: dto.detailStatus ?? null,
    };

    try {
      const processed = await this.prisma.$transaction((tx) =>
        this.storeAndMatch(tx, input),
      );
      await this.pushDepositUpdates(processed.touchedDepositIds);
      await this.pushWithdrawalUpdates(processed.touchedWithdrawalIds);
      if (processed.created) {
        await this.pushTransaction(processed.transactionId, 'created');
      } else if (processed.transactionChanged) {
        await this.pushTransaction(processed.transactionId, 'updated');
      }
      return processed.result;
    } catch (error) {
      // The whole per-event transaction rolled back (store, claim and link
      // together), so nothing half-written survives; answer `error` so the
      // phone-monitor retries on its backoff. Every event is idempotent —
      // the retry either stores fresh or finds the stored row.
      this.logger.error(
        `event ${dto.idempotencyKey.slice(0, 12)}… failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        idempotencyKey: dto.idempotencyKey,
        outcome: 'error',
        reason: 'INTERNAL_ERROR',
      };
    }
  }

  /**
   * Q-BT0 store, then: a key already MATCHED answers already_stored with
   * its link and nothing re-runs; an UNMATCHED or AMBIGUOUS key (new, or
   * re-posted by the phone's Resend button) goes through its direction's
   * matcher. A parked "sent" row is also re-run from the staff side — an
   * approval whose window now holds it, a typed payout code that names it
   * (see withdrawal-matcher.ts) — so a payout's match does not depend on
   * the order of events.
   */
  private async storeAndMatch(
    tx: Prisma.TransactionClient,
    input: StoreBankEventInput,
  ): Promise<ProcessedEvent> {
    const { row, created } = await storeTransaction(tx, this.audit, input);
    const base = {
      transactionId: row.id,
      created,
      touchedDepositIds: [] as string[],
      touchedWithdrawalIds: [] as string[],
    };

    if (row.state === 'MATCHED') {
      return {
        ...base,
        result: await this.alreadyStoredResult(tx, row),
        transactionChanged: false,
      };
    }
    if (row.direction === 'RECEIVED') {
      const outcome = await applyReceivedEvent(tx, this.audit, row);
      return {
        ...base,
        result: outcome.result,
        transactionChanged: outcome.transactionChanged,
        touchedDepositIds: outcome.touchedDepositIds,
      };
    }
    const outcome = await applySentEvent(tx, this.audit, row);
    return {
      ...base,
      result: outcome.result,
      transactionChanged: outcome.transactionChanged,
      touchedWithdrawalIds: outcome.touchedWithdrawalIds,
    };
  }

  /** A MATCHED row re-posted: report the existing link (one PK read for its matchStatus). */
  private async alreadyStoredResult(
    tx: Prisma.TransactionClient,
    row: BankTransaction,
  ): Promise<BankEventResult> {
    const result: BankEventResult = {
      idempotencyKey: row.idempotencyKey,
      outcome: 'already_stored',
      transactionId: row.id,
      state: 'MATCHED',
      screenshotWanted: row.screenshotKey === null,
    };
    if (row.linkedDepositId) {
      const deposit = await tx.deposit.findUnique({
        where: { id: row.linkedDepositId },
        select: { matchStatus: true },
      });
      result.depositId = row.linkedDepositId;
      if (deposit) result.matchStatus = deposit.matchStatus;
    } else if (row.linkedWithdrawalId) {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: row.linkedWithdrawalId },
        select: { matchStatus: true },
      });
      result.withdrawalId = row.linkedWithdrawalId;
      if (withdrawal) result.matchStatus = withdrawal.matchStatus;
    }
    return result;
  }

  /** Q15 — payment_accounts_pkey, cached for a minute per id. */
  private async lookupAccount(
    id: string,
  ): Promise<{ isActive: boolean | null }> {
    const now = Date.now();
    const cached = this.accountCache.get(id);
    if (cached && cached.expiresAt > now) return cached;
    const generation = this.accountCacheGeneration;
    const account = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { isActive: true },
    });
    const entry: CachedAccount = {
      isActive: account ? account.isActive : null,
      expiresAt: now + ACCOUNT_CACHE_TTL_MS,
    };
    // An account change cleared the cache while this read was in flight:
    // the value may be from before the change, so use it but do not keep it.
    if (generation === this.accountCacheGeneration) {
      this.accountCache.set(id, entry);
    }
    return entry;
  }

  /** Forget cached account state — after every payment account change (see onModuleInit). */
  invalidateAccountCache(): void {
    this.accountCacheGeneration += 1;
    this.accountCache.clear();
  }

  /**
   * GET /bank-events/accounts — id + labels of active accounts, so the
   * phone-monitor's settings screen can offer a dropdown for its
   * serial→account map. No balances, no ledger.
   */
  async listActiveAccounts() {
    const accounts = await this.prisma.paymentAccount.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        subname: true,
        accountName: true,
        accountNumber: true,
      },
    });
    return accounts;
  }

  private assertPng(file: Express.Multer.File | undefined): Buffer {
    if (!file) {
      throw new BadRequestException(
        'No screenshot received (expected PNG field "file")',
      );
    }
    if (
      file.buffer.length < PNG_SIGNATURE.length ||
      !file.buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new BadRequestException('Screenshot must be a PNG image');
    }
    return file.buffer;
  }

  /**
   * POST /bank-events/transactions/:id/screenshot — the notification
   * screenshot, uploaded by the phone after EVERY stored reply (not only a
   * match). Stored once under the transaction's own folder (Q-BT7, guarded
   * `screenshotKey IS NULL`); when the row is linked, the deposit's /
   * withdrawal's own screenshot pointer is set to the SAME key so the
   * existing Verification Details stream keeps working — and when the link
   * comes later, the claim copies the key then. Idempotent per event key:
   * the key can only ever be the row's own, so a screenshot cannot land on
   * a transaction its event did not produce.
   */
  async attachTransactionScreenshot(
    transactionId: string,
    dto: BankScreenshotDto,
    file: Express.Multer.File | undefined,
  ): Promise<{ uploaded: boolean; alreadyUploaded?: boolean }> {
    const buffer = this.assertPng(file);

    const row = await this.prisma.bankTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!row) throw new NotFoundException('Bank transaction not found');
    if (row.idempotencyKey !== dto.idempotencyKey) {
      throw new ConflictException('EVENT_KEY_MISMATCH');
    }
    if (row.screenshotKey) return { uploaded: false, alreadyUploaded: true };

    const objectKey = this.storageService.bankScreenshotKey(
      'transactions',
      row.id,
      row.idempotencyKey,
    );
    await this.minioService.uploadBuffer(objectKey, buffer);

    const metadata = {
      source: 'phone-monitor',
      idempotencyKey: dto.idempotencyKey,
      deviceSerial: dto.deviceSerial ?? row.deviceSerial,
      bytes: buffer.length,
      bankTransactionId: row.id,
    };
    // One transaction for the pointer writes: the row's own (guarded on
    // "still none", so two concurrent uploads of the same event write the
    // column once — the object key is the same either way, so the loser's
    // bytes simply overwrite identical bytes) and, if linked, the deposit's
    // / withdrawal's, which must not be left behind if the row's succeeded.
    const attached = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.bankTransaction.updateMany({
        where: { id: row.id, screenshotKey: null },
        data: { screenshotKey: objectKey },
      });
      if (updated.count !== 1) return null;
      await this.audit.record({
        action: 'bank_transaction.screenshot_attach',
        actor: null,
        target: { type: 'bank_transaction', id: row.id },
        metadata,
        tx,
      });
      const linked = {
        depositId: null as string | null,
        withdrawalId: null as string | null,
      };
      if (row.linkedDepositId) {
        const deposit = await tx.deposit.updateMany({
          where: { id: row.linkedDepositId, receivingScreenshotKey: null },
          data: { receivingScreenshotKey: objectKey },
        });
        if (deposit.count === 1) {
          linked.depositId = row.linkedDepositId;
          await this.audit.record({
            action: 'deposit.bank_screenshot_attach',
            actor: null,
            target: { type: 'deposit', id: row.linkedDepositId },
            metadata,
            tx,
          });
        }
        // SEC-004: the deposit was claimed on the phone's text alone and
        // waits in PENDING_REVIEW (NO_SCREENSHOT) — the picture is here
        // now, so re-score it in the same transaction (a no-op when the
        // reason is not there, e.g. the pointer was already set).
        const rescored = await clearDepositScreenshotReason(
          tx,
          this.audit,
          row.linkedDepositId,
          {
            ...metadata,
            trigger: 'screenshot_attach',
            bankTransactionId: row.id,
          },
        );
        if (rescored) linked.depositId = row.linkedDepositId;
      } else if (row.linkedWithdrawalId) {
        const withdrawal = await tx.withdrawal.updateMany({
          where: { id: row.linkedWithdrawalId, transferScreenshotKey: null },
          data: { transferScreenshotKey: objectKey },
        });
        if (withdrawal.count === 1) {
          linked.withdrawalId = row.linkedWithdrawalId;
          await this.audit.record({
            action: 'withdrawal.bank_screenshot_attach',
            actor: null,
            target: { type: 'withdrawal', id: row.linkedWithdrawalId },
            metadata,
            tx,
          });
        }
      }
      return linked;
    });
    if (!attached) return { uploaded: false, alreadyUploaded: true };

    if (attached.depositId) await this.pushDepositUpdates([attached.depositId]);
    if (attached.withdrawalId) {
      await this.pushWithdrawalUpdates([attached.withdrawalId]);
    }
    await this.pushTransaction(row.id, 'updated');
    return { uploaded: true };
  }

  /**
   * @deprecated — remove after the phone-monitor is confirmed on the
   * transactions route. POST /bank-events/deposits/:id/screenshot and
   * /withdrawals/:id/screenshot, kept for the rollout window: the owner's
   * running phone-monitor build still targets them until it is restarted.
   * When the event key names a stored bank transaction the upload is
   * delegated to the transactions path (one object, both pointers);
   * otherwise it is the pre-bank_transactions behaviour — the deposit /
   * withdrawal must carry the event key from its match, and the object
   * lands in that row's own legacy folder.
   */
  async attachScreenshot(
    kind: LegacyBankScreenshotKind,
    rowId: string,
    dto: BankScreenshotDto,
    file: Express.Multer.File | undefined,
  ): Promise<{ uploaded: boolean; alreadyUploaded?: boolean }> {
    const stored = await this.prisma.bankTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      select: { id: true },
    });
    if (stored) return this.attachTransactionScreenshot(stored.id, dto, file);

    const buffer = this.assertPng(file);

    const row =
      kind === 'deposits'
        ? await this.prisma.deposit.findUnique({
            where: { id: rowId },
            select: {
              id: true,
              receivingEventKey: true,
              receivingScreenshotKey: true,
            },
          })
        : await this.prisma.withdrawal.findUnique({
            where: { id: rowId },
            select: {
              id: true,
              transferEventKey: true,
              transferScreenshotKey: true,
            },
          });
    if (!row) throw new NotFoundException('Row not found');

    const eventKey =
      'receivingEventKey' in row ? row.receivingEventKey : row.transferEventKey;
    const existingKey =
      'receivingScreenshotKey' in row
        ? row.receivingScreenshotKey
        : row.transferScreenshotKey;
    if (eventKey !== dto.idempotencyKey) {
      throw new ConflictException('EVENT_NOT_MATCHED_TO_ROW');
    }
    if (existingKey) return { uploaded: false, alreadyUploaded: true };

    const objectKey = this.storageService.bankScreenshotKey(
      kind,
      rowId,
      dto.idempotencyKey,
    );
    await this.minioService.uploadBuffer(objectKey, buffer);

    const metadata = {
      source: 'phone-monitor',
      idempotencyKey: dto.idempotencyKey,
      deviceSerial: dto.deviceSerial ?? null,
      bytes: buffer.length,
    };
    if (kind === 'deposits') {
      const updated = await this.prisma.deposit.updateMany({
        where: { id: rowId, receivingScreenshotKey: null },
        data: { receivingScreenshotKey: objectKey },
      });
      if (updated.count !== 1)
        return { uploaded: false, alreadyUploaded: true };
      await this.audit.record({
        action: 'deposit.bank_screenshot_attach',
        actor: null,
        target: { type: 'deposit', id: rowId },
        metadata,
      });
      await this.pushDepositUpdates([rowId]);
    } else {
      const updated = await this.prisma.withdrawal.updateMany({
        where: { id: rowId, transferScreenshotKey: null },
        data: { transferScreenshotKey: objectKey },
      });
      if (updated.count !== 1)
        return { uploaded: false, alreadyUploaded: true };
      await this.audit.record({
        action: 'withdrawal.bank_screenshot_attach',
        actor: null,
        target: { type: 'withdrawal', id: rowId },
        metadata,
      });
      await this.pushWithdrawalUpdates([rowId]);
    }
    return { uploaded: true };
  }

  /** Admins-room push for every touched deposit — after commit, by primary key. */
  private async pushDepositUpdates(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.deposit.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        bankCheckedAt: true,
        matchStatus: true,
        riskLevel: true,
        riskReasons: true,
        receivingAmount: true,
        receivingTransactionCode: true,
        receivingTransactionAt: true,
        receivingScreenshotKey: true,
        ...BANK_TRANSACTION_LINK_INCLUDE,
      },
    });
    for (const row of rows) {
      this.realtimeGateway.notifyAdminsDepositVerificationUpdated(
        depositVerificationPayload(row),
      );
    }
  }

  /** Shared with WithdrawalsService's look-backs — see pushWithdrawalVerificationUpdates. */
  private async pushWithdrawalUpdates(ids: readonly string[]): Promise<void> {
    await pushWithdrawalVerificationUpdates(
      this.prisma,
      this.realtimeGateway,
      ids,
    );
  }

  /** Q-BT8 — shared with WithdrawalsService's look-backs (pushBankTransactionChange). */
  private async pushTransaction(
    id: string,
    kind: 'created' | 'updated',
  ): Promise<void> {
    await pushBankTransactionChange(
      this.prisma,
      this.realtimeGateway,
      id,
      kind,
    );
  }
}
