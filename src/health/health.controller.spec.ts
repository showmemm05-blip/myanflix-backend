import { HttpStatus, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { PrismaService } from '../prisma/prisma.service';
import { HEALTH_DEGRADED_CODE, HealthController } from './health.controller';
import { HEALTH_DB_TIMEOUT_MS, HealthService } from './health.service';

/**
 * @nestjs/throttler does not export THROTTLER_SKIP; this is the key its
 * SkipThrottle() writes (`THROTTLER_SKIP + 'default'`, throttler.decorator.js).
 */
const THROTTLER_SKIP_DEFAULT_KEY = 'THROTTLER:SKIPdefault';

/** The never-settling query: what a hung Postgres looks like to the probe. */
const hangs = () => new Promise<never>(() => {});

describe('HealthController', () => {
  let controller: HealthController;
  let queryRaw: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    queryRaw = jest.fn();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  /** The 503 the route throws, or a failed assertion when it answered 200. */
  async function expectDegraded(
    pending: Promise<unknown>,
  ): Promise<CodedHttpException> {
    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodedHttpException);
    const exception = thrown as CodedHttpException;
    expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(exception.code).toBe(HEALTH_DEGRADED_CODE);
    expect(exception.getResponse()).toMatchObject({
      status: 'degraded',
      db: false,
      code: HEALTH_DEGRADED_CODE,
    });
    return exception;
  }

  it('answers ok with db: true when SELECT 1 succeeds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const body = await controller.getHealth();

    expect(body).toMatchObject({ status: 'ok', db: true });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // A tagged-template call: the first argument is the strings array.
    expect(queryRaw.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['SELECT 1']),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 503 degraded with db: false when the query throws', async () => {
    // The shape Prisma 7 raises for a stopped Postgres (observed on a
    // throwaway cluster): a code, and a message that opens with a newline
    // and carries the cause on its last line.
    const error = Object.assign(
      new Error(
        '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. ' +
          "Code: `N/A`. Message: `Can't reach database server at postgres:5432`",
      ),
      { code: 'P2010' },
    );
    queryRaw.mockRejectedValue(error);

    await expectDegraded(controller.getHealth());

    expect(warn).toHaveBeenCalledTimes(1);
    // One line: the code and the cause — never the blank lines, never a stack.
    expect(warn.mock.calls[0][0]).toBe(
      'Database probe failed: P2010 Raw query failed. Code: `N/A`. ' +
        "Message: `Can't reach database server at postgres:5432`",
    );
  });

  it('logs the error name when the message is empty', async () => {
    queryRaw.mockRejectedValue(new TypeError(''));

    await expectDegraded(controller.getHealth());

    expect(warn.mock.calls[0][0]).toBe('Database probe failed: TypeError');
  });

  it('answers 503 once the query has taken longer than the timeout', async () => {
    jest.useFakeTimers();
    queryRaw.mockImplementation(hangs);

    const pending = controller.getHealth();
    // Attach the handlers BEFORE the clock moves, exactly as a real request
    // would be waiting; a hang is only a failure once the timeout elapses.
    const settled = expectDegraded(pending);
    await jest.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS);
    await settled;

    expect(warn).toHaveBeenCalledWith(
      `Database probe took longer than ${HEALTH_DB_TIMEOUT_MS} ms`,
    );
  });

  it('does not answer before the timeout while the query is still running', async () => {
    jest.useFakeTimers();
    queryRaw.mockImplementation(hangs);
    let resolved = false;

    const pending = controller
      .getHealth()
      .then(() => undefined, () => undefined)
      .finally(() => {
        resolved = true;
      });
    await jest.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS - 1);

    expect(resolved).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('logs nothing extra when a timed-out query fails afterwards', async () => {
    jest.useFakeTimers();
    let reject!: (error: Error) => void;
    queryRaw.mockImplementation(
      () =>
        new Promise<never>((_resolve, rejectLater) => {
          reject = rejectLater;
        }),
    );

    const settled = expectDegraded(controller.getHealth());
    await jest.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS);
    await settled;
    reject(new Error('late failure'));
    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/took longer than/);
  });

  it('stays public and never rate limited', () => {
    const handler = HealthController.prototype.getHealth;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(THROTTLER_SKIP_DEFAULT_KEY, handler)).toBe(true);
  });
});
