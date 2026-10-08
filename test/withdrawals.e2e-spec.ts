import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  Role,
  TransactionStatus,
  TransactionType,
  UserStatus,
  WithdrawalStatus,
} from '../src/generated/prisma/client';

/**
 * C-4 against a real database: the money is held when a withdrawal is
 * requested, given back on reject, and approve never debits a held request
 * again. Requests from before holds existed (no hold row) still debit on
 * approve.
 *
 * Withdrawal code (2026-10-05): every request carries the account's 6-digit
 * code. The test user creates it through the real route; the code cases
 * below check that a missing or wrong code moves no money, and that the
 * 5-try lock holds against parallel guesses on the REAL `SELECT … FOR
 * UPDATE` row lock (the unit spec can only fake it with a queue).
 */
describe('Withdrawals — funds held at request (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let userId: string;
  let adminId: string;
  let noCodeUserId: string;
  let userToken: string;
  let adminToken: string;
  let noCodeUserToken: string;

  /** The test user's withdrawal code (not on the too-easy list). */
  const withdrawalCode = '582904';

  const payout = {
    accountType: 'KBZPay',
    accountName: 'Ko Ko',
    accountNumber: '09123456789',
  };

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  async function balance(id = userId): Promise<number> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: id },
    });
    return wallet.balance.toNumber();
  }

  /**
   * `code` null = send NO code at all. (It used to be `undefined`, which
   * JavaScript replaces with the default parameter — so the "no code sent"
   * case silently sent the right code and could never fail.)
   */
  function requestWithdrawal(
    amount: number,
    code: string | null = withdrawalCode,
    token = userToken,
  ) {
    return request(app.getHttpServer())
      .post('/api/withdrawals')
      .set('Authorization', `Bearer ${token}`)
      .send({
        amount,
        ...payout,
        ...(code === null ? {} : { withdrawalCode: code }),
      });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Pipe/filter/interceptor are registered globally by AppModule — see
    // deposits.e2e-spec.ts; do not re-register them.
    app.setGlobalPrefix('api');
    await app.init();
    // Listening first keeps the parallel burst below from resetting its own
    // sockets — see deposits.e2e-spec.ts.
    await app.listen(0);

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        username: `withdrawer_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: user.id, balance: 10000 } });

    const admin = await prisma.user.create({
      data: {
        username: `wd_admin_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    // M-11/M-14: the admin has money of its own, so it can file a
    // self-service request — and must then be unable to settle it.
    await prisma.wallet.create({ data: { userId: admin.id, balance: 10000 } });

    // Never created a withdrawal code (like everyone right after the
    // migration): its first withdrawal must be refused until it makes one.
    const noCodeUser = await prisma.user.create({
      data: {
        username: `wd_nocode_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({
      data: { userId: noCodeUser.id, balance: 10000 },
    });

    userId = user.id;
    adminId = admin.id;
    noCodeUserId = noCodeUser.id;
    userToken = await signToken(user.id);
    adminToken = await signToken(admin.id);
    noCodeUserToken = await signToken(noCodeUser.id);

    // The test user creates its code the way the apps do.
    await request(app.getHttpServer())
      .post('/api/users/me/withdrawal-code')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: withdrawalCode, confirm: withdrawalCode })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/users/me/withdrawal-code')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: withdrawalCode, confirm: withdrawalCode })
      .expect(201);
  });

  afterAll(async () => {
    // Isolated test database. Money rows do not cascade from users (H-22),
    // and a held withdrawal points at its ledger row, so: withdrawals, then
    // the ledger, then wallets, then the users.
    const ids = [userId, adminId, noCodeUserId];
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  afterEach(async () => {
    // Every case starts from 10,000 Ks, no requests and no wrong tries.
    await prisma.withdrawal.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.wallet.update({
      where: { userId },
      data: { balance: 10000 },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { withdrawalCodeFailedCount: 0, withdrawalCodeLockedUntil: null },
    });
  });

  it('request holds the money at once; reject gives it back with a REFUND row', async () => {
    const created = await requestWithdrawal(6000).expect(201);
    const id = (created.body as { data: { id: string } }).data.id;

    expect(await balance()).toBe(4000);
    const withdrawal = await prisma.withdrawal.findUniqueOrThrow({
      where: { id },
    });
    expect(withdrawal.status).toBe(WithdrawalStatus.PENDING);
    expect(withdrawal.holdTransactionId).not.toBeNull();
    const hold = await prisma.transaction.findUniqueOrThrow({
      where: { id: withdrawal.holdTransactionId! },
    });
    expect(hold).toMatchObject({
      type: TransactionType.WITHDRAWAL,
      status: TransactionStatus.PENDING,
    });
    expect(hold.amount.toNumber()).toBe(6000);

    await request(app.getHttpServer())
      .patch(`/api/withdrawals/${id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Wrong account number' })
      .expect(200);

    expect(await balance()).toBe(10000);
    const ledger = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      ledger.map((row) => [row.type, row.status, row.amount.toNumber()]),
    ).toEqual([
      [TransactionType.WITHDRAWAL, TransactionStatus.FAILED, 6000],
      [TransactionType.REFUND, TransactionStatus.COMPLETED, 6000],
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'withdrawal.reject', targetId: id },
    });
    expect(audit.metadata).toMatchObject({
      reason: 'Wrong account number',
      refundTransactionId: ledger[1].id,
    });
  });

  it('approve of a held request never debits again: the balance stays, the hold row turns COMPLETED, no new row', async () => {
    const created = await requestWithdrawal(6000).expect(201);
    const id = (created.body as { data: { id: string } }).data.id;
    // The money the payout covers is gone — spending it elsewhere is impossible.
    expect(await balance()).toBe(4000);

    await request(app.getHttpServer())
      .patch(`/api/withdrawals/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(await balance()).toBe(4000);
    const ledger = await prisma.transaction.findMany({ where: { userId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: TransactionType.WITHDRAWAL,
      status: TransactionStatus.COMPLETED,
    });
  });

  it('two full-balance requests at once: exactly one is held, the other is refused, the balance never goes below zero', async () => {
    const responses = await Promise.all([
      requestWithdrawal(10000),
      requestWithdrawal(10000),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await balance()).toBe(0);
    expect(await prisma.withdrawal.count({ where: { userId } })).toBe(1);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
  });

  it('a request from before holds existed (no hold row) still debits on approve, as before', async () => {
    const legacy = await prisma.withdrawal.create({
      data: { userId, amount: 3000, ...payout },
    });

    await request(app.getHttpServer())
      .patch(`/api/withdrawals/${legacy.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(await balance()).toBe(7000);
    const ledger = await prisma.transaction.findMany({ where: { userId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: TransactionType.WITHDRAWAL,
      status: TransactionStatus.COMPLETED,
    });
  });

  it('a request from before holds existed moves no money on reject', async () => {
    const legacy = await prisma.withdrawal.create({
      data: { userId, amount: 3000, ...payout },
    });

    await request(app.getHttpServer())
      .patch(`/api/withdrawals/${legacy.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Duplicate request' })
      .expect(200);

    expect(await balance()).toBe(10000);
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0);
  });

  describe('M-11/M-14: a staff member never settles their own payout', () => {
    afterEach(async () => {
      await prisma.withdrawal.deleteMany({ where: { userId: adminId } });
      await prisma.transaction.deleteMany({ where: { userId: adminId } });
      await prisma.wallet.update({
        where: { userId: adminId },
        data: { balance: 10000 },
      });
    });

    it('the admin can still file a self-service request, but approving or rejecting it as the same admin is 403 and moves nothing', async () => {
      const created = await requestWithdrawal(
        6000,
        withdrawalCode,
        adminToken,
      ).expect(201);
      const id = (created.body as { data: { id: string } }).data.id;
      // The hold is the request's own doing — same as for a customer.
      expect(await balance(adminId)).toBe(4000);

      const approve = await request(app.getHttpServer())
        .patch(`/api/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
      expect(approve.body.message).toBe(
        'You cannot approve a withdrawal from your own account',
      );
      const reject = await request(app.getHttpServer())
        .patch(`/api/withdrawals/${id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'mine' })
        .expect(403);
      expect(reject.body.message).toBe(
        'You cannot reject a withdrawal from your own account',
      );

      const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(WithdrawalStatus.PENDING);
      expect(row.approvedByUserId).toBeNull();
      expect(await balance(adminId)).toBe(4000);
      expect(
        await prisma.auditLog.count({
          where: {
            targetId: id,
            action: { in: ['withdrawal.approve', 'withdrawal.reject'] },
          },
        }),
      ).toBe(0);
    });

    it("another staff member's request is still approved as before", async () => {
      const created = await requestWithdrawal(6000).expect(201);
      const id = (created.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .patch(`/api/withdrawals/${id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe('withdrawal code', () => {
    /** Nothing held, nothing written: the wallet and the ledger as before. */
    async function expectNoMoneyMoved(id = userId) {
      expect(await balance(id)).toBe(10000);
      expect(await prisma.withdrawal.count({ where: { userId: id } })).toBe(0);
      expect(await prisma.transaction.count({ where: { userId: id } })).toBe(0);
    }

    it('an account with no code yet: 409 WITHDRAWAL_CODE_NOT_SET (with or without a code sent), no money moves', async () => {
      for (const code of [null, withdrawalCode]) {
        const res = await requestWithdrawal(6000, code, noCodeUserToken).expect(
          409,
        );
        expect(res.body).toMatchObject({
          success: false,
          code: 'WITHDRAWAL_CODE_NOT_SET',
        });
      }
      await expectNoMoneyMoved(noCodeUserId);
    });

    it('no code sent: 400 WITHDRAWAL_CODE_REQUIRED, no try used, no money moves', async () => {
      const res = await requestWithdrawal(6000, null).expect(400);

      expect(res.body.code).toBe('WITHDRAWAL_CODE_REQUIRED');
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.withdrawalCodeFailedCount).toBe(0);
      await expectNoMoneyMoved();
    });

    it('a wrong code: 400 WITHDRAWAL_CODE_WRONG with 4 tries left, no money moves', async () => {
      const res = await requestWithdrawal(6000, '111222').expect(400);

      expect(res.body).toEqual({
        success: false,
        message: 'Wrong code. 4 tries left.',
        code: 'WITHDRAWAL_CODE_WRONG',
        triesLeft: 4,
        maxTries: 5,
      });
      await expectNoMoneyMoved();
    });

    it('10 wrong guesses at once on the real row lock: exactly 4 WRONG, then LOCKED — never a 6th judged guess; then even the right code is refused', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => requestWithdrawal(6000, '111222')),
      );

      const codes = responses.map((r) => (r.body as { code?: string }).code);
      expect(codes.filter((c) => c === 'WITHDRAWAL_CODE_WRONG')).toHaveLength(
        4,
      );
      expect(codes.filter((c) => c === 'WITHDRAWAL_CODE_LOCKED')).toHaveLength(
        6,
      );
      expect(
        responses
          .filter(
            (r) =>
              (r.body as { code?: string }).code === 'WITHDRAWAL_CODE_WRONG',
          )
          .map((r) => (r.body as { triesLeft: number }).triesLeft)
          .sort(),
      ).toEqual([1, 2, 3, 4]);
      for (const r of responses) {
        expect([400, 423]).toContain(r.status);
      }

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.withdrawalCodeFailedCount).toBe(5);
      expect(user.withdrawalCodeLockedUntil!.getTime()).toBeGreaterThan(
        Date.now() + 14 * 60 * 1000,
      );

      const right = await requestWithdrawal(6000).expect(423);
      expect(right.body.code).toBe('WITHDRAWAL_CODE_LOCKED');
      await expectNoMoneyMoved();
    });

    it('a right code resets the wrong-try count', async () => {
      await requestWithdrawal(6000, '111222').expect(400);
      await requestWithdrawal(6000, '111222').expect(400);

      await requestWithdrawal(6000).expect(201);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.withdrawalCodeFailedCount).toBe(0);
      expect(await balance()).toBe(4000);
    });

    it('the code is never stored with the withdrawal, and the stored hash is never the code', async () => {
      const created = await requestWithdrawal(6000).expect(201);

      expect(JSON.stringify(created.body)).not.toContain(withdrawalCode);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.withdrawalCodeHash).not.toBeNull();
      expect(user.withdrawalCodeHash).not.toContain(withdrawalCode);
      // e2e-setup.ts sets WITHDRAWAL_CODE_PEPPER: stored peppered.
      expect(user.withdrawalCodeHash).toMatch(/^wcp1\$[0-9a-f]{8}\$\$2b\$10\$/);
    });
  });
});
