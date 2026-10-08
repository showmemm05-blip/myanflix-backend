import {
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { OtpPurpose } from '../generated/prisma/client';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import {
  OTP_INVALID_MESSAGE,
  OTP_TOO_MANY_ATTEMPTS_MESSAGE,
  OtpService,
} from '../otp/otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalCodeHasher } from './withdrawal-code.hasher';
import { WithdrawalCodeService } from './withdrawal-code.service';

// Cheap hashes keep the suite fast; the "same cost as passwords" test below
// proves the service hashes with this shared constant, whatever its value.
jest.mock('../auth/password.constants', () => ({ PASSWORD_SALT_ROUNDS: 4 }));

const USER_ID = 'user-1';
const PHONE = '+959123456789';
const CODE = '582904';
const NEW_CODE = '371940';
const JWT_SECRET = 'test-jwt-secret-value';
const PEPPER = 'unit-test-withdrawal-code-pepper-0123456789';
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const T0 = new Date('2026-10-05T08:00:00.000Z');

interface Row {
  id: string;
  phone: string | null;
  withdrawalCodeHash: string | null;
  withdrawalCodeSetAt: Date | null;
  withdrawalCodeFailedCount: number;
  withdrawalCodeLockedUntil: Date | null;
}

type Where = Partial<Record<keyof Row, unknown>>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function pick(row: Row, select: Record<string, boolean>) {
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key as keyof Row]]),
  );
}

/**
 * One account row in memory. `$transaction` runs callbacks one at a time,
 * in call order — what the real `SELECT … FOR UPDATE` on the account row
 * does to parallel checks (each waits for the previous one to commit and
 * then reads its count).
 */
function makePrisma(row: Row) {
  let queue: Promise<unknown> = Promise.resolve();
  const statements: string[] = [];
  const prisma = {
    statements,
    user: {
      findUnique: jest.fn(
        ({
          where,
          select,
        }: {
          where: { id: string };
          select: Record<string, boolean>;
        }) => {
          statements.push('findUnique');
          return Promise.resolve(
            where.id === row.id ? pick(row, select) : null,
          );
        },
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          statements.push('update');
          if (where.id !== row.id) throw new Error('no such row');
          Object.assign(row, data);
          return Promise.resolve({ ...row });
        },
      ),
      updateMany: jest.fn(
        ({ where, data }: { where: Where; data: Partial<Row> }) => {
          statements.push('updateMany');
          const matches = Object.entries(where).every(([key, value]) =>
            sameValue(row[key as keyof Row], value),
          );
          if (matches) Object.assign(row, data);
          return Promise.resolve({ count: matches ? 1 : 0 });
        },
      ),
    },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(`raw:${strings.join('?')}|${values.join(',')}`);
        return Promise.resolve([{ id: row.id }]);
      },
    ),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      const run = queue.then(() => fn(prisma));
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  return prisma;
}

/** The coded refusal a promise rejected with. */
async function refusal(promise: Promise<unknown>): Promise<CodedHttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected a coded refusal, but it resolved');
}

describe('WithdrawalCodeService', () => {
  let row: Row;
  let prisma: ReturnType<typeof makePrisma>;
  let otp: { requestOtp: jest.Mock; verifyOtp: jest.Mock };
  let jwt: JwtService;
  let service: WithdrawalCodeService;

  async function setCode(code: string) {
    row.withdrawalCodeHash = await bcrypt.hash(code, 4);
    row.withdrawalCodeSetAt = new Date(T0.getTime() - 86_400_000);
  }

  function advance(ms: number) {
    jest.setSystemTime(new Date(Date.now() + ms));
  }

  beforeEach(async () => {
    // Only Date is faked: bcrypt, promises and timers run for real.
    jest.useFakeTimers({
      now: T0,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    row = {
      id: USER_ID,
      phone: PHONE,
      withdrawalCodeHash: null,
      withdrawalCodeSetAt: null,
      withdrawalCodeFailedCount: 0,
      withdrawalCodeLockedUntil: null,
    };
    prisma = makePrisma(row);
    otp = {
      requestOtp: jest.fn().mockResolvedValue(undefined),
      verifyOtp: jest.fn().mockResolvedValue(undefined),
    };
    jwt = new JwtService({});

    const moduleRef = await Test.createTestingModule({
      providers: [
        WithdrawalCodeService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otp },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET' ? JWT_SECRET : undefined,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(WithdrawalCodeService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getStatus', () => {
    it('no code yet: hasCode false, 5 tries, SMS reset possible', async () => {
      await expect(service.getStatus(USER_ID)).resolves.toEqual({
        hasCode: false,
        lockedUntil: null,
        triesLeft: 5,
        maxTries: 5,
        canResetBySms: true,
      });
    });

    it('an account without a phone cannot reset by SMS', async () => {
      row.phone = null;
      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        canResetBySms: false,
      });
    });

    it('counts the tries left, shows an active lock, and forgets a lock that ran out', async () => {
      await setCode(CODE);
      row.withdrawalCodeFailedCount = 2;
      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        hasCode: true,
        triesLeft: 3,
        lockedUntil: null,
      });

      const until = new Date(T0.getTime() + 10 * 60 * 1000);
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = until;
      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        triesLeft: 0,
        lockedUntil: until.toISOString(),
      });

      advance(10 * 60 * 1000 + 1);
      await expect(service.getStatus(USER_ID)).resolves.toMatchObject({
        triesLeft: 5,
        lockedUntil: null,
      });
    });

    it('never returns the code or its hash', async () => {
      await setCode(CODE);
      const status = await service.getStatus(USER_ID);
      const json = JSON.stringify(status);
      expect(json).not.toContain(row.withdrawalCodeHash);
      expect(json).not.toContain(CODE);
      expect(Object.keys(status).sort()).toEqual(
        [
          'canResetBySms',
          'hasCode',
          'lockedUntil',
          'maxTries',
          'triesLeft',
        ].sort(),
      );
    });
  });

  describe('create', () => {
    it('stores a bcrypt hash at the shared password cost — never the code — and answers the status', async () => {
      const status = await service.create(USER_ID, CODE, CODE);

      expect(status).toMatchObject({ hasCode: true, triesLeft: 5 });
      expect(row.withdrawalCodeHash).not.toBeNull();
      expect(row.withdrawalCodeHash).not.toContain(CODE);
      expect(bcrypt.getRounds(row.withdrawalCodeHash!)).toBe(4);
      await expect(bcrypt.compare(CODE, row.withdrawalCodeHash!)).resolves.toBe(
        true,
      );
      expect(row.withdrawalCodeSetAt).toEqual(T0);
      expect(JSON.stringify(status)).not.toContain(row.withdrawalCodeHash);
    });

    it('works without the optional confirm', async () => {
      await service.create(USER_ID, CODE);
      await expect(bcrypt.compare(CODE, row.withdrawalCodeHash!)).resolves.toBe(
        true,
      );
    });

    it('409 WITHDRAWAL_CODE_ALREADY_SET when a code exists — the old code stays', async () => {
      await setCode(CODE);
      const before = row.withdrawalCodeHash;

      const error = await refusal(service.create(USER_ID, NEW_CODE, NEW_CODE));

      expect(error.getStatus()).toBe(409);
      expect(error.code).toBe('WITHDRAWAL_CODE_ALREADY_SET');
      expect(row.withdrawalCodeHash).toBe(before);
    });

    it('two racing creates set exactly one code (conditional on "still none")', async () => {
      const results = await Promise.allSettled([
        service.create(USER_ID, CODE, CODE),
        service.create(USER_ID, NEW_CODE, NEW_CODE),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect((rejected?.reason as CodedHttpException).code).toBe(
        'WITHDRAWAL_CODE_ALREADY_SET',
      );
    });

    it.each([
      ['111111', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['123456', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['987654', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['121212', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['123123', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['12345', 'WITHDRAWAL_CODE_INVALID_FORMAT'],
      ['abcdef', 'WITHDRAWAL_CODE_INVALID_FORMAT'],
    ])('refuses %p with 400 %s and writes nothing', async (code, expected) => {
      const error = await refusal(service.create(USER_ID, code, code));

      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(expected);
      expect(row.withdrawalCodeHash).toBeNull();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('400 WITHDRAWAL_CODE_MISMATCH when the confirm entry differs ("Codes don\'t match. Start over.")', async () => {
      const error = await refusal(service.create(USER_ID, CODE, '582905'));

      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe('WITHDRAWAL_CODE_MISMATCH');
      expect(error.message).toBe("Codes don't match. Start over.");
      expect(row.withdrawalCodeHash).toBeNull();
    });
  });

  describe('checking a code (verify / assertValidForWithdrawal)', () => {
    beforeEach(() => setCode(CODE));

    it('the right code passes', async () => {
      await expect(
        service.assertValidForWithdrawal(USER_ID, CODE),
      ).resolves.toBeUndefined();
      await expect(service.verify(USER_ID, CODE)).resolves.toMatchObject({
        hasCode: true,
        triesLeft: 5,
      });
    });

    it('takes the account row FOR UPDATE as the first statement of its transaction', async () => {
      await service.assertValidForWithdrawal(USER_ID, CODE);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.statements[0]).toMatch(
        /^raw:SELECT "id" FROM "users" WHERE "id" = \? FOR UPDATE\|user-1$/,
      );
    });

    it('counts wrong codes: "Wrong code. 4 tries left." … "1 try left.", then the 5th locks for 15 minutes', async () => {
      const seen: Array<[number, string, unknown]> = [];
      for (let i = 0; i < 4; i += 1) {
        const error = await refusal(
          service.assertValidForWithdrawal(USER_ID, '111222'),
        );
        seen.push([error.getStatus(), error.message, error.extra.triesLeft]);
        expect(error.code).toBe('WITHDRAWAL_CODE_WRONG');
      }
      expect(seen).toEqual([
        [400, 'Wrong code. 4 tries left.', 4],
        [400, 'Wrong code. 3 tries left.', 3],
        [400, 'Wrong code. 2 tries left.', 2],
        [400, 'Wrong code. 1 try left.', 1],
      ]);

      const locked = await refusal(
        service.assertValidForWithdrawal(USER_ID, '111222'),
      );
      const until = new Date(T0.getTime() + FIFTEEN_MINUTES);
      expect(locked.getStatus()).toBe(423);
      expect(locked.code).toBe('WITHDRAWAL_CODE_LOCKED');
      expect(locked.message).toBe('Too many tries. Try again in 15 minutes.');
      expect(locked.extra).toEqual({
        lockedUntil: until.toISOString(),
        triesLeft: 0,
        maxTries: 5,
      });
      expect(row.withdrawalCodeFailedCount).toBe(5);
      expect(row.withdrawalCodeLockedUntil).toEqual(until);
    });

    it('while locked even the right code is refused (423) and nothing changes', async () => {
      const until = new Date(T0.getTime() + FIFTEEN_MINUTES);
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = until;
      advance(14 * 60 * 1000 + 30_000);

      const error = await refusal(
        service.assertValidForWithdrawal(USER_ID, CODE),
      );

      expect(error.getStatus()).toBe(423);
      expect(error.message).toBe('Too many tries. Try again in 1 minute.');
      expect(row.withdrawalCodeFailedCount).toBe(5);
      expect(row.withdrawalCodeLockedUntil).toEqual(until);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('after 15 minutes the lock is over and the count starts again from 0', async () => {
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = new Date(T0.getTime() + FIFTEEN_MINUTES);
      advance(FIFTEEN_MINUTES + 1);

      const wrong = await refusal(
        service.assertValidForWithdrawal(USER_ID, '111222'),
      );
      expect(wrong.code).toBe('WITHDRAWAL_CODE_WRONG');
      expect(wrong.extra.triesLeft).toBe(4);
      expect(row.withdrawalCodeLockedUntil).toBeNull();

      await service.assertValidForWithdrawal(USER_ID, CODE);
      expect(row.withdrawalCodeFailedCount).toBe(0);
    });

    it('the right code after the lock ran out unlocks and resets the count', async () => {
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = new Date(T0.getTime() + FIFTEEN_MINUTES);
      advance(FIFTEEN_MINUTES);

      await service.assertValidForWithdrawal(USER_ID, CODE);

      expect(row.withdrawalCodeFailedCount).toBe(0);
      expect(row.withdrawalCodeLockedUntil).toBeNull();
    });

    it('a right code resets the count, so wrong tries must be 5 IN A ROW', async () => {
      for (let i = 0; i < 3; i += 1) {
        await refusal(service.assertValidForWithdrawal(USER_ID, '111222'));
      }
      expect(row.withdrawalCodeFailedCount).toBe(3);

      await service.assertValidForWithdrawal(USER_ID, CODE);
      expect(row.withdrawalCodeFailedCount).toBe(0);

      const wrong = await refusal(
        service.assertValidForWithdrawal(USER_ID, '111222'),
      );
      expect(wrong.extra.triesLeft).toBe(4);
    });

    it('a right code with no wrong tries before writes nothing', async () => {
      await service.assertValidForWithdrawal(USER_ID, CODE);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('parallel guesses queue on the row lock: 10 at once give 4 WRONG, then LOCKED — never a 6th judged guess', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.assertValidForWithdrawal(USER_ID, '111222'),
        ),
      );
      const codes = results.map((r) =>
        r.status === 'rejected' ? (r.reason as CodedHttpException).code : 'OK',
      );

      expect(codes.filter((c) => c === 'WITHDRAWAL_CODE_WRONG')).toHaveLength(
        4,
      );
      expect(codes.filter((c) => c === 'WITHDRAWAL_CODE_LOCKED')).toHaveLength(
        6,
      );
      // Every judged guess writes its count; the 5 refused at the lock
      // write nothing — so exactly 5 guesses were ever judged.
      expect(prisma.user.update).toHaveBeenCalledTimes(5);
      expect(row.withdrawalCodeFailedCount).toBe(5);
    });

    it('a right code queued behind the 5th wrong one is refused too', async () => {
      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, () =>
          service.assertValidForWithdrawal(USER_ID, '111222'),
        ),
        service.assertValidForWithdrawal(USER_ID, CODE),
      ]);

      const last = results[5] as PromiseRejectedResult;
      expect(last.status).toBe('rejected');
      expect((last.reason as CodedHttpException).code).toBe(
        'WITHDRAWAL_CODE_LOCKED',
      );
    });

    it('400 WITHDRAWAL_CODE_REQUIRED when no code is sent, _INVALID_FORMAT when it is not 6 digits — and no try is used', async () => {
      const missing = await refusal(
        service.assertValidForWithdrawal(USER_ID, undefined),
      );
      expect(missing.getStatus()).toBe(400);
      expect(missing.code).toBe('WITHDRAWAL_CODE_REQUIRED');

      const empty = await refusal(
        service.assertValidForWithdrawal(USER_ID, ''),
      );
      expect(empty.code).toBe('WITHDRAWAL_CODE_REQUIRED');

      const short = await refusal(
        service.assertValidForWithdrawal(USER_ID, '12345'),
      );
      expect(short.getStatus()).toBe(400);
      expect(short.code).toBe('WITHDRAWAL_CODE_INVALID_FORMAT');

      expect(row.withdrawalCodeFailedCount).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('while locked, a missing or malformed code answers 423 LOCKED (not REQUIRED)', async () => {
      const until = new Date(T0.getTime() + FIFTEEN_MINUTES);
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = until;

      for (const code of [undefined, '12345']) {
        const error = await refusal(
          service.assertValidForWithdrawal(USER_ID, code),
        );
        expect(error.getStatus()).toBe(423);
        expect(error.extra.lockedUntil).toBe(until.toISOString());
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('409 WITHDRAWAL_CODE_NOT_SET when the account has no code — whatever was sent', async () => {
      row.withdrawalCodeHash = null;
      for (const code of [CODE, undefined, '', '12345']) {
        const error = await refusal(
          service.assertValidForWithdrawal(USER_ID, code),
        );
        expect(error.getStatus()).toBe(409);
        expect(error.code).toBe('WITHDRAWAL_CODE_NOT_SET');
      }
      const viaVerify = await refusal(service.verify(USER_ID, CODE));
      expect(viaVerify.code).toBe('WITHDRAWAL_CODE_NOT_SET');
    });

    it('verify counts toward the same lock as a withdrawal', async () => {
      await refusal(service.verify(USER_ID, '111222'));
      const viaWithdrawal = await refusal(
        service.assertValidForWithdrawal(USER_ID, '111222'),
      );
      expect(viaWithdrawal.extra.triesLeft).toBe(3);
    });

    it('never puts the code in an error', async () => {
      const error = await refusal(
        service.assertValidForWithdrawal(USER_ID, '111222'),
      );
      expect(JSON.stringify(error.getResponse())).not.toContain('111222');
      expect(JSON.stringify(error.getResponse())).not.toContain(CODE);
    });
  });

  describe('change', () => {
    beforeEach(() => setCode(CODE));

    it('right current code: the new code replaces the old one, the count is cleared and setAt moves', async () => {
      row.withdrawalCodeFailedCount = 2;

      await expect(
        service.change(USER_ID, CODE, NEW_CODE, NEW_CODE),
      ).resolves.toMatchObject({ hasCode: true, triesLeft: 5 });

      await expect(
        bcrypt.compare(NEW_CODE, row.withdrawalCodeHash!),
      ).resolves.toBe(true);
      await expect(bcrypt.compare(CODE, row.withdrawalCodeHash!)).resolves.toBe(
        false,
      );
      expect(row.withdrawalCodeFailedCount).toBe(0);
      expect(row.withdrawalCodeSetAt).toEqual(T0);
      // The swap happened inside the locked check, not as a later write.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('wrong current code: 400 WRONG with the tries left, the code is unchanged', async () => {
      const before = row.withdrawalCodeHash;

      const error = await refusal(
        service.change(USER_ID, '111222', NEW_CODE, NEW_CODE),
      );

      expect(error.code).toBe('WITHDRAWAL_CODE_WRONG');
      expect(error.extra.triesLeft).toBe(4);
      expect(row.withdrawalCodeHash).toBe(before);
    });

    it('a wrong current code with the stored code as the "new" one is just WRONG (no free extra guess)', async () => {
      const error = await refusal(
        service.change(USER_ID, '111222', CODE, CODE),
      );
      expect(error.code).toBe('WITHDRAWAL_CODE_WRONG');
    });

    it('400 WITHDRAWAL_CODE_SAME when the new code is the current one — after the current proved right', async () => {
      row.withdrawalCodeFailedCount = 1;
      const before = row.withdrawalCodeHash;

      const error = await refusal(service.change(USER_ID, CODE, CODE, CODE));

      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe('WITHDRAWAL_CODE_SAME');
      expect(error.message).toBe('Use a code different from your old one.');
      expect(row.withdrawalCodeHash).toBe(before);
      expect(row.withdrawalCodeFailedCount).toBe(0);
    });

    it.each([
      ['123456', '123456', 'WITHDRAWAL_CODE_TOO_EASY'],
      ['37194', '37194', 'WITHDRAWAL_CODE_INVALID_FORMAT'],
      [NEW_CODE, '371941', 'WITHDRAWAL_CODE_MISMATCH'],
    ])(
      'new %p / confirm %p: 400 %s before the current code is judged (no try used)',
      async (next, confirm, expected) => {
        const error = await refusal(
          service.change(USER_ID, '111222', next, confirm),
        );

        expect(error.code).toBe(expected);
        expect(row.withdrawalCodeFailedCount).toBe(0);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('locked: 423 even with the right current code', async () => {
      row.withdrawalCodeFailedCount = 5;
      row.withdrawalCodeLockedUntil = new Date(T0.getTime() + FIFTEEN_MINUTES);

      const error = await refusal(
        service.change(USER_ID, CODE, NEW_CODE, NEW_CODE),
      );

      expect(error.getStatus()).toBe(423);
      await expect(bcrypt.compare(CODE, row.withdrawalCodeHash!)).resolves.toBe(
        true,
      );
    });

    it('409 NOT_SET when there is no code to change', async () => {
      row.withdrawalCodeHash = null;
      const error = await refusal(
        service.change(USER_ID, CODE, NEW_CODE, NEW_CODE),
      );
      expect(error.code).toBe('WITHDRAWAL_CODE_NOT_SET');
    });

    it('400 INVALID_FORMAT for a malformed current code, no try used', async () => {
      const error = await refusal(
        service.change(USER_ID, '1234', NEW_CODE, NEW_CODE),
      );
      expect(error.code).toBe('WITHDRAWAL_CODE_INVALID_FORMAT');
      expect(row.withdrawalCodeFailedCount).toBe(0);
    });
  });

  describe('forgot code (SMS reset)', () => {
    beforeEach(() => setCode(CODE));

    describe('requestReset', () => {
      it('texts a WITHDRAWAL_CODE_RESET code to the account phone through OtpService', async () => {
        await expect(service.requestReset(USER_ID)).resolves.toEqual({
          sent: true,
          resendAfterSeconds: 60,
          expiresInSeconds: 300,
        });
        expect(otp.requestOtp).toHaveBeenCalledWith(
          PHONE,
          OtpPurpose.WITHDRAWAL_CODE_RESET,
        );
      });

      it('409 NOT_SET with no code (nothing to forget) — no SMS spent', async () => {
        row.withdrawalCodeHash = null;
        const error = await refusal(service.requestReset(USER_ID));
        expect(error.code).toBe('WITHDRAWAL_CODE_NOT_SET');
        expect(otp.requestOtp).not.toHaveBeenCalled();
      });

      it('409 RESET_NO_PHONE for an account without a phone', async () => {
        row.phone = null;
        const error = await refusal(service.requestReset(USER_ID));
        expect(error.getStatus()).toBe(409);
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_NO_PHONE');
        expect(otp.requestOtp).not.toHaveBeenCalled();
      });

      it("passes OtpService's cooldown / cap refusals through unchanged", async () => {
        const cooldown = new ConflictException(
          'Please wait before requesting another code',
        );
        otp.requestOtp.mockRejectedValue(cooldown);
        await expect(service.requestReset(USER_ID)).rejects.toBe(cooldown);
      });
    });

    describe('verifyReset', () => {
      it('spends the SMS code (purpose WITHDRAWAL_CODE_RESET) and returns a 10-minute reset token', async () => {
        const result = await service.verifyReset(USER_ID, '482913');

        expect(otp.verifyOtp).toHaveBeenCalledWith(
          PHONE,
          '482913',
          OtpPurpose.WITHDRAWAL_CODE_RESET,
        );
        expect(result.expiresInSeconds).toBe(600);
        expect(typeof result.resetToken).toBe('string');
      });

      it("OtpService's 401 becomes a coded 400 — a 401 would sign the user out", async () => {
        otp.verifyOtp.mockRejectedValue(
          new UnauthorizedException(OTP_INVALID_MESSAGE),
        );
        const invalid = await refusal(service.verifyReset(USER_ID, '482913'));
        expect(invalid.getStatus()).toBe(400);
        expect(invalid.code).toBe('WITHDRAWAL_CODE_RESET_SMS_INVALID');
        expect(invalid.message).toBe('Wrong or expired code. Try again.');

        otp.verifyOtp.mockRejectedValue(
          new UnauthorizedException(OTP_TOO_MANY_ATTEMPTS_MESSAGE),
        );
        const tooMany = await refusal(service.verifyReset(USER_ID, '482913'));
        expect(tooMany.getStatus()).toBe(400);
        expect(tooMany.code).toBe('WITHDRAWAL_CODE_RESET_SMS_TOO_MANY');
      });

      it('a malformed SMS code is refused without touching OtpService', async () => {
        const error = await refusal(service.verifyReset(USER_ID, '48291'));
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_SMS_INVALID');
        expect(otp.verifyOtp).not.toHaveBeenCalled();
      });

      it('409 RESET_NO_PHONE for an account without a phone', async () => {
        row.phone = null;
        const error = await refusal(service.verifyReset(USER_ID, '482913'));
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_NO_PHONE');
      });
    });

    describe('confirmReset', () => {
      it('with the reset token: sets the new code and clears the lock and the count', async () => {
        row.withdrawalCodeFailedCount = 5;
        row.withdrawalCodeLockedUntil = new Date(
          T0.getTime() + FIFTEEN_MINUTES,
        );
        const { resetToken } = await service.verifyReset(USER_ID, '482913');

        await expect(
          service.confirmReset(USER_ID, {
            resetToken,
            newCode: NEW_CODE,
            confirm: NEW_CODE,
          }),
        ).resolves.toMatchObject({
          hasCode: true,
          triesLeft: 5,
          lockedUntil: null,
        });

        await expect(
          bcrypt.compare(NEW_CODE, row.withdrawalCodeHash!),
        ).resolves.toBe(true);
        expect(row.withdrawalCodeFailedCount).toBe(0);
        expect(row.withdrawalCodeLockedUntil).toBeNull();
        expect(row.withdrawalCodeSetAt).toEqual(T0);
        // The new code works at once.
        await expect(
          service.assertValidForWithdrawal(USER_ID, NEW_CODE),
        ).resolves.toBeUndefined();
      });

      it('the token is single use: a second confirm is 400 RESET_EXPIRED', async () => {
        const { resetToken } = await service.verifyReset(USER_ID, '482913');
        await service.confirmReset(USER_ID, { resetToken, newCode: NEW_CODE });
        advance(1000);

        const error = await refusal(
          service.confirmReset(USER_ID, { resetToken, newCode: '640275' }),
        );
        expect(error.getStatus()).toBe(400);
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');
        await expect(
          bcrypt.compare(NEW_CODE, row.withdrawalCodeHash!),
        ).resolves.toBe(true);
      });

      it('a token issued before the code changed is refused', async () => {
        const { resetToken } = await service.verifyReset(USER_ID, '482913');
        advance(1000);
        await service.change(USER_ID, CODE, NEW_CODE);

        const error = await refusal(
          service.confirmReset(USER_ID, { resetToken, newCode: '640275' }),
        );
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');
      });

      it('an expired token (over 10 minutes) is refused', async () => {
        const { resetToken } = await service.verifyReset(USER_ID, '482913');
        advance(10 * 60 * 1000 + 1000);

        const error = await refusal(
          service.confirmReset(USER_ID, { resetToken, newCode: NEW_CODE }),
        );
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');
      });

      it("another account's token, a sign-in token and garbage are all refused", async () => {
        const { resetToken } = await service.verifyReset(USER_ID, '482913');
        const otherUser = await refusal(
          service.confirmReset('user-2', { resetToken, newCode: NEW_CODE }),
        );
        expect(otherUser.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');

        const accessToken = await jwt.signAsync(
          { sub: USER_ID, pur: 'withdrawal-code-reset', v: 0 },
          { secret: JWT_SECRET, expiresIn: 600 },
        );
        const signIn = await refusal(
          service.confirmReset(USER_ID, {
            resetToken: accessToken,
            newCode: NEW_CODE,
          }),
        );
        expect(signIn.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');

        const garbage = await refusal(
          service.confirmReset(USER_ID, {
            resetToken: 'not-a-token',
            newCode: NEW_CODE,
          }),
        );
        expect(garbage.code).toBe('WITHDRAWAL_CODE_RESET_EXPIRED');
        await expect(
          bcrypt.compare(CODE, row.withdrawalCodeHash!),
        ).resolves.toBe(true);
      });

      it('with the SMS code itself (one call): verifies it, then sets the code', async () => {
        await service.confirmReset(USER_ID, {
          otpCode: '482913',
          newCode: NEW_CODE,
        });

        expect(otp.verifyOtp).toHaveBeenCalledWith(
          PHONE,
          '482913',
          OtpPurpose.WITHDRAWAL_CODE_RESET,
        );
        await expect(
          bcrypt.compare(NEW_CODE, row.withdrawalCodeHash!),
        ).resolves.toBe(true);
      });

      it('a wrong SMS code in the one-call form: 400 RESET_SMS_INVALID, code unchanged', async () => {
        otp.verifyOtp.mockRejectedValue(
          new UnauthorizedException(OTP_INVALID_MESSAGE),
        );
        const error = await refusal(
          service.confirmReset(USER_ID, {
            otpCode: '482913',
            newCode: NEW_CODE,
          }),
        );
        expect(error.code).toBe('WITHDRAWAL_CODE_RESET_SMS_INVALID');
        await expect(
          bcrypt.compare(CODE, row.withdrawalCodeHash!),
        ).resolves.toBe(true);
      });

      it.each([
        ['111111', undefined, 'WITHDRAWAL_CODE_TOO_EASY'],
        [NEW_CODE, '371941', 'WITHDRAWAL_CODE_MISMATCH'],
        ['3719', undefined, 'WITHDRAWAL_CODE_INVALID_FORMAT'],
      ])(
        'new %p / confirm %p: 400 %s BEFORE the SMS code is spent',
        async (newCode, confirm, expected) => {
          const error = await refusal(
            service.confirmReset(USER_ID, {
              otpCode: '482913',
              newCode,
              confirm,
            }),
          );
          expect(error.code).toBe(expected);
          expect(otp.verifyOtp).not.toHaveBeenCalled();
        },
      );

      it('needs exactly one of resetToken / otpCode', async () => {
        await expect(
          service.confirmReset(USER_ID, { newCode: NEW_CODE }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          service.confirmReset(USER_ID, {
            newCode: NEW_CODE,
            otpCode: '482913',
            resetToken: 'x',
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(otp.verifyOtp).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * Review minor: a 6-digit code under bcrypt alone falls to an offline
   * search of all 1,000,000 values once the database leaks. With
   * WITHDRAWAL_CODE_PEPPER set, the stored hash is of an HMAC under that
   * server secret.
   */
  describe('with WITHDRAWAL_CODE_PEPPER set', () => {
    let peppered: WithdrawalCodeService;

    function serviceWith(env: Record<string, string | undefined>) {
      const config = {
        get: (key: string) => (key === 'JWT_SECRET' ? JWT_SECRET : env[key]),
      } as unknown as ConfigService;
      return new WithdrawalCodeService(
        prisma as unknown as PrismaService,
        otp as unknown as OtpService,
        jwt,
        config,
      );
    }

    beforeEach(() => {
      peppered = serviceWith({ WITHDRAWAL_CODE_PEPPER: PEPPER });
    });

    it('create stores a peppered hash: the bcrypt part is not a hash of the bare code', async () => {
      await peppered.create(USER_ID, CODE, CODE);

      const stored = row.withdrawalCodeHash!;
      expect(stored).toMatch(/^wcp1\$[0-9a-f]{8}\$\$2[aby]\$/);
      expect(stored).not.toContain(CODE);
      const bcryptPart = stored.split('$').slice(2).join('$');
      await expect(bcrypt.compare(CODE, bcryptPart)).resolves.toBe(false);
      await expect(
        peppered.assertValidForWithdrawal(USER_ID, CODE),
      ).resolves.toBeUndefined();
      const wrong = await refusal(
        peppered.assertValidForWithdrawal(USER_ID, '111222'),
      );
      expect(wrong.message).toBe('Wrong code. 4 tries left.');
    });

    it('a code saved before the pepper keeps working and is re-saved peppered on its next right entry — setAt (the reset-token version) unchanged', async () => {
      await setCode(CODE);
      const setAt = row.withdrawalCodeSetAt;

      await expect(
        peppered.assertValidForWithdrawal(USER_ID, CODE),
      ).resolves.toBeUndefined();

      expect(row.withdrawalCodeHash).toMatch(/^wcp1\$/);
      expect(row.withdrawalCodeSetAt).toEqual(setAt);
      await expect(
        new WithdrawalCodeHasher(PEPPER).compare(CODE, row.withdrawalCodeHash!),
      ).resolves.toBe('right');
      // And it still works afterwards.
      await expect(
        peppered.assertValidForWithdrawal(USER_ID, CODE),
      ).resolves.toBeUndefined();
    });

    it('a wrong code against a pre-pepper hash counts as usual and upgrades nothing', async () => {
      await setCode(CODE);
      const before = row.withdrawalCodeHash;

      const error = await refusal(
        peppered.assertValidForWithdrawal(USER_ID, '111222'),
      );

      expect(error.code).toBe('WITHDRAWAL_CODE_WRONG');
      expect(row.withdrawalCodeFailedCount).toBe(1);
      expect(row.withdrawalCodeHash).toBe(before);
    });

    it.each([
      ['changed', 'another-withdrawal-code-pepper-9876543210xyz'],
      ['removed', undefined],
    ])(
      'pepper %s: 503 WITHDRAWAL_CODE_UNAVAILABLE — never "wrong", no try used, nothing written, only ids logged',
      async (_label, pepper) => {
        await peppered.create(USER_ID, CODE, CODE);
        const before = { ...row };
        const logged = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const moved = serviceWith({ WITHDRAWAL_CODE_PEPPER: pepper });

        for (const code of [CODE, '111222']) {
          const error = await refusal(
            moved.assertValidForWithdrawal(USER_ID, code),
          );
          expect(error.getStatus()).toBe(503);
          expect(error.code).toBe('WITHDRAWAL_CODE_UNAVAILABLE');
        }
        expect(row).toEqual(before);
        expect(logged).toHaveBeenCalled();
        const lines = logged.mock.calls.map((call) => String(call[0]));
        expect(lines.join('\n')).not.toContain(CODE);
        expect(lines.join('\n')).not.toContain(row.withdrawalCodeHash!);
        logged.mockRestore();
      },
    );

    it('after a pepper change, "Forgot code" still sets a new code that works', async () => {
      await serviceWith({
        WITHDRAWAL_CODE_PEPPER: 'another-withdrawal-code-pepper-9876543210xyz',
      }).create(USER_ID, CODE, CODE);

      const { resetToken } = await peppered.verifyReset(USER_ID, '482913');
      await peppered.confirmReset(USER_ID, {
        resetToken,
        newCode: NEW_CODE,
        confirm: NEW_CODE,
      });

      await expect(
        peppered.assertValidForWithdrawal(USER_ID, NEW_CODE),
      ).resolves.toBeUndefined();
    });

    it('change saves the new code peppered', async () => {
      await peppered.create(USER_ID, CODE, CODE);

      await peppered.change(USER_ID, CODE, NEW_CODE, NEW_CODE);

      expect(row.withdrawalCodeHash).toMatch(/^wcp1\$/);
      await expect(
        peppered.assertValidForWithdrawal(USER_ID, NEW_CODE),
      ).resolves.toBeUndefined();
      const old = await refusal(
        peppered.assertValidForWithdrawal(USER_ID, CODE),
      );
      expect(old.code).toBe('WITHDRAWAL_CODE_WRONG');
    });

    it('warns at startup in production when no pepper is set — and not when one is', () => {
      const warned = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      serviceWith({ NODE_ENV: 'production', WITHDRAWAL_CODE_PEPPER: PEPPER });
      expect(warned).not.toHaveBeenCalled();
      serviceWith({ NODE_ENV: 'production' });
      expect(warned).toHaveBeenCalledWith(
        expect.stringContaining('WITHDRAWAL_CODE_PEPPER is not set'),
      );
      warned.mockRestore();
    });
  });
});
