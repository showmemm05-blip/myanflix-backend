import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { requestClientContext } from '../common/storage/request-host.context';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateFeedbackDto } from './dto/create-feedback.dto';

/** Hard bounds on a feedback message, enforced here as well as in the DTO. */
export const FEEDBACK_MESSAGE_MIN = 5;
export const FEEDBACK_MESSAGE_MAX = 2000;

/**
 * How many submissions one account may make per rolling hour.
 *
 * Per USER rather than per IP: feedback is authenticated, so the account is
 * the real identity, and an IP limit would punish everyone behind one
 * household/office NAT for a single spammer.
 */
export const FEEDBACK_MAX_PER_HOUR = 5;
export const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one piece of user feedback, with the platform and IP of the
   * request that sent it.
   *
   * Rate-limited by counting the caller's own rows inside a rolling hour —
   * no in-memory counter, so the limit survives a restart and holds across
   * every instance. Over the limit is a 429 with a message the client can
   * show verbatim.
   */
  async create(userId: string, dto: CreateFeedbackDto) {
    const message = (dto.message ?? '').trim();
    if (message.length < FEEDBACK_MESSAGE_MIN) {
      throw new BadRequestException(
        `Please write at least ${FEEDBACK_MESSAGE_MIN} characters`,
      );
    }
    if (message.length > FEEDBACK_MESSAGE_MAX) {
      throw new BadRequestException(
        `Feedback cannot be longer than ${FEEDBACK_MESSAGE_MAX} characters`,
      );
    }

    const windowStart = new Date(Date.now() - FEEDBACK_RATE_WINDOW_MS);
    const recentCount = await this.prisma.feedback.count({
      where: { userId, createdAt: { gte: windowStart } },
    });
    if (recentCount >= FEEDBACK_MAX_PER_HOUR) {
      throw new HttpException(
        `You have reached the limit of ${FEEDBACK_MAX_PER_HOUR} feedback submissions per hour. Please try again later.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { ip, platform } = requestClientContext();

    const created = await this.prisma.feedback.create({
      data: {
        userId,
        category: dto.category,
        message,
        platform,
        ipAddress: ip,
      },
      select: {
        id: true,
        category: true,
        message: true,
        status: true,
        createdAt: true,
      },
    });

    return created;
  }

  /**
   * The caller's own submissions, newest first — so a client can show "we
   * got your report" history. `adminNote` is deliberately never selected:
   * it is internal triage text, not something the author may read.
   */
  async findMine(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          category: true,
          message: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.feedback.count({ where: { userId } }),
    ]);

    return { items, total, page, limit };
  }
}
