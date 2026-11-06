import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LotteryTicketStatus,
  type LotteryPayoutStatus,
  type Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  payoutClaimStatus,
  type PrizeClaimStatusWire,
} from './claims/claim-status';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  type TicketStatusWire,
} from './dto/lottery-draw.dto';
import type { TicketPageQueryDto } from './dto/lottery-purchase.dto';
import { ticketStatusToWire } from './lottery-draws.service';
import { LOTTERY_ERRORS, lotteryError } from './lottery-errors';
import { wonGroupsOf, type TicketWonGroup } from './results/payout-groups';

/** A ticket as stored, with the draw number, the purchase ref and (once won) the groups it won and the prize's claim status. */
const TICKET_INCLUDE = {
  draw: { select: { drawNo: true } },
  purchase: { select: { ref: true } },
  payout: { select: { groups: true, status: true } },
} satisfies Prisma.LotteryTicketInclude;

type StoredTicket = Prisma.LotteryTicketGetPayload<{
  include: typeof TICKET_INCLUDE;
}>;

/**
 * One ticket as the apps draw it. `status`, `prizeKs` and `wonGroups` are
 * settled by the publish (phase 3): until then WAITING / null / null;
 * afterwards WON with its prize and the groups it won, or NOT_WON with
 * null and []. `claimStatus` (2026-10-24) is the prize's place in the
 * claim flow — null unless the ticket WON.
 */
export interface TicketView {
  ticketNo: string;
  drawNo: number;
  number: string;
  status: TicketStatusWire;
  prizeKs: number | null;
  wonGroups: TicketWonGroup[] | null;
  claimStatus: PrizeClaimStatusWire | null;
  purchaseRef: string;
  boughtAt: Date;
}

export interface TicketPage {
  items: TicketView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The caller's own tickets (lottery backend phase 2): the list, one draw's
 * worth of it, and one ticket by number. Nothing here is ever another
 * customer's — a ticket number that belongs to someone else answers 404
 * exactly like one that does not exist.
 */
@Injectable()
export class LotteryTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first; `drawNo` narrows to one draw (an unknown draw simply lists nothing). */
  async list(userId: string, query: TicketPageQueryDto): Promise<TicketPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryTicketWhereInput = {
      userId,
      ...(query.drawNo === undefined ? {} : { draw: { drawNo: query.drawNo } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.lotteryTicket.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: TICKET_INCLUDE,
      }),
      this.prisma.lotteryTicket.count({ where }),
    ]);
    return { items: rows.map((row) => this.view(row)), total, page, pageSize };
  }

  async findOne(userId: string, ticketNo: string): Promise<TicketView> {
    const row = await this.prisma.lotteryTicket.findFirst({
      where: { ticketNo, userId },
      include: TICKET_INCLUDE,
    });
    if (!row) {
      throw lotteryError(
        HttpStatus.NOT_FOUND,
        LOTTERY_ERRORS.TICKET_NOT_FOUND,
        'Ticket not found',
      );
    }
    return this.view(row);
  }

  view(row: StoredTicket): TicketView {
    return {
      ticketNo: row.ticketNo,
      drawNo: row.draw.drawNo,
      number: row.number,
      status: ticketStatusToWire(row.status),
      prizeKs: row.prizeKs === null ? null : row.prizeKs.toNumber(),
      wonGroups: wonGroupsOf(row.status, row.payout),
      claimStatus: ticketClaimStatus(row.status, row.payout),
      purchaseRef: row.purchase.ref,
      boughtAt: row.createdAt,
    };
  }
}

/**
 * A ticket's `claimStatus` on the wire: null unless it WON (and has its
 * payout row), else the payout status read as the claim flow's word
 * (UNCLAIMED → not_requested, …, EXPIRED → expired). Shared with the admin
 * ticket list.
 */
export function ticketClaimStatus(
  status: LotteryTicketStatus,
  payout: { status: LotteryPayoutStatus } | null | undefined,
): PrizeClaimStatusWire | null {
  if (status !== LotteryTicketStatus.WON || !payout) return null;
  return payoutClaimStatus(payout.status);
}
