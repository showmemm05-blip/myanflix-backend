import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import {
  REFRESH_TOKEN_GRACE_MS,
  REFRESH_TOKEN_SWEEP_BATCH,
  REFRESH_TOKEN_SWEEP_MAX_BATCHES,
  RefreshTokenSweeperService,
} from './refresh-token-sweeper.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

describe('RefreshTokenSweeperService', () => {
  let prisma: { $executeRaw: jest.Mock };
  let service: RefreshTokenSweeperService;
  const now = new Date('2026-10-07T02:00:00.000Z');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    prisma = { $executeRaw: jest.fn().mockResolvedValue(0) };
    service = new RefreshTokenSweeperService(
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('deletes only refresh_tokens rows that expired more than a day ago, in a bounded batch', async () => {
    prisma.$executeRaw.mockResolvedValueOnce(12);

    await expect(service.sweepExpired(now)).resolves.toBe(12);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, cutoff, limit] = prisma.$executeRaw.mock
      .calls[0] as RawCall;
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toMatch(/^ ?DELETE FROM "refresh_tokens" WHERE "id" IN \(/);
    expect(sql).toContain('WHERE "expiresAt" < ? LIMIT ?');
    // Never another table, and never a users lock.
    expect(sql).not.toMatch(/users|FOR (UPDATE|SHARE)/i);
    expect(cutoff).toEqual(new Date(now.getTime() - REFRESH_TOKEN_GRACE_MS));
    expect(limit).toBe(REFRESH_TOKEN_SWEEP_BATCH);
  });

  it('keeps deleting full batches until a short one, and adds them up', async () => {
    prisma.$executeRaw
      .mockResolvedValueOnce(REFRESH_TOKEN_SWEEP_BATCH)
      .mockResolvedValueOnce(REFRESH_TOKEN_SWEEP_BATCH)
      .mockResolvedValueOnce(7);

    await expect(service.sweepExpired(now)).resolves.toBe(
      REFRESH_TOKEN_SWEEP_BATCH * 2 + 7,
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('stops after the per-run cap, leaving the rest for the next night', async () => {
    prisma.$executeRaw.mockResolvedValue(REFRESH_TOKEN_SWEEP_BATCH);

    await service.sweepExpired(now);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(
      REFRESH_TOKEN_SWEEP_MAX_BATCHES,
    );
  });

  it('never throws: a database error is logged and the count so far returned', async () => {
    prisma.$executeRaw
      .mockResolvedValueOnce(REFRESH_TOKEN_SWEEP_BATCH)
      .mockRejectedValueOnce(new Error('db down'));
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(service.sweepExpired(now)).resolves.toBe(
      REFRESH_TOKEN_SWEEP_BATCH,
    );
    expect(warn).toHaveBeenCalled();
  });
});
