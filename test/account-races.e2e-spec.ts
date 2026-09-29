import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionRevocationService } from '../src/auth/session-revocation.service';
import { AuditService } from '../src/audit/audit.service';
import * as accountStatusLock from '../src/users/account-status-lock';
import { ACCOUNT_DELETE_PENDING_DEPOSIT_MESSAGE } from '../src/users/users.service';

/**
 * The two race windows the release-fix review left open, replayed against
 * the real test database (see e2e-setup.ts) with the interleaving forced:
 * one side is held at a known point INSIDE its transaction while the other
 * side runs into the row lock, and only then let go.
 *
 * - B2 (H-21): a refresh that consumed its token as every session was being
 *   revoked must not leave a live session behind.
 * - B3 (H-16): a deposit submitted while the owner closes the account must
 *   not land on the CLOSED account.
 *
 * Run with --runInBand: "is someone waiting on a row lock" is read from
 * pg_stat_activity.
 */
describe('Account races (e2e: B2 refresh vs revoke, B3 deposit vs close)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sessions: SessionRevocationService;

  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];

  const api = () => request(app.getHttpServer());
  const postRefresh = (refreshToken: string) =>
    api().post('/api/auth/refresh').send({ refreshToken });
  const me = (accessToken: string) =>
    api().get('/api/users/me').set('Authorization', `Bearer ${accessToken}`);

  async function registerCustomer(name: string) {
    const res = await api()
      .post('/api/auth/register')
      .send({ username: `race_${name}_${suffix}`, password: 'race-password-1' })
      .expect(201);
    const body = res.body.data as {
      user: { id: string };
      accessToken: string;
      refreshToken: string;
    };
    userIds.push(body.user.id);
    return {
      userId: body.user.id,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    };
  }

  /** A promise and the function that settles it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /** Resolves once `check` is true; fails the test after `timeoutMs`. */
  async function until(
    what: string,
    check: () => Promise<boolean> | boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Is some statement matching `pattern` waiting on another's row lock? */
  async function someoneBlockedOn(pattern: RegExp): Promise<boolean> {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0`;
    return rows.some((row) => pattern.test(row.query));
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    // Two requests are in flight at once below — listen first, so supertest
    // never starts and closes its own listener under a sibling request (see
    // auth-refresh.e2e-spec.ts).
    await app.listen(0);

    prisma = app.get(PrismaService);
    sessions = app.get(SessionRevocationService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { targetId: { in: userIds } }],
      },
    });
    await prisma.deposit.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  describe('B2: refresh vs "revoke every session"', () => {
    it('the refresh got there first: the revoke waits for it, then takes the new session too', async () => {
      const account = await registerCustomer('rf1');
      // Hold the refresh right where it signs the new pair: its old token is
      // consumed and (with the fix) the account row is share-locked.
      const signing = gate();
      const reached = gate();
      const original = JwtService.prototype.signAsync;
      jest
        .spyOn(JwtService.prototype, 'signAsync')
        .mockImplementationOnce(async function (
          this: JwtService,
          ...args: Parameters<JwtService['signAsync']>
        ) {
          reached.open();
          await signing.opened;
          return original.apply(this, args);
        } as JwtService['signAsync']);

      const refreshing = postRefresh(account.refreshToken).then((res) => res);
      await reached.opened;

      let revoked = false;
      const revoking = sessions
        .revokeAllAndDisconnect(account.userId)
        .then(() => {
          revoked = true;
        });
      // Before the fix the revoke ran straight through here, missing the
      // session the refresh was about to write; now it waits on the row.
      await until(
        'the revoke to finish or to wait on the account row',
        async () => revoked || (await someoneBlockedOn(/FOR UPDATE/)),
      );
      signing.open();

      const refreshed = await refreshing;
      await revoking;
      expect(refreshed.status).toBe(200);
      const pair = refreshed.body.data as {
        accessToken: string;
        refreshToken: string;
      };

      // Nothing the refresh minted outlives the revoke.
      const again = await postRefresh(pair.refreshToken).expect(401);
      expect(again.body.message).toBe('Invalid or expired refresh token');
      await me(pair.accessToken).expect(401);
      await expect(
        prisma.refreshToken.count({
          where: { userId: account.userId, revoked: false },
        }),
      ).resolves.toBe(0);
    });

    it('the revoke got there first: the refresh waits for it, then finds its token revoked', async () => {
      const account = await registerCustomer('rf2');

      let refreshing: Promise<request.Response> | undefined;
      await prisma.$transaction(async (tx) => {
        await sessions.revokeAll(account.userId, { client: tx });
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid`;
        refreshing = postRefresh(account.refreshToken).then((res) => res);
        await until('the refresh to wait on the revoke', async () => {
          const rows = await prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
          return rows[0].n > 0;
        });
      });

      const res = await refreshing!;
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid or expired refresh token');
      await expect(
        prisma.refreshToken.count({
          where: { userId: account.userId, revoked: false },
        }),
      ).resolves.toBe(0);
    });
  });

  describe('B3: deposit vs DELETE /users/me', () => {
    const depositBody = (reference: string) => ({
      amount: 5000,
      paymentMethod: 'KBZ Pay',
      reference,
    });

    it('the close got there first: the deposit waits, then is refused — no pending money on a CLOSED account', async () => {
      const account = await registerCustomer('dp1');
      // Hold the close inside its transaction: the row is locked FOR UPDATE
      // and already CLOSED, but not committed — so the deposit request still
      // passes the access-token check, exactly as in the live race.
      const closing = gate();
      const reached = gate();
      const original = AuditService.prototype.anonymiseUser;
      jest
        .spyOn(AuditService.prototype, 'anonymiseUser')
        .mockImplementationOnce(async function (
          this: AuditService,
          ...args: Parameters<AuditService['anonymiseUser']>
        ) {
          reached.open();
          await closing.opened;
          return original.apply(this, args);
        });

      const deleting = api()
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${account.accessToken}`)
        .then((res) => res);
      await reached.opened;

      const depositing = api()
        .post('/api/deposits')
        .set('Authorization', `Bearer ${account.accessToken}`)
        .send(depositBody('731904'))
        .then((res) => res);
      // Before the fix the insert waited here on its foreign key, then went
      // ahead; now it waits on the share-lock, then reads CLOSED.
      await until('the deposit to wait on the closing account', () =>
        someoneBlockedOn(/deposits|FOR SHARE/i),
      );
      closing.open();

      const [deleted, deposited] = await Promise.all([deleting, depositing]);
      expect(deleted.status).toBe(200);
      expect(deposited.status).toBe(401);
      expect(deposited.body.message).toBe('This account is no longer active');
      await expect(
        prisma.deposit.count({ where: { userId: account.userId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: account.userId } }),
      ).resolves.toEqual(expect.objectContaining({ status: 'CLOSED' }));
    });

    it('the deposit got there first: the close waits for it, then refuses — the deposit is pending', async () => {
      const account = await registerCustomer('dp2');
      // Hold the deposit just after it share-locked the account row.
      const inserting = gate();
      const reached = gate();
      const original = accountStatusLock.lockAccountStatus;
      jest
        .spyOn(accountStatusLock, 'lockAccountStatus')
        .mockImplementationOnce(async (...args) => {
          const status = await original(...args);
          reached.open();
          await inserting.opened;
          return status;
        });

      const depositing = api()
        .post('/api/deposits')
        .set('Authorization', `Bearer ${account.accessToken}`)
        .send(depositBody('731905'))
        .then((res) => res);
      await reached.opened;

      const deleting = api()
        .delete('/api/users/me')
        .set('Authorization', `Bearer ${account.accessToken}`)
        .then((res) => res);
      await until('the close to wait on the deposit', () =>
        someoneBlockedOn(/FOR UPDATE/),
      );
      inserting.open();

      const [deposited, deleted] = await Promise.all([depositing, deleting]);
      expect(deposited.status).toBe(201);
      expect(deleted.status).toBe(409);
      expect(deleted.body.message).toBe(ACCOUNT_DELETE_PENDING_DEPOSIT_MESSAGE);
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: account.userId } }),
      ).resolves.toEqual(expect.objectContaining({ status: 'ACTIVE' }));
    });
  });
});
