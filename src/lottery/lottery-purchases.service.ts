import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import {
  LotteryPurchaseStatus,
  Prisma,
  TransactionType,
  type LotteryDraw,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { decimalToNumber } from '../common/utils/decimal.util';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { WalletService } from '../wallet/wallet.service';
import { DRAW_PAGE_SIZE_DEFAULT } from './dto/lottery-draw.dto';
import {
  type CreateLotteryPurchaseDto,
  type PurchaseLineDto,
  type PurchasePageQueryDto,
  type PurchaseStatusWire,
} from './dto/lottery-purchase.dto';
import { drawStatusToWire, LotteryDrawsService } from './lottery-draws.service';
import { LOTTERY_ERRORS, lotteryError } from './lottery-errors';
import { heldCounts, leftToBuy, offSaleNumbers } from './lottery-holdings';
import { isLotteryNumber } from './lottery-numbers';
import { nextPurchaseRefSeq, purchaseRef, ticketNo } from './lottery-refs';

/**
 * Every checkout of a draw queues on the draw's row lock, and the biggest
 * basket writes 1000 ticket rows. Prisma's defaults (2 s wait, 5 s run)
 * would kill a queued checkout at the sales-close rush with a bare 500,
 * which the phone would retry. 12 s stays under the app's 15 s request
 * timeout, so the server always answers before the app gives up.
 */
export const PURCHASE_TRANSACTION_MAX_WAIT_MS = 5_000;
export const PURCHASE_TRANSACTION_TIMEOUT_MS = 12_000;

/** A purchase as stored, with everything its wire shape needs. */
const PURCHASE_INCLUDE = {
  draw: { select: { drawNo: true } },
  lines: {
    orderBy: { number: 'asc' },
    select: { number: true, quantity: true },
  },
  tickets: {
    orderBy: { seq: 'asc' },
    select: { ticketNo: true, number: true },
  },
} satisfies Prisma.LotteryPurchaseInclude;

type StoredPurchase = Prisma.LotteryPurchaseGetPayload<{
  include: typeof PURCHASE_INCLUDE;
}>;

/** What `view` needs: the stored row, or the one just made (before any re-read). */
interface PurchaseSource {
  ref: string;
  status: LotteryPurchaseStatus;
  total: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  createdAt: Date;
  draw: { drawNo: number };
  lines: PurchaseLine[];
  tickets: Array<{ ticketNo: string; number: string }>;
}

export interface PurchaseLine {
  number: string;
  quantity: number;
}

/** One purchase as the apps draw it (the receipt). */
export interface PurchaseView {
  ref: string;
  drawNo: number;
  lines: PurchaseLine[];
  tickets: Array<{ ticketNo: string; number: string }>;
  total: number;
  unitPrice: number;
  status: PurchaseStatusWire;
  createdAt: Date;
}

/** The POST answer: the receipt plus the wallet after it. */
export interface PurchaseReceipt extends PurchaseView {
  balanceAfter: number;
}

export interface PurchasePage {
  items: PurchaseView[];
  total: number;
  page: number;
  pageSize: number;
}

/** Discriminated on `replayed` — a replay moved no money, so nothing is emitted. */
type CheckoutResult =
  | { replayed: true; purchase: StoredPurchase }
  | { replayed: false; purchase: PurchaseSource; balance: Prisma.Decimal };

const STATUS_TO_WIRE: Record<LotteryPurchaseStatus, PurchaseStatusWire> = {
  PAID: 'paid',
};

export const purchaseStatusToWire = (
  status: LotteryPurchaseStatus,
): PurchaseStatusWire => STATUS_TO_WIRE[status];

/**
 * Buying lottery tickets (lottery backend phase 2). One checkout = several
 * numbers with a quantity each, one wallet debit for the total, one
 * LOTTERY_PURCHASE transaction row, one purchase row with its lines, and
 * one ticket row per ticket. Everything happens inside ONE transaction
 * under the draw's row lock, so two checkouts of the same draw never hand
 * out the same ticket seq and the same customer can never pass the
 * per-number limit twice. Money moves the subscriptions way
 * (debitWithinTransaction + tx.transaction.create, the balance emitted
 * only after commit); retries are safe the wallet-adjustments way (one
 * purchase per (user, idempotencyKey), P2002 replayed).
 */
@Injectable()
export class LotteryPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly draws: LotteryDrawsService,
  ) {}

  /**
   * The checks run in the contract's order: draw exists (404) → the key
   * was not used yet (else the stored receipt comes back untouched) →
   * sales open right now → no number off sale → held + buying within the
   * per-number limit → enough in the wallet. Each refusal names its code
   * and particulars so the number window can say which number is the
   * problem. The time is checked here, never trusted to the closer cron.
   */
  async create(
    user: AuthenticatedUser,
    dto: CreateLotteryPurchaseDto,
    now = new Date(),
  ): Promise<PurchaseReceipt> {
    const lines = normaliseLines(dto.lines);
    const draw = await this.draws.findRowByDrawNo(dto.drawNo);

    let result: CheckoutResult;
    try {
      result = await this.prisma.$transaction(
        async (tx): Promise<CheckoutResult> => {
          // The fast path: a plain retry of a key already written never
          // waits for the draw lock.
          const existing = await this.findByKey(
            tx,
            user.id,
            dto.idempotencyKey,
          );
          if (existing) return { replayed: true, purchase: existing };
          return this.checkout(
            tx,
            user.id,
            draw,
            dto.idempotencyKey,
            lines,
            now,
          );
        },
        {
          maxWait: PURCHASE_TRANSACTION_MAX_WAIT_MS,
          timeout: PURCHASE_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      // Two sends of the same key at once: both pass the probe, the loser
      // hits the unique constraint — refetch the winner's row and replay it.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.findByKey(
          this.prisma,
          user.id,
          dto.idempotencyKey,
        );
        if (existing) return this.replay(existing, user.id, draw.id, lines);
      }
      throw error;
    }

    if (result.replayed) {
      return this.replay(result.purchase, user.id, draw.id, lines);
    }

    // After commit, like every other balance-changing flow: the wallet
    // pill in the apps refreshes without a reload.
    this.realtimeGateway.notifyUserBalanceUpdated(
      user.id,
      decimalToNumber(result.balance),
    );
    return {
      ...this.view(result.purchase),
      balanceAfter: decimalToNumber(result.balance),
    };
  }

  /** The caller's purchases, newest first. */
  async list(
    userId: string,
    query: PurchasePageQueryDto,
  ): Promise<PurchasePage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const [rows, total] = await Promise.all([
      this.prisma.lotteryPurchase.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: PURCHASE_INCLUDE,
      }),
      this.prisma.lotteryPurchase.count({ where: { userId } }),
    ]);
    return { items: rows.map((row) => this.view(row)), total, page, pageSize };
  }

  /** One of the caller's purchases by ref; anyone else's is 404 like a missing one. */
  async findOne(userId: string, ref: string): Promise<PurchaseView> {
    const row = await this.prisma.lotteryPurchase.findFirst({
      where: { ref, userId },
      include: PURCHASE_INCLUDE,
    });
    if (!row) {
      throw lotteryError(
        HttpStatus.NOT_FOUND,
        LOTTERY_ERRORS.PURCHASE_NOT_FOUND,
        'Purchase not found',
      );
    }
    return this.view(row);
  }

  view(row: PurchaseSource): PurchaseView {
    return {
      ref: row.ref,
      drawNo: row.draw.drawNo,
      lines: row.lines.map(({ number, quantity }) => ({ number, quantity })),
      tickets: row.tickets.map(({ ticketNo: no, number }) => ({
        ticketNo: no,
        number,
      })),
      total: decimalToNumber(row.total),
      unitPrice: decimalToNumber(row.unitPrice),
      status: purchaseStatusToWire(row.status),
      createdAt: row.createdAt,
    };
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /** The whole checkout, inside the caller's transaction. */
  private async checkout(
    tx: Prisma.TransactionClient,
    userId: string,
    found: LotteryDraw,
    idempotencyKey: string,
    lines: PurchaseLine[],
    now: Date,
  ): Promise<CheckoutResult> {
    // The draw row is the lock for its ticket seqs and its per-number
    // counts (session-revocation precedent): everything below reads the
    // draw as it is now, and every other checkout of it waits here.
    await tx.$queryRaw`SELECT "id" FROM "lottery_draws" WHERE "id" = ${found.id} FOR UPDATE`;
    // Probed again now that the lock is held: a second send of the same key
    // that waited here behind the first sees the first's committed row, and
    // replays it instead of re-running the checks against a draw and a
    // wallet that already include that purchase (a "limit" or "short"
    // refusal for a purchase that went through).
    const won = await this.findByKey(tx, userId, idempotencyKey);
    if (won) return { replayed: true, purchase: won };
    const draw = await tx.lotteryDraw.findUniqueOrThrow({
      where: { id: found.id },
    });
    if (!this.draws.isSellingNow(draw, now)) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.SALES_CLOSED,
        'Sales for this draw are closed',
        {
          status: drawStatusToWire(draw.status),
          salesCloseAt: draw.salesCloseAt.toISOString(),
        },
      );
    }

    const numbers = lines.map((line) => line.number);
    const offSale = await offSaleNumbers(tx, draw.id, numbers);
    if (offSale.size > 0) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.NUMBER_OFF_SALE,
        'Some of these numbers are not on sale',
        { details: { numbers: numbers.filter((n) => offSale.has(n)) } },
      );
    }

    const held = await heldCounts(tx, userId, draw.id, numbers);
    const over = lines.flatMap((line) => {
      const have = held.get(line.number) ?? 0;
      return have + line.quantity > draw.maxPerNumber
        ? [
            {
              number: line.number,
              held: have,
              left: leftToBuy(draw.maxPerNumber, have, false),
            },
          ]
        : [];
    });
    if (over.length > 0) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.LIMIT_EXCEEDED,
        `Up to ${draw.maxPerNumber} tickets per number`,
        { details: over },
      );
    }

    const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    const unitPrice = draw.ticketPrice;
    const total = unitPrice.mul(quantity);
    const wallet = await this.debit(tx, userId, total);

    const transaction = await tx.transaction.create({
      data: {
        userId,
        type: TransactionType.LOTTERY_PURCHASE,
        amount: total,
        status: 'COMPLETED',
      },
    });
    const ref = purchaseRef(await nextPurchaseRefSeq(tx), now);
    const purchase = await tx.lotteryPurchase.create({
      data: {
        ref,
        userId,
        drawId: draw.id,
        idempotencyKey,
        total,
        unitPrice,
        transactionId: transaction.id,
        lines: { create: lines },
      },
      select: { id: true, status: true, createdAt: true },
    });

    // The seqs are taken by bumping the draw's counter: the row after the
    // bump says where this purchase's run ends.
    const bumped = await tx.lotteryDraw.update({
      where: { id: draw.id },
      data: { nextTicketSeq: { increment: quantity } },
      select: { nextTicketSeq: true },
    });
    let seq = bumped.nextTicketSeq - quantity;
    const tickets: Prisma.LotteryTicketCreateManyInput[] = [];
    for (const line of lines) {
      for (let i = 0; i < line.quantity; i += 1) {
        tickets.push({
          ticketNo: ticketNo(draw.drawNo, seq),
          drawId: draw.id,
          purchaseId: purchase.id,
          userId,
          number: line.number,
          seq,
        });
        seq += 1;
      }
    }
    await tx.lotteryTicket.createMany({ data: tickets });

    return {
      replayed: false,
      purchase: {
        ref,
        status: purchase.status,
        total,
        unitPrice,
        createdAt: purchase.createdAt,
        draw: { drawNo: draw.drawNo },
        lines,
        tickets: tickets.map(({ ticketNo: no, number }) => ({
          ticketNo: no,
          number,
        })),
      },
      balance: wallet.balance,
    };
  }

  /** The purchase a (user, key) pair already paid for, if any. */
  private findByKey(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    idempotencyKey: string,
  ): Promise<StoredPurchase | null> {
    return client.lotteryPurchase.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      include: PURCHASE_INCLUDE,
    });
  }

  /**
   * WalletService refuses a short wallet with a plain BadRequestException;
   * the apps want the code and the figures, so it is re-thrown as
   * LOTTERY_INSUFFICIENT_BALANCE with { total, balance }. A missing wallet
   * stays the 404 it is.
   */
  private async debit(
    tx: Prisma.TransactionClient,
    userId: string,
    total: Prisma.Decimal,
  ) {
    try {
      return await this.walletService.debitWithinTransaction(
        tx,
        userId,
        total.toNumber(),
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        const wallet = await tx.wallet.findUnique({
          where: { userId },
          select: { balance: true },
        });
        throw lotteryError(
          HttpStatus.BAD_REQUEST,
          LOTTERY_ERRORS.INSUFFICIENT_BALANCE,
          'Not enough in your wallet',
          {
            details: {
              total: total.toNumber(),
              balance: decimalToNumber(wallet?.balance),
            },
          },
        );
      }
      throw error;
    }
  }

  /**
   * A retry of a key already written: the stored receipt comes back, with
   * the wallet as it stands now (the money went the first time). The same
   * key sent with a different draw or basket is a client bug, not a retry
   * — refused rather than answered with a receipt for something else.
   */
  private async replay(
    existing: StoredPurchase,
    userId: string,
    drawId: string,
    lines: PurchaseLine[],
  ): Promise<PurchaseReceipt> {
    const same =
      existing.drawId === drawId &&
      existing.lines.length === lines.length &&
      existing.lines.every(
        (line, index) =>
          line.number === lines[index].number &&
          line.quantity === lines[index].quantity,
      );
    if (!same) {
      throw lotteryError(
        HttpStatus.CONFLICT,
        LOTTERY_ERRORS.IDEMPOTENCY_MISMATCH,
        'This checkout key was already used for a different purchase',
        { ref: existing.ref },
      );
    }
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true },
    });
    return {
      ...this.view(existing),
      balanceAfter: decimalToNumber(wallet?.balance),
    };
  }
}

/**
 * The lines as the checkout works with them: six-digit numbers, each
 * once, sorted by number so the receipt (and the ticket seqs) read the
 * same whether fresh or re-read. The DTO already refuses bad input; this
 * keeps the service safe on its own and gives the contract's
 * LOTTERY_BAD_NUMBER a home.
 */
export function normaliseLines(
  lines: readonly PurchaseLineDto[],
): PurchaseLine[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (!isLotteryNumber(line.number) || seen.has(line.number)) {
      throw lotteryError(
        HttpStatus.BAD_REQUEST,
        LOTTERY_ERRORS.BAD_NUMBER,
        'Each number must be exactly 6 digits and appear only once',
        { number: line.number },
      );
    }
    seen.add(line.number);
  }
  return lines
    .map(({ number, quantity }) => ({ number, quantity }))
    .sort((a, b) => a.number.localeCompare(b.number));
}
