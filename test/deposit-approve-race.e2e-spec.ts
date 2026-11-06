import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { BankEventsService } from '../src/bank-events/bank-events.service';
import { DEPOSIT_CHANGED_DURING_APPROVAL_MESSAGE } from '../src/deposits/deposits.service';
import {
  BankTransactionState,
  DepositStatus,
  Role,
  UserStatus,
} from '../src/generated/prisma/client';

/**
 * DB-003 (audit 2026-10-09), replayed against the real test database with
 * the interleaving forced, in the style of account-races.e2e-spec.ts: the
 * phone's "You received …" event is held INSIDE its transaction right after
 * it claimed the deposit row (bank values written, row lock held, nothing
 * committed), the staff approval is started — its read still sees the row
 * without bank values — and only then is the event let go.
 *
 * Before the fix the approval's claim (`WHERE status = PENDING` only) still
 * matched the re-checked row and credited the TYPED amount past the M-15
 * decision. Now the claim is also keyed on the bankCheckedAt it read
 * (IS NULL), so it claims nothing and answers 409 "reload"; the reload then
 * runs into the mismatch rule and only the bank's amount can be credited.
 *
 * Run with --runInBand: "is someone waiting on a row lock" is read from
 * pg_stat_activity.
 */
describe('Deposit approval vs bank match (e2e: DB-003 race)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let bankEvents: BankEventsService;

  let userId: string;
  let adminId: string;
  let paymentAccountId: string;
  let userToken: string;
  let adminToken: string;

  const api = () => request(app.getHttpServer());
  const approve = (depositId: string, body: Record<string, unknown> = {}) =>
    api()
      .patch(`/api/deposits/${depositId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  const walletBalance = async () =>
    (
      await api()
        .get('/api/wallet')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200)
    ).body.data.balance as number;

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
    // Two things are in flight at once below — listen first, so supertest
    // never starts and closes its own listener under a sibling request.
    await app.listen(0);

    prisma = app.get(PrismaService);
    bankEvents = app.get(BankEventsService);
    const jwtService = app.get(JwtService);
    const configService = app.get(ConfigService);
    const signToken = (id: string) =>
      jwtService.signAsync(
        { sub: id },
        { secret: configService.get<string>('JWT_SECRET'), expiresIn: '15m' },
      );

    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        username: `race_depositor_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });
    const admin = await prisma.user.create({
      data: {
        username: `race_admin_${suffix}`,
        password: 'unused-in-these-tests',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.wallet.create({ data: { userId: admin.id, balance: 0 } });
    // The account the depositor declares and the phone posts for.
    const paymentAccount = await prisma.paymentAccount.create({
      data: {
        type: 'KBZPay',
        accountName: `Race Test Account ${suffix}`,
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    // Isolated test database — hard-delete everything this suite touched,
    // ledger rows before the account they reference (onDelete: Restrict).
    const transactionIds = (
      await prisma.bankTransaction.findMany({
        where: { paymentAccountId },
        select: { id: true },
      })
    ).map((row) => row.id);
    const depositIds = (
      await prisma.deposit.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { actorId: { in: [userId, adminId] } },
          {
            targetId: {
              in: [paymentAccountId, ...transactionIds, ...depositIds],
            },
          },
        ],
      },
    });
    await prisma.bankTransaction.deleteMany({ where: { paymentAccountId } });
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

  it('the bank event got there first: the approval waits on the row, is refused with 409 "reload", and the bank amount then goes through the M-15 decision', async () => {
    // The user claims 9,000 Ks; the bank will report 1,000.
    const reference = '730911';
    const createRes = await api()
      .post('/api/deposits')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        amount: 9000,
        paymentMethod: 'KBZ Pay',
        reference,
        paymentAccountId,
      })
      .expect(201);
    const depositId = createRes.body.data.id as string;

    // Hold the phone's event inside its transaction, right after the
    // matcher's claim wrote the bank values onto the row under its lock:
    // the first audit row of the claim is deposit.bank_match.
    const matching = gate();
    const reached = gate();
    const original = AuditService.prototype.record;
    jest
      .spyOn(AuditService.prototype, 'record')
      .mockImplementation(async function (
        this: AuditService,
        ...args: Parameters<AuditService['record']>
      ) {
        if (args[0].action === 'deposit.bank_match') {
          reached.open();
          await matching.opened;
        }
        return original.apply(this, args);
      });

    const eventKey = randomUUID().replace(/-/g, '').repeat(2);
    const posting = bankEvents.processBatch({
      events: [
        {
          idempotencyKey: eventKey,
          deviceSerial: 'E2E-PHONE',
          paymentAccountId,
          direction: 'received',
          amount: 1000,
          currency: 'MMK',
          txCode: `KBZ2026${reference}`,
          txCodeLast6: reference,
          occurredAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    await reached.opened;

    // The approval reads the row as it was committed — PENDING, no bank
    // values — and then waits on the matcher's row lock at its claim.
    const approving = approve(depositId).then((res) => res);
    await until('the approval to wait on the row the matcher holds', () =>
      someoneBlockedOn(/UPDATE.*deposits/i),
    );
    matching.open();

    const [posted, refused] = await Promise.all([posting, approving]);
    expect(posted.results[0].outcome).toBe('matched');
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe(DEPOSIT_CHANGED_DURING_APPROVAL_MESSAGE);

    // Nothing moved: the row is still PENDING, now carrying the bank's
    // values; the transfer is linked; the wallet and the ledger are untouched.
    const row = await prisma.deposit.findUniqueOrThrow({
      where: { id: depositId },
    });
    expect(row.status).toBe(DepositStatus.PENDING);
    expect(row.bankCheckedAt).not.toBeNull();
    expect(row.receivingAmount?.toNumber()).toBe(1000);
    expect(row.riskReasons).toContain('AMOUNT_MISMATCH');
    expect(row.receivingEventKey).toBe(eventKey);
    const transfer = await prisma.bankTransaction.findUniqueOrThrow({
      where: { idempotencyKey: eventKey },
    });
    expect(transfer.state).toBe(BankTransactionState.MATCHED);
    expect(transfer.linkedDepositId).toBe(depositId);
    expect(await walletBalance()).toBe(0);
    await expect(prisma.transaction.count({ where: { userId } })).resolves.toBe(
      0,
    );
    await expect(
      prisma.auditLog.count({
        where: { action: 'deposit.approve', targetId: depositId },
      }),
    ).resolves.toBe(0);

    // The reload: a plain approve now meets the mismatch rule (M-15), and
    // only an explicit, reasoned override credits — the BANK amount.
    const mismatch = await approve(depositId).expect(409);
    expect(mismatch.body.message).toContain('bank saw a different amount');
    expect(await walletBalance()).toBe(0);

    const approved = await approve(depositId, {
      creditBankAmount: true,
      overrideReason: 'Receipt shows 1,000',
    }).expect(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.amount).toBe(1000);
    expect(await walletBalance()).toBe(1000);
    const ledger = await prisma.transaction.findMany({
      where: { userId, type: 'DEPOSIT' },
    });
    expect(ledger.map((t) => t.amount.toNumber())).toEqual([1000]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'deposit.approve', targetId: depositId },
    });
    expect(audit.metadata).toMatchObject({
      creditedAmount: 1000,
      amountOverride: true,
      declaredAmount: 9000,
      bankAmount: 1000,
    });
  });
});
