// Must stay the FIRST import: it sets BANK_EVENTS_TOKEN before AppModule
// (and its ConfigModule) is loaded, for the phone-monitor cases below.
import { E2E_BANK_EVENTS_TOKEN } from './bank-events.e2e-env';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MinioService } from '../src/common/storage/minio.service';
import {
  BankTransactionState,
  DepositStatus,
  PaymentAccountTransactionType,
  Role,
  UserStatus,
} from '../src/generated/prisma/client';

const DUPLICATE_REFERENCE_MESSAGE =
  'A deposit with this transaction reference already exists';

/** The 8-byte PNG signature plus padding — all the screenshot route sniffs. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

describe('Deposits (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;

  let userId: string;
  let adminId: string;
  let superAdminId: string;
  let paymentAccountId: string;
  let userToken: string;
  let adminToken: string;
  let superAdminToken: string;

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

    // The owner: resets the phone-monitor's device pin (SEC-004) —
    // SETTINGS.MANAGE and the SUPER_ADMIN role itself, like the SMS reset.
    const superAdminRole = await prisma.appRole.findUniqueOrThrow({
      where: { key: Role.SUPER_ADMIN },
    });
    const superAdmin = await prisma.user.create({
      data: {
        username: `superadmin_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.SUPER_ADMIN,
        appRoleId: superAdminRole.id,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({
      data: { userId: superAdmin.id, balance: 0 },
    });
    // This suite owns bank_events_binding in the test database.
    await prisma.bankEventsBinding.deleteMany({});

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
    superAdminId = superAdmin.id;
    paymentAccountId = paymentAccount.id;
    userToken = await signToken(user.id);
    adminToken = await signToken(admin.id);
    superAdminToken = await signToken(superAdmin.id);
  });

  afterAll(async () => {
    // Isolated test database — safe to hard-delete everything this suite touched.
    // Ledger rows first: payment_account_transactions.paymentAccountId is
    // onDelete: Restrict, so the account cannot go before its entries.
    await prisma.bankTransaction.deleteMany({ where: { paymentAccountId } });
    await prisma.bankEventsBinding.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: adminId },
          { actorId: userId },
          { actorId: superAdminId },
          // System rows of the phone-monitor cases (actor null).
          { action: 'bank_events.rejected_device' },
        ],
      },
    });
    await prisma.paymentAccountTransaction.deleteMany({
      where: { paymentAccountId },
    });
    await prisma.paymentAccount.deleteMany({ where: { id: paymentAccountId } });
    await prisma.notification.deleteMany({
      where: { userId: { in: [userId, adminId, superAdminId] } },
    });
    await prisma.transaction.deleteMany({
      where: { userId: { in: [userId, adminId, superAdminId] } },
    });
    await prisma.deposit.deleteMany({
      where: { userId: { in: [userId, adminId, superAdminId] } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: { in: [userId, adminId, superAdminId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, adminId, superAdminId] } },
    });
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
  describe('SEC-004: the phone-monitor token is pinned to ONE device serial, and no green badge without a screenshot', () => {
    /** The owner's phone-monitor (a uuid it generated once) and two intruders'. */
    const MONITOR = randomUUID();
    const OTHER_MONITOR = randomUUID();
    const THIRD_MONITOR = randomUUID();
    const eventKey = () => randomUUID().replace(/-/g, '').repeat(2);
    const asMonitor = (serial?: string, token = E2E_BANK_EVENTS_TOKEN) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (serial) headers['X-Device-Serial'] = serial;
      return headers;
    };
    const receivedEvent = (
      reference: string,
      amount: number,
      idempotencyKey = eventKey(),
    ) => ({
      idempotencyKey,
      deviceSerial: 'E2E-PHONE',
      paymentAccountId,
      direction: 'received',
      amount,
      currency: 'MMK',
      txCode: `KBZ2026${reference}`,
      txCodeLast6: reference,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      postedAt: new Date().toISOString(),
    });
    const postEvents = (serial: string | undefined, events: unknown[]) =>
      request(app.getHttpServer())
        .post('/api/bank-events/match')
        .set(asMonitor(serial))
        .send({ events });
    const listAccounts = (serial?: string, token?: string) =>
      request(app.getHttpServer())
        .get('/api/bank-events/accounts')
        .set(asMonitor(serial, token));
    const uploadScreenshot = (
      serial: string | undefined,
      transactionId: string,
      idempotencyKey: string,
    ) =>
      request(app.getHttpServer())
        .post(`/api/bank-events/transactions/${transactionId}/screenshot`)
        .set(asMonitor(serial))
        .field('idempotencyKey', idempotencyKey)
        .field('deviceSerial', 'E2E-PHONE')
        .attach('file', PNG, {
          filename: 'shot.png',
          contentType: 'image/png',
        });
    const bindingRow = () =>
      prisma.bankEventsBinding.findUnique({ where: { id: 1 } });
    const getBinding = (token?: string) => {
      const call = request(app.getHttpServer()).get('/api/bank-events/binding');
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };
    const resetBinding = (token?: string) => {
      const call = request(app.getHttpServer()).delete(
        '/api/bank-events/binding',
      );
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };
    const adminView = async (depositId: string) =>
      (
        await request(app.getHttpServer())
          .get(`/api/deposits/${depositId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200)
      ).body.data;

    /**
     * A FRESH customer per case: the suite's own burst of submissions by
     * the shared user adds VELOCITY, and these cases assert the exact
     * reason list (and a clean MATCHED). Cleaned up in afterAll.
     */
    const depositors: string[] = [];
    const newDepositor = async () => {
      const user = await prisma.user.create({
        data: {
          username: `sec004_${randomUUID().slice(0, 8)}`,
          password: 'unused-in-these-tests',
          role: Role.USER,
          status: UserStatus.ACTIVE,
        },
      });
      await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });
      depositors.push(user.id);
      return { id: user.id, token: await signToken(user.id) };
    };
    const submitDeposit = async (
      token: string,
      reference: string,
      amount: number,
    ): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount, paymentMethod: 'KBZ Pay', reference, paymentAccountId })
        .expect(201);
      return res.body.data.id as string;
    };

    let uploadSpy: jest.SpyInstance;
    beforeAll(() => {
      // No MinIO behind the e2e stack: the bytes are not the point here, the
      // pointer and the re-score are. The route still sniffs the PNG header.
      uploadSpy = jest
        .spyOn(MinioService.prototype, 'uploadBuffer')
        .mockResolvedValue(undefined);
    });
    afterAll(async () => {
      uploadSpy.mockRestore();
      await prisma.transaction.deleteMany({
        where: { userId: { in: depositors } },
      });
      await prisma.deposit.deleteMany({
        where: { userId: { in: depositors } },
      });
      await prisma.wallet.deleteMany({ where: { userId: { in: depositors } } });
      await prisma.user.deleteMany({ where: { id: { in: depositors } } });
    });

    it('a right token with no (or a malformed) X-Device-Serial is 401 DEVICE_SERIAL_REQUIRED on every route, and pins nothing', async () => {
      const calls = [
        postEvents(undefined, [receivedEvent('003001', 1000)]),
        listAccounts(undefined),
        uploadScreenshot(undefined, randomUUID(), eventKey()),
        listAccounts('short'),
        listAccounts('has space in it'),
      ];
      for (const call of calls) {
        const res = await call.expect(401);
        expect(res.body).toEqual({
          success: false,
          message: 'DEVICE_SERIAL_REQUIRED',
        });
      }
      // A wrong token never reaches the pin, with or without a serial.
      const wrong = await listAccounts(MONITOR, 'not-the-token').expect(401);
      expect(wrong.body.message).toBe('Invalid machine token');
      expect(await bindingRow()).toBeNull();
      expect(
        await prisma.bankTransaction.count({
          where: { txCodeLast6: '003001' },
        }),
      ).toBe(0);
    });

    it("the first monitor to present the token is pinned, and the owner's card names it (staff read: SETTINGS.VIEW)", async () => {
      await listAccounts(MONITOR).expect(200);

      expect(await bindingRow()).toMatchObject({
        deviceSerial: MONITOR,
        lastRejectedDeviceSerial: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      });
      await getBinding().expect(401);
      await getBinding(userToken).expect(403);
      await getBinding(adminToken).expect(403);
      const card = await getBinding(superAdminToken).expect(200);
      expect(card.body.data).toMatchObject({
        deviceSerial: MONITOR,
        lastRejectedDeviceSerial: null,
        lastRejectedAt: null,
        rejectedCount: 0,
        resetAt: null,
      });
      expect(Date.parse(card.body.data.pinnedAt)).not.toBeNaN();
      // Posting again as the pinned monitor writes nothing new.
      await listAccounts(MONITOR).expect(200);
      expect((await bindingRow())!.rejectedCount).toBe(0);
    });

    it('a second monitor gets 401 DEVICE_SERIAL_REJECTED on every route, is noted for the card and audited as bank_events.rejected_device — the pinned monitor is unaffected', async () => {
      const calls = [
        postEvents(OTHER_MONITOR, [receivedEvent('003002', 1000)]),
        listAccounts(OTHER_MONITOR),
        uploadScreenshot(OTHER_MONITOR, randomUUID(), eventKey()),
      ];
      for (const call of calls) {
        const res = await call.expect(401);
        expect(res.body).toEqual({
          success: false,
          message: 'DEVICE_SERIAL_REJECTED',
        });
      }

      expect(await bindingRow()).toMatchObject({
        deviceSerial: MONITOR,
        lastRejectedDeviceSerial: OTHER_MONITOR,
        rejectedCount: 3,
      });
      // Three refusals within a second from ONE serial are one burst: one
      // audit row (the counter above still says 3). A stray monitor on the
      // un-throttled socket handshake cannot grow audit_logs without bound.
      const audit = await prisma.auditLog.findMany({
        where: { action: 'bank_events.rejected_device' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: null,
        category: 'SYSTEM',
        targetType: 'bank_events',
        targetId: null,
        metadata: expect.objectContaining({
          deviceSerial: OTHER_MONITOR,
          pinnedDeviceSerial: MONITOR,
        }),
      });
      const card = await getBinding(superAdminToken).expect(200);
      expect(card.body.data).toMatchObject({
        deviceSerial: MONITOR,
        lastRejectedDeviceSerial: OTHER_MONITOR,
        rejectedCount: 3,
      });
      expect(
        Date.now() - Date.parse(card.body.data.lastRejectedAt),
      ).toBeLessThan(10_000);
      // Nothing of the intruder's was stored; the real monitor still posts.
      expect(
        await prisma.bankTransaction.count({
          where: { txCodeLast6: '003002' },
        }),
      ).toBe(0);
      await listAccounts(MONITOR).expect(200);

      // A DIFFERENT serial is a new burst: its own audit row, counted too.
      const third = await listAccounts(THIRD_MONITOR).expect(401);
      expect(third.body.message).toBe('DEVICE_SERIAL_REJECTED');
      const after = await prisma.auditLog.findMany({
        where: { action: 'bank_events.rejected_device' },
        orderBy: { createdAt: 'asc' },
      });
      expect(after).toHaveLength(2);
      expect(after[1].metadata).toMatchObject({
        deviceSerial: THIRD_MONITOR,
        pinnedDeviceSerial: MONITOR,
      });
      expect(await bindingRow()).toMatchObject({
        deviceSerial: MONITOR,
        lastRejectedDeviceSerial: THIRD_MONITOR,
        rejectedCount: 4,
      });
    });

    it('reset: 401 without a token, 403 for a customer and for a plain admin; a super admin clears the pin (audited), the next monitor is pinned and the old one refused', async () => {
      await resetBinding().expect(401);
      await resetBinding(userToken).expect(403);
      await resetBinding(adminToken).expect(403);
      expect((await bindingRow())!.deviceSerial).toBe(MONITOR);

      const reset = await resetBinding(superAdminToken).expect(200);
      expect(reset.body.data).toMatchObject({
        deviceSerial: null,
        pinnedAt: null,
        lastRejectedDeviceSerial: null,
        lastRejectedAt: null,
        rejectedCount: 0,
      });
      expect(Date.parse(reset.body.data.resetAt)).not.toBeNaN();
      const audit = await prisma.auditLog.findMany({
        where: { action: 'bank_events.binding_reset' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: superAdminId,
        category: 'SYSTEM',
        targetType: 'bank_events',
        before: expect.objectContaining({ deviceSerial: MONITOR }),
        after: expect.objectContaining({ deviceSerial: null }),
      });

      // The reinstalled monitor (a new serial) registers; the old one is out.
      await listAccounts(OTHER_MONITOR).expect(200);
      expect((await bindingRow())!.deviceSerial).toBe(OTHER_MONITOR);
      const refused = await listAccounts(MONITOR).expect(401);
      expect(refused.body.message).toBe('DEVICE_SERIAL_REJECTED');
      expect((await bindingRow())!.lastRejectedDeviceSerial).toBe(MONITOR);

      // And back, so the rest of the story runs on MONITOR.
      await resetBinding(superAdminToken).expect(200);
      await listAccounts(MONITOR).expect(200);
      expect((await bindingRow())!.deviceSerial).toBe(MONITOR);
      await listAccounts(OTHER_MONITOR).expect(401);
    });

    it('no screenshot → the matched deposit waits in PENDING_REVIEW (NO_SCREENSHOT), and the screenshot upload promotes it to MATCHED / LOW', async () => {
      const depositor = await newDepositor();
      const depositId = await submitDeposit(depositor.token, '003101', 3000);
      const key = eventKey();

      const posted = await postEvents(MONITOR, [
        receivedEvent('003101', 3000, key),
      ]).expect(201);
      const result = posted.body.data.results[0];
      expect(result).toMatchObject({
        idempotencyKey: key,
        outcome: 'matched',
        state: 'MATCHED',
        depositId,
        matchStatus: 'PENDING_REVIEW',
        screenshotWanted: true,
      });

      let view = await adminView(depositId);
      expect(view).toMatchObject({
        matchStatus: 'PENDING_REVIEW',
        riskLevel: 'LOW',
        riskReasons: ['NO_SCREENSHOT'],
        hasBankScreenshot: false,
        receivingAmount: 3000,
        bankTransactionId: result.transactionId,
        bankDeviceSerial: 'E2E-PHONE',
      });

      const uploaded = await uploadScreenshot(
        MONITOR,
        result.transactionId,
        key,
      ).expect(201);
      expect(uploaded.body.data).toEqual({ uploaded: true });
      expect(uploadSpy).toHaveBeenCalled();

      view = await adminView(depositId);
      expect(view).toMatchObject({
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
        riskReasons: [],
        hasBankScreenshot: true,
      });
      const rescore = await prisma.auditLog.findMany({
        where: { action: 'deposit.risk_update', targetId: depositId },
      });
      expect(rescore).toHaveLength(1);
      expect(rescore[0]).toMatchObject({
        actorId: null,
        before: expect.objectContaining({ riskReasons: ['NO_SCREENSHOT'] }),
        after: expect.objectContaining({
          matchStatus: 'MATCHED',
          riskReasons: [],
        }),
        metadata: expect.objectContaining({ trigger: 'screenshot_attach' }),
      });

      // A re-upload (the monitor's retry) changes nothing.
      const again = await uploadScreenshot(
        MONITOR,
        result.transactionId,
        key,
      ).expect(201);
      expect(again.body.data).toEqual({
        uploaded: false,
        alreadyUploaded: true,
      });
      expect((await adminView(depositId)).matchStatus).toBe('MATCHED');
    });

    it('screenshot before the deposit: the picture lands on the stored transaction, and the deposit submitted afterwards is MATCHED straight away', async () => {
      const depositor = await newDepositor();
      const key = eventKey();
      const posted = await postEvents(MONITOR, [
        receivedEvent('003102', 3500, key),
      ]).expect(201);
      expect(posted.body.data.results[0]).toMatchObject({
        outcome: 'stored_unmatched',
        screenshotWanted: true,
      });
      const transactionId = posted.body.data.results[0].transactionId;
      await uploadScreenshot(MONITOR, transactionId, key).expect(201);

      const depositId = await submitDeposit(depositor.token, '003102', 3500);
      expect(await adminView(depositId)).toMatchObject({
        matchStatus: 'MATCHED',
        riskLevel: 'LOW',
        riskReasons: [],
        hasBankScreenshot: true,
        bankTransactionId: transactionId,
      });
    });

    it('a hard reason is not washed away by the picture: AMOUNT_MISMATCH + no screenshot is SUSPICIOUS, and stays SUSPICIOUS (AMOUNT_MISMATCH only) after the upload', async () => {
      const depositor = await newDepositor();
      const depositId = await submitDeposit(depositor.token, '003103', 9000);
      const key = eventKey();
      const posted = await postEvents(MONITOR, [
        receivedEvent('003103', 1000, key),
      ]).expect(201);
      const result = posted.body.data.results[0];
      expect(result.matchStatus).toBe('SUSPICIOUS');
      expect((await adminView(depositId)).riskReasons).toEqual([
        'AMOUNT_MISMATCH',
        'NO_SCREENSHOT',
      ]);

      await uploadScreenshot(MONITOR, result.transactionId, key).expect(201);
      expect(await adminView(depositId)).toMatchObject({
        matchStatus: 'SUSPICIOUS',
        riskLevel: 'HIGH',
        riskReasons: ['AMOUNT_MISMATCH'],
        hasBankScreenshot: true,
      });
    });
  });
});
