import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  type AccountAccessEvent,
  SessionRevocationService,
  isAccessTokenRevoked,
} from './session-revocation.service';

describe('SessionRevocationService (H-21)', () => {
  let service: SessionRevocationService;
  let prisma: {
    refreshToken: { updateMany: jest.Mock };
    user: { update: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionRevocationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SessionRevocationService);
  });

  it('revokes every live refresh token and stamps sessionsRevokedAt', async () => {
    const before = Date.now();
    await service.revokeAll('user-1');

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
    const [{ where, data }] = prisma.user.update.mock.calls[0] as [
      { where: { id: string }; data: { sessionsRevokedAt: Date } },
    ];
    expect(where).toEqual({ id: 'user-1' });
    expect(data.sessionsRevokedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the caller's own refresh token on a self-service change", async () => {
    await service.revokeAll('user-1', { exceptSessionId: 'rt-mine' });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false, id: { not: 'rt-mine' } },
      data: { revoked: true },
    });
  });

  it("writes through the caller's transaction when one is given", async () => {
    const tx = {
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
    };

    await service.revokeAll('user-1', { client: tx as never });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('without a caller transaction it opens its own, so the lock below means something', async () => {
    await service.revokeAll('user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  describe('B2: a refresh racing the revoke (review minor H-21)', () => {
    const sqlOf = (call: unknown[]) =>
      (call[0] as TemplateStringsArray).join('?');

    it('locks the account row FOR UPDATE before touching any session — the order every refresh takes too (users, then refresh_tokens)', async () => {
      await service.revokeAll('user-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const call = prisma.$queryRaw.mock.calls[0] as unknown[];
      expect(sqlOf(call)).toMatch(/FROM "users" WHERE "id" = \? FOR UPDATE/);
      expect(call.slice(1)).toEqual(['user-1']);
      const locked = prisma.$queryRaw.mock.invocationCallOrder[0];
      expect(locked).toBeLessThan(
        prisma.refreshToken.updateMany.mock.invocationCallOrder[0],
      );
      expect(locked).toBeLessThan(
        prisma.user.update.mock.invocationCallOrder[0],
      );
    });

    it('stamps sessionsRevokedAt only once the lock is held, so an access token a refresh signed while holding it is always older than the cut-off', async () => {
      let lockedAt = 0;
      prisma.$queryRaw.mockImplementation(async () => {
        // The lock is granted a moment after it is asked for (a refresh
        // holding the row commits first).
        await new Promise((resolve) => setTimeout(resolve, 20));
        lockedAt = Date.now();
        return [{ id: 'user-1' }];
      });

      await service.revokeAll('user-1');

      const [{ data }] = prisma.user.update.mock.calls[0] as [
        { data: { sessionsRevokedAt: Date } },
      ];
      expect(lockedAt).toBeGreaterThan(0);
      expect(data.sessionsRevokedAt.getTime()).toBeGreaterThanOrEqual(lockedAt);
    });
  });

  it('revokeAllAndDisconnect writes in one transaction, then tells the realtime gateway', async () => {
    const events: AccountAccessEvent[] = [];
    service.events.subscribe((event) => events.push(event));

    await service.revokeAllAndDisconnect('user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    expect(events).toEqual([{ kind: 'user', userId: 'user-1' }]);
  });

  it('announces nothing when the write fails', async () => {
    const events: AccountAccessEvent[] = [];
    service.events.subscribe((event) => events.push(event));
    prisma.user.update.mockRejectedValueOnce(new Error('db down'));

    await expect(service.revokeAllAndDisconnect('user-1')).rejects.toThrow(
      'db down',
    );
    expect(events).toEqual([]);
  });

  it('broadcasts a permission change for every staff socket to re-check', () => {
    const events: AccountAccessEvent[] = [];
    service.events.subscribe((event) => events.push(event));

    service.permissionsChanged();
    service.disconnectUser('user-2');

    expect(events).toEqual([
      { kind: 'permissions' },
      { kind: 'user', userId: 'user-2' },
    ]);
  });
});

describe('isAccessTokenRevoked', () => {
  const revokedAt = new Date('2026-09-28T10:00:00.700Z');
  const revokedMs = revokedAt.getTime();
  const second = Math.floor(revokedMs / 1000);

  it('never revokes when the account was never revoked', () => {
    expect(isAccessTokenRevoked({ iat: second - 3600 }, null)).toBe(false);
  });

  it('uses the millisecond issue time (ims): earlier is revoked, the same moment or later is not', () => {
    expect(
      isAccessTokenRevoked({ iat: second, ims: revokedMs - 1 }, revokedAt),
    ).toBe(true);
    expect(
      isAccessTokenRevoked({ iat: second, ims: revokedMs }, revokedAt),
    ).toBe(false);
    expect(
      isAccessTokenRevoked({ iat: second, ims: revokedMs + 250 }, revokedAt),
    ).toBe(false);
  });

  it('a token minted in the same second but BEFORE the revoke is revoked — no one-second window', () => {
    expect(
      isAccessTokenRevoked({ iat: second, ims: revokedMs - 300 }, revokedAt),
    ).toBe(true);
  });

  it('an older token without ims falls back to iat, counted from the start of its second', () => {
    expect(isAccessTokenRevoked({ iat: second - 1 }, revokedAt)).toBe(true);
    expect(isAccessTokenRevoked({ iat: second }, revokedAt)).toBe(true);
    expect(isAccessTokenRevoked({ iat: second + 1 }, revokedAt)).toBe(false);
  });

  it('treats a token without any issue time as revoked once a revoke happened', () => {
    expect(isAccessTokenRevoked({}, revokedAt)).toBe(true);
    expect(isAccessTokenRevoked({}, null)).toBe(false);
  });
});
