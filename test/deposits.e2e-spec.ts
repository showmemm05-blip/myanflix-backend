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
  BankTransactionState,
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

  /**
   * A phone-captured "You received …" notification, stored UNMATCHED the
   * way ingestion stores it, so a deposit submitted afterwards claims it at
   * create time (the reverse lookup). Returns the row id.
   */
  async function storeReceivedTransfer(input: {
    reference: string;
    amount: number;
    counterparty?: string | null;
  }): Promise<string> {
    const row = await prisma.bankTransaction.create({
      data: {
        idempotencyKey: randomUUID().replace(/-/g, '').repeat(2),
        deviceSerial: 'E2E-PHONE',
        paymentAccountId,
        direction: 'RECEIVED',
        amount: input.amount,
        txCode: `KBZ2026${input.reference}`,
        txCodeLast6: input.reference,
        occurredAt: new Date(Date.now() - 60_000),
        postedAt: new Date(),
        counterparty: input.counterparty ?? null,
        state: BankTransactionState.UNMATCHED,
      },
    });
    return row.id;
  }

  const walletBalance = async (token = userToken) =>
    (
      await request(app.getHttpServer())
        .get('/api/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body.data.balance as number;

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
    await prisma.bankTransaction.deleteMany({ where: { paymentAccountId } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: adminId }, { actorId: userId }] },
    });
    await prisma.paymentAccountTransaction.deleteMany({
      where: { paymentAccountId },
    });
    await prisma.paymentAccount.deleteMany({ where: { id: paymentAccountId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [userId, adminId] } },
    });
    await prisma.transaction.deleteMany({
      where: { userId: { in: [userId, adminId] } },
    });
    await prisma.deposit.deleteMany({
      where: { userId: { in: [userId, adminId] } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: { in: [userId, adminId] } },
    });
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
    expect(
      mineRes.body.data.items.some(
        (d: { reference: string }) => d.reference === '000111',
      ),
    ).toBe(true);
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
      .send({
        amount: 9000,
        paymentMethod: 'Visa/Mastercard',
        reference: '000666',
      })
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
    expect(rejectRes.body.data.rejectionReason).toBe(
      'Reference does not match our records',
    );

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
    expect(
      mine.body.data.items.some(
        (d: { reference: string }) => d.reference === '000777',
      ),
    ).toBe(false);

    await prisma.notification.deleteMany({ where: { userId: otherUser.id } });
    await prisma.deposit.deleteMany({ where: { userId: otherUser.id } });
    await prisma.wallet.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  // F-006: the duplicate-reference rule is enforced by the partial unique
  // index deposits_user_reference_active_key (one live row per user and
  // reference since H-11), so concurrent submissions cannot
  // slip past the service-level pre-check. Every count below is scoped by
  // userId as well as reference so leftovers from a crashed earlier run
  // (other users' rows) cannot skew the result.
  it('eight parallel user submissions with one reference create exactly one PENDING deposit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/api/deposits')
          .set('Authorization', `Bearer ${userToken}`)
          .send({
            amount: 2500,
            paymentMethod: 'KBZ Pay',
            reference: '001101',
          }),
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

  describe('M-11/M-14: a staff member never moves money on their own account', () => {
    it('the admin may still submit a self-service deposit, but approving or rejecting it as the same admin is 403 and credits nothing', async () => {
      const balanceBefore = await walletBalance(adminToken);
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 5000, paymentMethod: 'KBZ Pay', reference: '002001' })
        .expect(201);
      const depositId = createRes.body.data.id;

      const approve = await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
      expect(approve.body.message).toBe(
        'You cannot approve a deposit into your own account',
      );
      const reject = await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'mine' })
        .expect(403);
      expect(reject.body.message).toBe(
        'You cannot reject a deposit into your own account',
      );

      const row = await prisma.deposit.findUniqueOrThrow({
        where: { id: depositId },
      });
      expect(row.status).toBe(DepositStatus.PENDING);
      expect(await walletBalance(adminToken)).toBe(balanceBefore);
    });

    it("a manual deposit into the recording admin's own account is 403 and writes nothing", async () => {
      const balanceBefore = await walletBalance(adminToken);
      const res = await request(app.getHttpServer())
        .post('/api/deposits/manual')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          userId: adminId,
          amount: 50000,
          paymentMethod: 'KBZPay',
          reference: '002002',
          destinationPaymentAccountId: paymentAccountId,
        })
        .expect(403);
      expect(res.body.message).toBe(
        'You cannot record a deposit into your own account',
      );
      expect(await walletBalance(adminToken)).toBe(balanceBefore);
      expect(
        await prisma.deposit.count({
          where: { userId: adminId, reference: '002002' },
        }),
      ).toBe(0);
    });

    it('a manual deposit into another STAFF account is 403 — manual deposits are for customers only', async () => {
      const suffix = randomUUID().slice(0, 8);
      const colleague = await prisma.user.create({
        data: {
          username: `colleague_${suffix}`,
          password: 'unused-in-these-tests',
          role: Role.ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      await prisma.wallet.create({
        data: { userId: colleague.id, balance: 0 },
      });
      try {
        const res = await request(app.getHttpServer())
          .post('/api/deposits/manual')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            userId: colleague.id,
            amount: 50000,
            paymentMethod: 'KBZPay',
            reference: '002003',
            destinationPaymentAccountId: paymentAccountId,
          })
          .expect(403);
        expect(res.body.message).toBe(
          'Manual deposits can only be recorded for customer accounts',
        );
        const wallet = await prisma.wallet.findUniqueOrThrow({
          where: { userId: colleague.id },
        });
        expect(wallet.balance.toNumber()).toBe(0);
      } finally {
        await prisma.wallet.deleteMany({ where: { userId: colleague.id } });
        await prisma.user.delete({ where: { id: colleague.id } });
      }
    });
  });

  describe('M-15/M-7: the bank saw a different amount than the user typed', () => {
    it('plain approve is refused (409) and leaves the row PENDING; the override credits the BANK amount and is audited with the reason', async () => {
      const balanceBefore = await walletBalance();
      // The user sends 1,000 Ks but claims 9,000.
      await storeReceivedTransfer({ reference: '002101', amount: 1000 });
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 9000,
          paymentMethod: 'KBZ Pay',
          reference: '002101',
          paymentAccountId,
        })
        .expect(201);
      const depositId = createRes.body.data.id;
      const flagged = await prisma.deposit.findUniqueOrThrow({
        where: { id: depositId },
      });
      expect(flagged.receivingAmount?.toNumber()).toBe(1000);
      expect(flagged.riskReasons).toContain('AMOUNT_MISMATCH');

      const refused = await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(refused.body.message).toContain('bank saw a different amount');
      const noReason = await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ creditBankAmount: true })
        .expect(400);
      expect(noReason.body.message).toContain('reason is required');
      expect(
        (await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } }))
          .status,
      ).toBe(DepositStatus.PENDING);
      expect(await walletBalance()).toBe(balanceBefore);

      const approved = await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ creditBankAmount: true, overrideReason: 'Receipt shows 1,000' })
        .expect(200);
      expect(approved.body.data.status).toBe('APPROVED');
      expect(approved.body.data.amount).toBe(1000);
      expect(await walletBalance()).toBe(balanceBefore + 1000);

      const ledger = await prisma.transaction.findMany({
        where: { userId, type: 'DEPOSIT' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(ledger[0].amount.toNumber()).toBe(1000);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'deposit.approve', targetId: depositId },
      });
      expect(audit.metadata).toMatchObject({
        creditedAmount: 1000,
        amountOverride: true,
        declaredAmount: 9000,
        bankAmount: 1000,
        overrideReason: 'Receipt shows 1,000',
      });
    });

    it('when the amounts agree, approve needs no flag and credits as before', async () => {
      const balanceBefore = await walletBalance();
      await storeReceivedTransfer({ reference: '002102', amount: 2500 });
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 2500,
          paymentMethod: 'KBZ Pay',
          reference: '002102',
          paymentAccountId,
        })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/deposits/${createRes.body.data.id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(await walletBalance()).toBe(balanceBefore + 2500);
    });
  });

  describe('M-17: rejecting a deposit gives its bank transfer back', () => {
    it('the transfer returns to UNMATCHED, the rejected row drops its bank values, and an honest resubmission claims the transfer again', async () => {
      const transactionId = await storeReceivedTransfer({
        reference: '002201',
        amount: 3000,
      });
      const first = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 3000,
          paymentMethod: 'KBZ Pay',
          reference: '002201',
          paymentAccountId,
        })
        .expect(201);
      const firstId = first.body.data.id;
      expect(
        (
          await prisma.bankTransaction.findUniqueOrThrow({
            where: { id: transactionId },
          })
        ).linkedDepositId,
      ).toBe(firstId);

      await request(app.getHttpServer())
        .patch(`/api/deposits/${firstId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Rejected by mistake' })
        .expect(200);

      const transaction = await prisma.bankTransaction.findUniqueOrThrow({
        where: { id: transactionId },
      });
      expect(transaction.state).toBe(BankTransactionState.UNMATCHED);
      expect(transaction.linkedDepositId).toBeNull();
      const rejected = await prisma.deposit.findUniqueOrThrow({
        where: { id: firstId },
      });
      expect(rejected.status).toBe(DepositStatus.REJECTED);
      expect(rejected.bankCheckedAt).toBeNull();
      expect(rejected.receivingEventKey).toBeNull();
      expect(rejected.receivingAmount).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { action: 'bank_transaction.unlink', targetId: transactionId },
        }),
      ).toBe(1);

      const second = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 3000,
          paymentMethod: 'KBZ Pay',
          reference: '002201',
          paymentAccountId,
        })
        .expect(201);
      const resubmitted = await prisma.deposit.findUniqueOrThrow({
        where: { id: second.body.data.id },
      });
      expect(resubmitted.bankCheckedAt).not.toBeNull();
      expect(resubmitted.receivingAmount?.toNumber()).toBe(3000);
      expect(
        (
          await prisma.bankTransaction.findUniqueOrThrow({
            where: { id: transactionId },
          })
        ).linkedDepositId,
      ).toBe(resubmitted.id);
    });
  });

  describe("M-16: the bank's sender name is compared with the depositor's name (soft)", () => {
    afterEach(async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { displayName: null },
      });
    });

    it('a different sender name adds COUNTERPARTY_MISMATCH (needs review, never blocked) and the admin row shows both names', async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { displayName: 'Ko Ko Aung' },
      });
      await storeReceivedTransfer({
        reference: '002301',
        amount: 4000,
        counterparty: 'MAUNG MAUNG',
      });
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 4000,
          paymentMethod: 'KBZ Pay',
          reference: '002301',
          paymentAccountId,
        })
        .expect(201);
      const depositId = createRes.body.data.id;

      const adminView = await request(app.getHttpServer())
        .get(`/api/deposits/${depositId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(adminView.body.data.riskReasons).toContain(
        'COUNTERPARTY_MISMATCH',
      );
      expect(adminView.body.data.matchStatus).toBe('PENDING_REVIEW');
      expect(adminView.body.data.bankCounterparty).toBe('MAUNG MAUNG');
      expect(adminView.body.data.user.displayName).toBe('Ko Ko Aung');

      // Soft: approve still goes through (no amount mismatch here).
      await request(app.getHttpServer())
        .patch(`/api/deposits/${depositId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it("a sender name that contains the depositor's name is a clean match", async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { displayName: 'Ko Ko Aung' },
      });
      await storeReceivedTransfer({
        reference: '002302',
        amount: 4000,
        counterparty: 'U KO KO AUNG',
      });
      const createRes = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          amount: 4000,
          paymentMethod: 'KBZ Pay',
          reference: '002302',
          paymentAccountId,
        })
        .expect(201);
      const row = await prisma.deposit.findUniqueOrThrow({
        where: { id: createRes.body.data.id },
      });
      // The suite's own burst of submissions may add VELOCITY; the name
      // check itself must stay silent.
      expect(row.bankCheckedAt).not.toBeNull();
      expect(row.riskReasons).not.toContain('COUNTERPARTY_MISMATCH');
    });
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
