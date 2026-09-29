import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { BankTransaction } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MinioService } from '../common/storage/minio.service';
import { UNCLAIMED_AFTER_MS } from '../bank-events/risk-rules';
import { bankTransactionPayload } from './bank-transaction-store';
import type { BankTransactionQueryDto } from './dto/bank-transaction-query.dto';

/**
 * An exact count over an unbounded range would scale with rows; the list
 * only needs "is there another page" and a number the admin can read, so
 * the count stops at this many index entries and the response says it
 * was capped ("10,000+ — narrow the filters").
 */
export const LIST_COUNT_CAP = 10_000;

/** Same idea per phone: a lifetime total beyond this reads "1000+". */
export const DEVICE_TOTAL_CAP = 1_000;

/** The devices list is a loose index scan — one probe per DISTINCT serial — bounded here. */
export const MAX_DEVICES = 100;

const ACCOUNT_LABEL_SELECT = {
  type: true,
  subname: true,
  accountName: true,
} satisfies Prisma.PaymentAccountSelect;

type ListedRow = BankTransaction & {
  paymentAccount: {
    type: string;
    subname: string | null;
    accountName: string;
  } | null;
};

/**
 * The staff read side of bank_transactions. Every read is one index
 * probe or one bounded index range (the query notes name the index per
 * filter combination); nothing here walks the table and no exact count
 * is ever taken over an unbounded set.
 */
@Injectable()
export class BankTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * Q-BT4 — the admin list. A page of ids from whichever composite index
   * leads with the given equality (all four are `(…, occurredAt DESC)`, so
   * ORDER BY and the date range come free and the scan stops after
   * limit+offset entries), then a primary-key fetch of exactly those rows
   * with their account label. The state tabs and the date range are
   * written as literal SQL with only the values bound. Work = the rows of
   * that phone / account / state inside the window up to the page — never
   * table size. The count is capped (LIST_COUNT_CAP) for the same reason.
   */
  async findAll(query: BankTransactionQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const now = new Date();
    const predicate = this.predicate(query, now);

    const [idRows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM bank_transactions WHERE ${predicate}
          ORDER BY "occurredAt" DESC, id DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ),
      // The ORDER BY inside the capped subquery is not cosmetic: without
      // it the planner may satisfy `LIMIT 10001` with a sequential scan
      // that starts at the OLDEST heap pages, so a recent date range reads
      // the whole table before it finds a match (proven at 200k rows,
      // 2026-09-23). Ordered by occurredAt DESC the only cheap plan is the
      // same (…, occurredAt DESC) index the id page uses, which stops after
      // 10 001 entries.
      this.prisma.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT count(*)::int AS n FROM (
            SELECT 1 FROM bank_transactions WHERE ${predicate}
            ORDER BY "occurredAt" DESC LIMIT ${LIST_COUNT_CAP + 1}
          ) c`,
      ),
    ]);
    const ids = idRows.map((row) => row.id);
    const counted = Number(countRows[0]?.n ?? 0);
    const totalCapped = counted > LIST_COUNT_CAP;
    const total = totalCapped ? LIST_COUNT_CAP : counted;
    if (ids.length === 0) return { items: [], total, totalCapped, page, limit };

    const rows = await this.prisma.bankTransaction.findMany({
      where: { id: { in: ids } },
      include: { paymentAccount: { select: ACCOUNT_LABEL_SELECT } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => this.toItem(row, now));
    return { items, total, totalCapped, page, limit };
  }

  /**
   * The shared WHERE. The planner picks the index whose leading column
   * matches the given equality: deviceSerial → (deviceSerial, occurredAt);
   * else paymentAccountId → (paymentAccountId, occurredAt); else a state
   * tab → (state, occurredAt) — waiting/unclaimed are one contiguous
   * occurredAt range of the UNMATCHED band; else a direction alone →
   * (direction, occurredAt); else (occurredAt) alone. `direction` is bound
   * with a cast, which is fine: it is a plain equality on a leading key,
   * not a partial-index predicate that has to be proven.
   */
  private predicate(query: BankTransactionQueryDto, now: Date): Prisma.Sql {
    const cutoff = new Date(now.getTime() - UNCLAIMED_AFTER_MS);
    const parts: Prisma.Sql[] = [Prisma.sql`1=1`];
    if (query.deviceSerial) {
      parts.push(Prisma.sql`"deviceSerial" = ${query.deviceSerial}`);
    }
    if (query.paymentAccountId) {
      parts.push(Prisma.sql`"paymentAccountId" = ${query.paymentAccountId}`);
    }
    if (query.direction) {
      parts.push(
        Prisma.sql`direction = ${query.direction}::"BankTransactionDirection"`,
      );
    }
    switch (query.state) {
      case 'matched':
        parts.push(Prisma.sql`state = 'MATCHED'::"BankTransactionState"`);
        break;
      case 'ambiguous':
        parts.push(Prisma.sql`state = 'AMBIGUOUS'::"BankTransactionState"`);
        break;
      case 'unmatched':
        parts.push(
          Prisma.sql`state = 'UNMATCHED'::"BankTransactionState" AND "occurredAt" >= ${cutoff}`,
        );
        break;
      case 'unclaimed':
        parts.push(
          Prisma.sql`state = 'UNMATCHED'::"BankTransactionState" AND "occurredAt" < ${cutoff}`,
        );
        break;
      default:
        break;
    }
    if (query.from) {
      parts.push(Prisma.sql`"occurredAt" >= ${new Date(query.from)}`);
    }
    if (query.to) {
      parts.push(Prisma.sql`"occurredAt" <= ${new Date(query.to)}`);
    }
    return Prisma.join(parts, ' AND ');
  }

  /** Q-BT5 — one row by primary key. */
  async findOne(id: string) {
    const row = await this.prisma.bankTransaction.findUnique({
      where: { id },
      include: { paymentAccount: { select: ACCOUNT_LABEL_SELECT } },
    });
    if (!row) throw new NotFoundException('Bank transaction not found');
    return this.toItem(row, new Date());
  }

  /**
   * Q-BT6 — the phones that have ever posted. Postgres has no skip-scan,
   * so DISTINCT would walk the whole index; the recursive CTE below is the
   * textbook loose index scan instead: one probe of
   * bank_transactions_deviceSerial_occurredAt_idx per DISTINCT serial
   * (phones are a handful), capped at MAX_DEVICES. Per serial, three
   * bounded range reads of the same index: last seen (first entry), the
   * last 24 h (one phone's day) and a lifetime total capped at
   * DEVICE_TOTAL_CAP — an exact lifetime count would scale with rows.
   */
  async listDevices() {
    const serialRows = await this.prisma.$queryRaw<{ deviceSerial: string }[]>(
      Prisma.sql`WITH RECURSIVE d AS (
          (SELECT "deviceSerial" FROM bank_transactions ORDER BY "deviceSerial" LIMIT 1)
          UNION ALL
          SELECT (SELECT "deviceSerial" FROM bank_transactions t
                   WHERE t."deviceSerial" > d."deviceSerial"
                   ORDER BY "deviceSerial" LIMIT 1)
            FROM d WHERE d."deviceSerial" IS NOT NULL
        )
        SELECT "deviceSerial" FROM d WHERE "deviceSerial" IS NOT NULL LIMIT ${MAX_DEVICES}`,
    );
    const since = new Date(Date.now() - 24 * 3_600_000);
    const items: {
      deviceSerial: string;
      lastSeenAt: Date | null;
      last24hCount: number;
      total: number;
      totalCapped: boolean;
    }[] = [];
    for (const { deviceSerial } of serialRows) {
      const [stats] = await this.prisma.$queryRaw<
        { lastSeenAt: Date | null; last24hCount: number; total: number }[]
      >(
        Prisma.sql`SELECT
            (SELECT "occurredAt" FROM bank_transactions
              WHERE "deviceSerial" = ${deviceSerial}
              ORDER BY "occurredAt" DESC LIMIT 1) AS "lastSeenAt",
            (SELECT count(*)::int FROM bank_transactions
              WHERE "deviceSerial" = ${deviceSerial} AND "occurredAt" >= ${since}) AS "last24hCount",
            (SELECT count(*)::int FROM (
               SELECT 1 FROM bank_transactions
                WHERE "deviceSerial" = ${deviceSerial} LIMIT ${DEVICE_TOTAL_CAP + 1}
             ) c) AS "total"`,
      );
      const counted = Number(stats?.total ?? 0);
      items.push({
        deviceSerial,
        lastSeenAt: stats?.lastSeenAt ?? null,
        last24hCount: Number(stats?.last24hCount ?? 0),
        total: Math.min(counted, DEVICE_TOTAL_CAP),
        totalCapped: counted > DEVICE_TOTAL_CAP,
      });
    }
    return { items };
  }

  /**
   * GET /bank-transactions/:id/screenshot — the notification screenshot,
   * streamed from private storage to a staff member holding
   * BANK_TRANSACTIONS.BANK_EVIDENCE. Never a URL: the object lives under
   * documents/, which the cache server denies and nothing can sign.
   */
  async getScreenshot(id: string): Promise<StreamableFile> {
    const row = await this.prisma.bankTransaction.findUnique({
      where: { id },
      select: { screenshotKey: true },
    });
    if (!row) throw new NotFoundException('Bank transaction not found');
    if (!row.screenshotKey) {
      throw new NotFoundException('This bank transaction has no screenshot');
    }
    const object = await this.minioService.getObjectStream(row.screenshotKey);
    if (!object) {
      throw new NotFoundException('This bank transaction has no screenshot');
    }
    return new StreamableFile(object.stream, {
      type: 'image/png',
      disposition: `inline; filename="bank-transaction-${id}.png"`,
      ...(object.contentLength !== null && { length: object.contentLength }),
    });
  }

  /** The list/detail item: the realtime payload plus the account label. The screenshot key never leaves the server. */
  private toItem(row: ListedRow, now: Date) {
    return {
      ...bankTransactionPayload(row, now),
      paymentAccount: row.paymentAccount
        ? {
            type: row.paymentAccount.type,
            subname: row.paymentAccount.subname,
            accountName: row.paymentAccount.accountName,
          }
        : null,
    };
  }
}
