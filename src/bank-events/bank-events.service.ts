import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import type { BankEventResult, NormalizedBankEvent } from './bank-event.types';
import { applyReceivedEvent } from './deposit-matcher';
import { applySentEvent } from './withdrawal-matcher';
import { depositVerificationPayload } from './deposit-risk';
import { withdrawalVerificationPayload } from './withdrawal-risk';
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

export type BankScreenshotKind = 'deposits' | 'withdrawals';

interface CachedAccount {
  isActive: boolean | null;
  expiresAt: number;
}

/**
 * Orchestrates one phone-monitor batch: validates each event's account and
 * shape, runs the matching direction's matcher in ITS OWN transaction, and
 * pushes admin realtime updates only after that transaction committed.
 * Events are processed sequentially so two events for the same account in
 * one batch cannot race each other for a row.
 */
@Injectable()
export class BankEventsService {
  private readonly logger = new Logger(BankEventsService.name);
  private readonly accountCache = new Map<string, CachedAccount>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly minioService: MinioService,
    private readonly storageService: StorageService,
  ) {}

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
    const account = await this.lookupAccount(dto.paymentAccountId);
    if (account.isActive === null) return rejected('UNKNOWN_PAYMENT_ACCOUNT');
    if (!account.isActive) return rejected('INACTIVE_PAYMENT_ACCOUNT');

    const event: NormalizedBankEvent = {
      idempotencyKey: dto.idempotencyKey,
      deviceSerial: dto.deviceSerial,
      paymentAccountId: dto.paymentAccountId,
      direction: dto.direction,
      amount: new Prisma.Decimal(dto.amount),
      txCode: dto.txCode,
      txCodeLast6: dto.txCodeLast6,
      occurredAt: new Date(dto.occurredAt),
    };

    try {
      if (event.direction === 'received') {
        const outcome = await this.prisma.$transaction((tx) =>
          applyReceivedEvent(tx, this.audit, event),
        );
        await this.pushDepositUpdates(outcome.touchedDepositIds);
        return outcome.result;
      }
      const outcome = await this.prisma.$transaction((tx) =>
        applySentEvent(tx, this.audit, event),
      );
      await this.pushWithdrawalUpdates(outcome.touchedWithdrawalIds);
      return outcome.result;
    } catch (error) {
      // One event's transient failure must not fail its neighbours, and it
      // is not permanent: answer no_match so the phone-monitor retries on
      // its schedule. Every event is idempotent, so a retry is safe.
      this.logger.error(
        `event ${dto.idempotencyKey.slice(0, 12)}… failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        idempotencyKey: dto.idempotencyKey,
        outcome: 'no_match',
        reason: 'INTERNAL_ERROR',
      };
    }
  }

  /** Q15 — payment_accounts_pkey, cached for a minute per id. */
  private async lookupAccount(
    id: string,
  ): Promise<{ isActive: boolean | null }> {
    const now = Date.now();
    const cached = this.accountCache.get(id);
    if (cached && cached.expiresAt > now) return cached;
    const account = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { isActive: true },
    });
    const entry: CachedAccount = {
      isActive: account ? account.isActive : null,
      expiresAt: now + ACCOUNT_CACHE_TTL_MS,
    };
    this.accountCache.set(id, entry);
    return entry;
  }

  /** Forget cached account state (tests, or after an account edit). */
  invalidateAccountCache(): void {
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

  /**
   * Attach the bank-notification screenshot to the row an event matched.
   * Idempotent per event key: a second upload for a row that already has
   * one uploads nothing. The key can only ever be the one on the row, so a
   * screenshot cannot be attached to a row its event did not match.
   */
  async attachScreenshot(
    kind: BankScreenshotKind,
    rowId: string,
    dto: BankScreenshotDto,
    file: Express.Multer.File | undefined,
  ): Promise<{ uploaded: boolean; alreadyUploaded?: boolean }> {
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
    await this.minioService.uploadBuffer(objectKey, file.buffer);

    const metadata = {
      source: 'phone-monitor',
      idempotencyKey: dto.idempotencyKey,
      deviceSerial: dto.deviceSerial ?? null,
      bytes: file.buffer.length,
    };
    if (kind === 'deposits') {
      // Guarded on "still no screenshot" so two concurrent uploads of the
      // same event write the column once; the object key is the same either
      // way, so the loser's bytes simply overwrite identical bytes.
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
      },
    });
    for (const row of rows) {
      this.realtimeGateway.notifyAdminsDepositVerificationUpdated(
        depositVerificationPayload(row),
      );
    }
  }

  private async pushWithdrawalUpdates(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.withdrawal.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        status: true,
        approvedAt: true,
        bankCheckedAt: true,
        matchStatus: true,
        riskLevel: true,
        riskReasons: true,
        transferAmount: true,
        transferTransactionCode: true,
        transferTransactionAt: true,
        transferScreenshotKey: true,
      },
    });
    for (const row of rows) {
      this.realtimeGateway.notifyAdminsWithdrawalVerificationUpdated(
        withdrawalVerificationPayload(row),
      );
    }
  }
}
