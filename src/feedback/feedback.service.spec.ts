import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import {
  ClientPlatform,
  FeedbackCategory,
  FeedbackStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requestHostContext } from '../common/storage/request-host.context';
import {
  FeedbackService,
  FEEDBACK_MAX_PER_HOUR,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_RATE_WINDOW_MS,
} from './feedback.service';

function createdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'feedback-1',
    category: FeedbackCategory.BUG,
    message: 'The player stalls on episode 3',
    status: FeedbackStatus.NEW,
    createdAt: new Date('2026-08-20T13:00:00.000Z'),
    ...overrides,
  };
}

/** Runs `fn` as if it were inside an HTTP request with this client context. */
function inRequest<T>(
  ctx: { ip?: string | null; platform?: ClientPlatform },
  fn: () => Promise<T>,
): Promise<T> {
  return requestHostContext.run({ hostname: 'localhost', ...ctx }, fn);
}

describe('FeedbackService', () => {
  let service: FeedbackService;
  let prisma: {
    feedback: {
      create: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      feedback: {
        create: jest.fn().mockResolvedValue(createdRow()),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeedbackService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(FeedbackService);
  });

  describe('create — rate limit', () => {
    it(`accepts the ${FEEDBACK_MAX_PER_HOUR}th submission in the hour`, async () => {
      prisma.feedback.count.mockResolvedValue(FEEDBACK_MAX_PER_HOUR - 1);

      await service.create('user-1', {
        category: FeedbackCategory.BUG,
        message: 'Still broken',
      });

      expect(prisma.feedback.create).toHaveBeenCalled();
    });

    it(`rejects the ${FEEDBACK_MAX_PER_HOUR + 1}th with 429 and writes nothing`, async () => {
      prisma.feedback.count.mockResolvedValue(FEEDBACK_MAX_PER_HOUR);

      await expect(
        service.create('user-1', {
          category: FeedbackCategory.BUG,
          message: 'Still broken',
        }),
      ).rejects.toThrow(HttpException);
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });

    it('uses TOO_MANY_REQUESTS with a message that says how many and when to retry', async () => {
      prisma.feedback.count.mockResolvedValue(FEEDBACK_MAX_PER_HOUR);

      await expect(
        service.create('user-1', {
          category: FeedbackCategory.BUG,
          message: 'Still broken',
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        message: expect.stringContaining(String(FEEDBACK_MAX_PER_HOUR)),
      });
    });

    it('counts only this user, and only inside the rolling hour', async () => {
      const before = Date.now();

      await service.create('user-1', {
        category: FeedbackCategory.SUGGESTION,
        message: 'Please add subtitles',
      });

      const where = prisma.feedback.count.mock.calls[0][0].where;
      expect(where.userId).toBe('user-1');
      const windowStart: Date = where.createdAt.gte;
      expect(windowStart.getTime()).toBeGreaterThanOrEqual(
        before - FEEDBACK_RATE_WINDOW_MS,
      );
      expect(windowStart.getTime()).toBeLessThanOrEqual(
        Date.now() - FEEDBACK_RATE_WINDOW_MS + 1000,
      );
    });

    it('limits per account, so one spammer cannot block everyone behind their IP', async () => {
      prisma.feedback.count.mockImplementation(
        ({ where }: { where: { userId: string } }) =>
          Promise.resolve(where.userId === 'user-1' ? FEEDBACK_MAX_PER_HOUR : 0),
      );

      await expect(
        service.create('user-1', {
          category: FeedbackCategory.BUG,
          message: 'Still broken',
        }),
      ).rejects.toThrow(HttpException);
      await expect(
        service.create('user-2', {
          category: FeedbackCategory.BUG,
          message: 'Also broken',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('create — message validation', () => {
    it('rejects a message shorter than the minimum once trimmed', async () => {
      await expect(
        service.create('user-1', {
          category: FeedbackCategory.OTHER,
          message: '  hi  ',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.feedback.create).not.toHaveBeenCalled();
    });

    it(`rejects a message longer than ${FEEDBACK_MESSAGE_MAX} characters`, async () => {
      await expect(
        service.create('user-1', {
          category: FeedbackCategory.OTHER,
          message: 'a'.repeat(FEEDBACK_MESSAGE_MAX + 1),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores the message trimmed', async () => {
      await service.create('user-1', {
        category: FeedbackCategory.CONTENT,
        message: '   please add more Korean drama   ',
      });

      const data = prisma.feedback.create.mock.calls[0][0].data;
      expect(data.message).toBe('please add more Korean drama');
    });

    it('checks the message before spending a query on the rate limit', async () => {
      await expect(
        service.create('user-1', {
          category: FeedbackCategory.OTHER,
          message: 'hi',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.feedback.count).not.toHaveBeenCalled();
    });
  });

  describe('create — what gets stored', () => {
    it('records the platform and IP of the request that sent it', async () => {
      await inRequest(
        { ip: '203.0.113.7', platform: ClientPlatform.MOBILE },
        () =>
          service.create('user-1', {
            category: FeedbackCategory.PAYMENT,
            message: 'My deposit is missing',
          }),
      );

      expect(prisma.feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            category: FeedbackCategory.PAYMENT,
            platform: ClientPlatform.MOBILE,
            ipAddress: '203.0.113.7',
          }),
        }),
      );
    });

    it('falls back to UNKNOWN / null outside a request', async () => {
      await service.create('user-1', {
        category: FeedbackCategory.BUG,
        message: 'Something is wrong',
      });

      expect(prisma.feedback.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            platform: ClientPlatform.UNKNOWN,
            ipAddress: null,
          }),
        }),
      );
    });

    it('never returns the IP or the internal admin note to the author', async () => {
      const result = await inRequest({ ip: '203.0.113.7' }, () =>
        service.create('user-1', {
          category: FeedbackCategory.BUG,
          message: 'Something is wrong',
        }),
      );

      expect(result).not.toHaveProperty('ipAddress');
      expect(result).not.toHaveProperty('adminNote');
    });
  });

  describe('findMine', () => {
    it('scopes to the caller, newest first, and never selects adminNote', async () => {
      prisma.feedback.count.mockResolvedValue(1);
      prisma.feedback.findMany.mockResolvedValue([createdRow()]);

      const result = await service.findMine('user-1', { page: 1, limit: 20 });

      const args = prisma.feedback.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ userId: 'user-1' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.select.adminNote).toBeUndefined();
      expect(result).toEqual({
        items: [createdRow()],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('defaults to page 1 / limit 20 when pagination is omitted', async () => {
      await service.findMine('user-1', {});

      const args = prisma.feedback.findMany.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });
  });
});
