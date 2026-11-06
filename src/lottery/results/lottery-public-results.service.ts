import { HttpStatus, Injectable } from '@nestjs/common';
import { LotteryDrawStatus, type Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DRAW_PAGE_SIZE_DEFAULT,
  type DrawPageQueryDto,
} from '../dto/lottery-draw.dto';
import { drawNotFound, LOTTERY_ERRORS, lotteryError } from '../lottery-errors';
import { toDateString } from '../lottery-time';
import {
  LotteryResultsService,
  type PrizeGroupView,
} from './lottery-results.service';
import { headlineGroup, parseStoredPayoutGroups } from './payout-groups';
import type { PrizeGroupKey } from './prize-groups';
import { groupsWithKs } from './prize-matcher';

/** A draw with its results row — what the public sheet is built from. */
const RESULT_INCLUDE = {
  result: { select: { groups: true } },
} satisfies Prisma.LotteryDrawInclude;

type DrawWithResult = Prisma.LotteryDrawGetPayload<{
  include: typeof RESULT_INCLUDE;
}>;

/** A published draw's sheet as the apps read it. */
export interface PublicResultView {
  drawNo: number;
  /** "YYYY-MM-DD", the Thai calendar date. */
  thaiDrawDate: string;
  publishedAt: Date | null;
  /** Ks per Baht the draw was published at. */
  rate: number;
  /** The nine groups in the fixed order, each with its Ks at `rate`. */
  groups: PrizeGroupView[];
}

export interface PublicResultPage {
  items: PublicResultView[];
  total: number;
  page: number;
  pageSize: number;
}

/** One winning ticket by number only — never who holds it. */
export interface PublicWinnerView {
  number: string;
  /** The biggest group the ticket won. */
  groupKey: PrizeGroupKey;
  groupName: string;
  /** Everything the ticket was paid, every group added up. */
  ks: number;
}

/**
 * The results as the apps read them (lottery backend phase 3). Open to
 * guests like the draws: a sheet is public once the draw is PUBLISHED,
 * and the winners list names ticket numbers only. A draw that is not
 * published answers 404 LOTTERY_RESULTS_NOT_PUBLISHED, which the phone
 * treats as "no result yet" and never retries.
 */
@Injectable()
export class LotteryPublicResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly results: LotteryResultsService,
  ) {}

  /** GET /lottery/results — the published draws, newest draw number first. */
  async list(query: DrawPageQueryDto): Promise<PublicResultPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DRAW_PAGE_SIZE_DEFAULT;
    const where: Prisma.LotteryDrawWhereInput = {
      status: LotteryDrawStatus.PUBLISHED,
    };
    const [rows, total] = await Promise.all([
      this.prisma.lotteryDraw.findMany({
        where,
        orderBy: { drawNo: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: RESULT_INCLUDE,
      }),
      this.prisma.lotteryDraw.count({ where }),
    ]);
    const items: PublicResultView[] = [];
    for (const row of rows) items.push(await this.view(row));
    return { items, total, page, pageSize };
  }

  /** GET /lottery/draws/:drawNo/results */
  async findByDrawNo(drawNo: number): Promise<PublicResultView> {
    return this.view(await this.publishedDraw(drawNo));
  }

  /**
   * GET /lottery/draws/:drawNo/winners?limit — the paid tickets, biggest
   * prize first then by ticket number, each under the biggest group it
   * won. No user fields, by design: the owner has not said names may be
   * shown.
   */
  async winners(
    drawNo: number,
    limit: number,
  ): Promise<{ items: PublicWinnerView[] }> {
    const draw = await this.publishedDraw(drawNo);
    const rows = await this.prisma.lotteryPayout.findMany({
      where: { drawId: draw.id },
      orderBy: [{ ks: 'desc' }, { ticket: { ticketNo: 'asc' } }],
      take: limit,
      include: { ticket: { select: { number: true } } },
    });
    const items: PublicWinnerView[] = [];
    for (const row of rows) {
      const head = headlineGroup(parseStoredPayoutGroups(row.groups));
      if (!head) continue;
      items.push({
        number: row.ticket.number,
        groupKey: head.key,
        groupName: head.name,
        ks: row.ks.toNumber(),
      });
    }
    return { items };
  }

  /** The stored draw, 404 LOTTERY_DRAW_NOT_FOUND when missing and 404 LOTTERY_RESULTS_NOT_PUBLISHED until published. */
  private async publishedDraw(drawNo: number): Promise<DrawWithResult> {
    const draw = await this.prisma.lotteryDraw.findUnique({
      where: { drawNo },
      include: RESULT_INCLUDE,
    });
    if (!draw) throw drawNotFound();
    if (draw.status !== LotteryDrawStatus.PUBLISHED) {
      throw lotteryError(
        HttpStatus.NOT_FOUND,
        LOTTERY_ERRORS.RESULTS_NOT_PUBLISHED,
        'The results of this draw are not published yet',
        { drawNo },
      );
    }
    return draw;
  }

  /** The sheet at the draw's rate (set by publish; the settings' only for a hand-edited row). */
  private async view(draw: DrawWithResult): Promise<PublicResultView> {
    const rate = await this.results.rateFor(draw);
    const sheet = draw.result ? this.results.sheetOf(draw.result) : [];
    return {
      drawNo: draw.drawNo,
      thaiDrawDate: toDateString(draw.thaiDrawDate),
      publishedAt: draw.publishedAt,
      rate,
      groups: groupsWithKs(sheet, rate),
    };
  }
}
