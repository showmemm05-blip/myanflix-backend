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
  DepositStatus,
  PaymentAccountTransactionType,
  Role,
  UserStatus,
} from '../src/generated/prisma/client';

const DUPLICATE_REFERENCE_MESSAGE =
  'A deposit with this transaction reference already exists';

describe('Deposits (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let userId: string;
  let adminId: string;
  let paymentAccountId: string;
  let userToken: string;
  let adminToken: string;

  async function signToken(id: string): Promise<string> {
    return jwtService.signAsync(
      { sub: id },
      { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
    );
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // ValidationPipe/AllExceptionsFilter/ResponseInterceptor are already
    // registered globally by AppModule via APP_PIPE/APP_FILTER/APP_INTERCEPTOR,
    // so they apply automatically here too — do not re-register them (doing
    // so double-applies them, e.g. double-wrapping every response body).
    app.setGlobalPrefix('api');
    await app.init();
    // Listen on an ephemeral port before any request is made. supertest only
    // starts (and then closes) its own listener when the server has no
    // address, so with the Promise.all bursts below the first request's
    // server.close() would reset the sockets of its still-connecting
    // siblings (ECONNRESET). A server that is already listening is never
    // started or closed by supertest; app.close() in afterAll shuts it down.
    await app.listen(0);

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    // Isolated per-suite-run data so re-running the suite never collides on
    // unique username constraints.
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        username: `depositor_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });

    const admin = await prisma.user.create({
      data: {
        username: `admin_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: admin.id, balance: 0 } });

    // Destination account for the manual-deposit race cases (ADMIN holds
    // DEPOSITS.CREATE via the seeded app_roles).
    const paymentAccount = await prisma.paymentAccount.create({
      data: {
        type: 'KBZPay',
        accountName: `Deposit Test Account ${suffix}`,
        accountNumber: '09000000000',
        createdByUserId: admin.id,
        updatedByUserId: admin.id,
      },
    });

    userId = user.id;
    adminId = admin.id;
    paymentAccountId = paymentAccount.id;
    userToken = await signToken(user.id);
    adminToken = await signToken(admin.id);
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite touched.
    // Ledger rows first: payment_account_transactions.paymentAccountId is
    // onDelete: Restrict, so the account cannot go before its entries.
    await prisma.paymentAccountTransaction.deleteMany({ where: { paymentAccountId } });
    await prisma.paymentAccount.deleteMany({ where: { id: paymentAccountId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.deposit.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: [userId, adminId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    await app.close();
  });

  it('creates a PENDING deposit without changing the balance', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 5000, paymentMethod: 'KBZ Pay', reference: '000111' })
      .expect(201);

    expect(createRes.body.success).toBe(true);
    expect(createRes.body.data.status).toBe('PENDING');
    expect(createRes.body.data.reference).toBe('000111');

    const walletRes = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(walletRes.body.data.balance).toBe(0);

    const mineRes = await request(app.getHttpServer())
      .get('/api/deposits/me')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(mineRes.body.data.items.some((d: { reference: string }) => d.reference === '000111')).toBe(true);
  });

  it('rejects a duplicate reference while the original is still PENDING or APPROVED', async () => {
    await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 3000, paymentMethod: 'Wave Pay', reference: '000222' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 3000, paymentMethod: 'Wave Pay', reference: '000222' })
      .expect(409);
  });

  it('rejects a reference that is not exactly 6 digits', async () => {
    await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 1000, paymentMethod: 'KBZ Pay', reference: '12345' })
      .expect(400);
  });

  it('a non-admin cannot approve or reject any deposit', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 2000, paymentMethod: 'KBZ Pay', reference: '000333' })
      .expect(201);
    const depositId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/deposits/${depositId}/approve`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/deposits/${depositId}/reject`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'not allowed anyway' })
      .expect(403);
  });

  it('approving credits the wallet exactly once and records a COMPLETED Transaction', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    const balanceBefore = before.body.data.balance;

    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 7500, paymentMethod: 'AYA Pay', reference: '000444' })
      .expect(201);
    const depositId = createRes.body.data.id;

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/deposits/${depositId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(approveRes.body.data.status).toBe('APPROVED');

    const after = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(after.body.data.balance).toBe(balanceBefore + 7500);

    const txns = await request(app.getHttpServer())
      .get('/api/wallet/transactions')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(
      txns.body.data.items.some(
        (t: { type: string; amount: number; status: string }) =>
          t.type === 'DEPOSIT' && t.amount === 7500 && t.status === 'COMPLETED',
      ),
    ).toBe(true);
  });

  it('approving the same deposit twice only credits the wallet once (concurrency guard)', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    const balanceBefore = before.body.data.balance;

    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 4000, paymentMethod: 'KBZ Pay', reference: '000555' })
      .expect(201);
    const depositId = createRes.body.data.id;

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`),
      request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const after = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(after.body.data.balance).toBe(balanceBefore + 4000);
  });

  it('rejecting requires a reason, leaves the balance unchanged, and stores the reason', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    const balanceBefore = before.body.data.balance;

    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 9000, paymentMethod: 'Visa/Mastercard', reference: '000666' })
      .expect(201);
    const depositId = createRes.body.data.id;

    await request(app.getHttpServer())
      .patch(`/api/deposits/${depositId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '' })
      .expect(400);

    const rejectRes = await request(app.getHttpServer())
      .patch(`/api/deposits/${depositId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Reference does not match our records' })
      .expect(200);
    expect(rejectRes.body.data.status).toBe('REJECTED');
    expect(rejectRes.body.data.rejectionReason).toBe('Reference does not match our records');

    const after = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(after.body.data.balance).toBe(balanceBefore);
  });

  it('a user only ever sees their own deposits via /deposits/me', async () => {
    const suffix = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: {
        username: `other_${suffix}`,
        password: 'unused',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: otherUser.id, balance: 0 } });
    const otherToken = await signToken(otherUser.id);

    await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ amount: 1500, paymentMethod: 'KBZ Pay', reference: '000777' })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get('/api/deposits/me')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(mine.body.data.items.some((d: { reference: string }) => d.reference === '000777')).toBe(false);

    await prisma.notification.deleteMany({ where: { userId: otherUser.id } });
    await prisma.deposit.deleteMany({ where: { userId: otherUser.id } });
    await prisma.wallet.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  // F-006: the duplicate-reference rule is enforced by the partial unique
  // index deposits_reference_active_key, so concurrent submissions cannot
  // slip past the service-level pre-check. Every count below is scoped by
  // userId as well as reference so leftovers from a crashed earlier run
  // (other users' rows) cannot skew the result.
  it('eight parallel user submissions with one reference create exactly one PENDING deposit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/api/deposits')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ amount: 2500, paymentMethod: 'KBZ Pay', reference: '001101' }),
      ),
    );

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(res.body.message).toBe(DUPLICATE_REFERENCE_MESSAGE);
    }

    expect(
      await prisma.deposit.count({
        where: { userId, reference: '001101', status: DepositStatus.PENDING },
      }),
    ).toBe(1);
  });

  it('five parallel manual deposits with one reference credit the wallet and the payment account exactly once', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    const balanceBefore = before.body.data.balance;
    const depositTxnsBefore = await prisma.transaction.count({
      where: { userId, type: 'DEPOSIT' },
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app.getHttpServer())
          .post('/api/deposits/manual')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            userId,
            amount: 1000,
            paymentMethod: 'KBZPay',
            reference: '001102',
            destinationPaymentAccountId: paymentAccountId,
          }),
      ),
    );

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(res.body.message).toBe(DUPLICATE_REFERENCE_MESSAGE);
    }

    const after = await request(app.getHttpServer())
      .get('/api/wallet')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(after.body.data.balance).toBe(balanceBefore + 1000);

    const winner = await prisma.deposit.findMany({
      where: { userId, reference: '001102', status: DepositStatus.APPROVED },
    });
    expect(winner).toHaveLength(1);
    expect(
      await prisma.paymentAccountTransaction.count({
        where: {
          paymentAccountId,
          type: PaymentAccountTransactionType.DEPOSIT_IN,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.transaction.count({ where: { userId, type: 'DEPOSIT' } }),
    ).toBe(depositTxnsBefore + 1);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'deposit.manual_create',
          targetType: 'deposit',
          targetId: winner[0].id,
        },
      }),
    ).toBe(1);
  });

  it('a user submission racing an admin manual deposit for one reference leaves exactly one live deposit', async () => {
    const [userRes, adminRes] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ amount: 2000, paymentMethod: 'KBZ Pay', reference: '001103' }),
      request(app.getHttpServer())
        .post('/api/deposits/manual')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          userId,
          amount: 2000,
          paymentMethod: 'KBZPay',
          reference: '001103',
          destinationPaymentAccountId: paymentAccountId,
        }),
    ]);

    const statuses = [userRes.status, adminRes.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    expect(
      await prisma.deposit.count({
        where: {
          userId,
          reference: '001103',
          status: { in: [DepositStatus.PENDING, DepositStatus.APPROVED] },
        },
      }),
    ).toBe(1);
  });

  it("a REJECTED deposit's reference can still be reused", async () => {
    const createRes = await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 3000, paymentMethod: 'KBZ Pay', reference: '001104' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/deposits/${createRes.body.data.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Wrong amount, please resubmit' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ amount: 3000, paymentMethod: 'KBZ Pay', reference: '001104' })
      .expect(201);
  });
});
