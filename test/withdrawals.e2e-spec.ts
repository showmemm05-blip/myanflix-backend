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
 */
describe('Withdrawals — funds held at request (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let userId: string;
  let adminId: string;
  let userToken: string;
  let adminToken: string;

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

  async function balance(): Promise<number> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId },
    });
    return wallet.balance.toNumber();
  }

  function requestWithdrawal(amount: number) {
    return request(app.getHttpServer())
      .post('/api/withdrawals')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount, ...payout });
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
    await prisma.wallet.create({ data: { userId: admin.id, balance: 0 } });

    userId = user.id;
    adminId = admin.id;
    userToken = await signToken(user.id);
    adminToken = await signToken(admin.id);
  });

  afterAll(async () => {
    // Isolated test database. Money rows do not cascade from users (H-22),
    // and a held withdrawal points at its ledger row, so: withdrawals, then
    // the ledger, then wallets, then the users.
    const ids = [userId, adminId];
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.withdrawal.deleteMany({ where: { userId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  afterEach(async () => {
    // Every case starts from 10,000 Ks and no requests.
    await prisma.withdrawal.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.wallet.update({
      where: { userId },
      data: { balance: 10000 },
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
});
