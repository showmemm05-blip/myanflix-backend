import { Injectable } from '@nestjs/common';
import {
  LotteryDrawStatus,
  type LotteryDraw,
  type LotteryTicketStatus,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { MinioService } from '../common/storage/minio.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  type DrawPageQueryDto,
  type DrawStatusWire,
  type TicketStatusWire,
} from './dto/lottery-draw.dto';
import { drawNotFound } from './lottery-errors';
import { heldCounts, leftToBuy, offSaleNumbers } from './lottery-holdings';
import { toDateString } from './lottery-time';

const STATUS_TO_WIRE: Record<LotteryDrawStatus, DrawStatusWire> = {
  SCHEDULED: 'scheduled',
  OPEN: 'open',
  PAUSED: 'paused',
  CLOSED: 'closed',
  PUBLISHED: 'published',
};

export const drawStatusToWire = (status: LotteryDrawStatus): DrawStatusWire =>
  STATUS_TO_WIRE[status];

export const drawStatusFromWire = (status: DrawStatusWire): LotteryDrawStatus =>
  status.toUpperCase() as LotteryDrawStatus;

const TICKET_STATUS_TO_WIRE: Record<LotteryTicketStatus, TicketStatusWire> = {
  WAITING: 'waiting',
  WON: 'won',
  NOT_WON: 'notwon',
};

/** Shared by the admin ticket list and the purchases / tickets services. */
export const ticketStatusToWire = (
  status: LotteryTicketStatus,
): TicketStatusWire => TICKET_STATUS_TO_WIRE[status];

/** The draw statuses that are selling (or could resume selling). */
export const SELLING_STATUSES: readonly LotteryDrawStatus[] = [
  LotteryDrawStatus.OPEN,
  LotteryDrawStatus.PAUSED,
];

/** The draw statuses whose sales are over. */
export const FINISHED_STATUSES: readonly LotteryDrawStatus[] = [
  LotteryDrawStatus.CLOSED,
  LotteryDrawStatus.PUBLISHED,
];

/** One draw as the apps draw it. */
export interface DrawView {
  id: string;
  drawNo: number;
  /** "YYYY-MM-DD", the Thai calendar date. */
  thaiDrawDate: string;
  drawAt: Date;
  salesCloseAt: Date;
  status: DrawStatusWire;
  ticketPrice: number;
  maxPerNumber: number;
  pictureUrl: string | null;
  /** The ticket frame this draw's tickets are drawn on; null = the app's built-in frame. */
  frameUrl: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  publishedAt: Date | null;
  /** How many tickets won and the Ks paid out in all; null until the draw is published (phase 3). */
  winnersCount: number | null;
  prizesPaidKs: number | null;
}

export interface DrawPage {
  items: DrawView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NumberAvailability {
  number: string;
  offSale: boolean;
  /** Tickets the caller already holds of this number (0 for a guest). */
  held: number;
  /** What the caller may still buy: maxPerNumber − held, 0 when off sale. */
  left: number;
}

/**
 * The draws as the apps read them (lottery backend phase 2). Open to
 * guests like the dream books: a draw carries nothing private. The
 * availability check is the one read that depends on who is asking — it
 * counts the caller's own tickets. Engineer B's purchases service reuses
 * `findRowByDrawNo`, `isSellingNow` and `view`.
 */
@Injectable()
export class LotteryDrawsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
  ) {}

  /**
   * The draw the apps show first: the OPEN or PAUSED draw with the nearest
   * draw time; else the next SCHEDULED one (not yet drawn); else the
   * latest finished one; else nothing. `serverNow` lets a phone with a
   * wrong clock count down correctly.
   */
  async current(
    now = new Date(),
  ): Promise<{ draw: DrawView | null; serverNow: string }> {
    const selling = await this.prisma.lotteryDraw.findFirst({
      where: { status: { in: [...SELLING_STATUSES] } },
      orderBy: { drawAt: 'asc' },
    });
    const row =
      selling ??
      (await this.prisma.lotteryDraw.findFirst({
        where: { status: LotteryDrawStatus.SCHEDULED, drawAt: { gte: now } },
        orderBy: { drawAt: 'asc' },
      })) ??
      (await this.prisma.lotteryDraw.findFirst({
        where: { status: { in: [...FINISHED_STATUSES] } },
        orderBy: { drawAt: 'desc' },
      }));
    return { draw: row ? this.view(row) : null, serverNow: now.toISOString() };
  }

  /** Every draw, newest draw number first. */
  async listPublic(query: DrawPageQueryDto): Promise<DrawPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const [rows, total] = await Promise.all([
      this.prisma.lotteryDraw.findMany({
        orderBy: { drawNo: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lotteryDraw.count(),
    ]);
    return { items: rows.map((row) => this.view(row)), total, page, pageSize };
  }

  async findPublic(drawNo: number): Promise<DrawView> {
    return this.view(await this.findRowByDrawNo(drawNo));
  }

  /**
   * Off sale / held / left for each asked number, in the order asked
   * (repeats answered once). A guest holds nothing, so `left` is the whole
   * limit. This is advice for the number window — the purchase re-checks
   * everything under the draw's row lock.
   */
  async availability(
    drawNo: number,
    numbers: readonly string[],
    user?: AuthenticatedUser,
  ): Promise<{ items: NumberAvailability[] }> {
    const draw = await this.findRowByDrawNo(drawNo);
    const distinct = [...new Set(numbers)];
    const [offSale, held] = await Promise.all([
      offSaleNumbers(this.prisma, draw.id, distinct),
      user
        ? heldCounts(this.prisma, user.id, draw.id, distinct)
        : Promise.resolve(new Map<string, number>()),
    ]);
    return {
      items: distinct.map((number) => {
        const isOffSale = offSale.has(number);
        const count = held.get(number) ?? 0;
        return {
          number,
          offSale: isOffSale,
          held: count,
          left: leftToBuy(draw.maxPerNumber, count, isOffSale),
        };
      }),
    };
  }

  /** The stored row for a draw number, or 404 LOTTERY_DRAW_NOT_FOUND. */
  async findRowByDrawNo(drawNo: number): Promise<LotteryDraw> {
    const row = await this.prisma.lotteryDraw.findUnique({
      where: { drawNo },
    });
    if (!row) throw drawNotFound();
    return row;
  }

  /** True while tickets may be bought: OPEN, and before the sales close time. */
  isSellingNow(
    draw: Pick<LotteryDraw, 'status' | 'salesCloseAt'>,
    now = new Date(),
  ): boolean {
    return (
      draw.status === LotteryDrawStatus.OPEN &&
      draw.salesCloseAt.getTime() > now.getTime()
    );
  }

  view(row: LotteryDraw): DrawView {
    return {
      id: row.id,
      drawNo: row.drawNo,
      thaiDrawDate: toDateString(row.thaiDrawDate),
      drawAt: row.drawAt,
      salesCloseAt: row.salesCloseAt,
      status: drawStatusToWire(row.status),
      ticketPrice: decimalToNumber(row.ticketPrice),
      maxPerNumber: row.maxPerNumber,
      pictureUrl: this.minioService.imageUrl(row.pictureUrl),
      frameUrl: this.minioService.imageUrl(row.frameUrl),
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      publishedAt: row.publishedAt,
      winnersCount: row.winnersCount,
      prizesPaidKs:
        row.prizesPaidKs === null ? null : row.prizesPaidKs.toNumber(),
    };
  }
}
