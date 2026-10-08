import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  OTP_CODE_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TOO_MANY_ATTEMPTS_MESSAGE,
  OtpService,
} from '../otp/otp.service';
import {
  WITHDRAWAL_CODE_LOCK_MS,
  WITHDRAWAL_CODE_MAX_TRIES,
  isSixDigitCode,
  isTooEasyWithdrawalCode,
} from './withdrawal-code.rules';
import { WithdrawalCodeHasher } from './withdrawal-code.hasher';
import {
  withdrawalCodeAlreadySet,
  withdrawalCodeInvalidFormat,
  withdrawalCodeLocked,
  withdrawalCodeMismatch,
  withdrawalCodeNotSet,
  withdrawalCodeRequired,
  withdrawalCodeResetExpired,
  withdrawalCodeResetNoPhone,
  withdrawalCodeResetSmsInvalid,
  withdrawalCodeResetSmsTooMany,
  withdrawalCodeSame,
  withdrawalCodeTooEasy,
  withdrawalCodeUnavailable,
  withdrawalCodeWrong,
} from './withdrawal-code.errors';

/** What GET /users/me/withdrawal-code answers (and every successful write). */
export interface WithdrawalCodeStatus {
  /** false: the next withdrawal must create a code first. */
  hasCode: boolean;
  /** ISO time the 15-minute lock ends; null when not locked. */
  lockedUntil: string | null;
  /** Wrong codes left before the lock (0 while locked). */
  triesLeft: number;
  maxTries: number;
  /** false: no phone on the account, so "Forgot code?" cannot text one. */
  canResetBySms: boolean;
}

export interface WithdrawalCodeResetRequested {
  sent: true;
  /** The same-purpose resend wait OtpService enforces. */
  resendAfterSeconds: number;
  /** How long the SMS code works. */
  expiresInSeconds: number;
}

export interface WithdrawalCodeResetVerified {
  /** Proof for POST reset/confirm — single use, bound to this account. */
  resetToken: string;
  expiresInSeconds: number;
}

/** The step token reset/verify hands out (signed with its own secret). */
interface ResetStepPayload {
  sub: string;
  pur: typeof RESET_STEP_PURPOSE;
  /**
   * The code version it was issued against: withdrawalCodeSetAt in epoch ms
   * (0 = none). reset/confirm writes only while that is unchanged, and the
   * write moves it, so one SMS check sets at most one new code.
   */
  v: number;
}

const RESET_STEP_PURPOSE = 'withdrawal-code-reset';
const RESET_STEP_TTL_SECONDS = 10 * 60;

type CheckOutcome =
  | { kind: 'not_set' }
  | { kind: 'unavailable' }
  | { kind: 'locked'; lockedUntil: Date }
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'right' };

/** Runs inside the check's transaction, with the account row locked. */
type OnRight = (tx: Prisma.TransactionClient, now: Date) => Promise<void>;

const STATE_SELECT = {
  withdrawalCodeHash: true,
  withdrawalCodeFailedCount: true,
  withdrawalCodeLockedUntil: true,
  phone: true,
} satisfies Prisma.UserSelect;

type CodeState = Prisma.UserGetPayload<{ select: typeof STATE_SELECT }>;

function versionOf(setAt: Date | null): number {
  return setAt ? setAt.getTime() : 0;
}

/**
 * The 6-digit withdrawal code (owner-approved 2026-10-05). Every POST
 * /withdrawals, from the app and the website alike, must carry it, and only
 * the server ever judges it.
 *
 * - Stored as a bcrypt hash at the password cost, of the code mixed with
 *   the server secret WITHDRAWAL_CODE_PEPPER when that is set (see
 *   WithdrawalCodeHasher: a leaked database alone then gives no code
 *   away). The code and the hash are never returned, logged or audited.
 * - 5 wrong codes in a row lock it for 15 minutes; while locked even the
 *   right code is refused; a right code resets the count; a lock that ran
 *   out starts the count again from 0. Each check runs in ONE transaction
 *   that first takes the account row FOR UPDATE, so parallel guesses queue
 *   behind each other and each one sees the count the previous one wrote —
 *   no race lets a 6th guess through.
 * - "Forgot code": an SMS code (OtpPurpose.WITHDRAWAL_CODE_RESET, through
 *   the existing OtpService with its cooldown and caps) to the account
 *   phone, then a new code. That also clears the lock.
 *
 * Never answers 401 (clients read it as "session expired"): every refusal
 * is a coded 400/409/423 from withdrawal-code.errors.ts.
 */
@Injectable()
export class WithdrawalCodeService {
  private readonly logger = new Logger(WithdrawalCodeService.name);
  private readonly hasher: WithdrawalCodeHasher;

  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.hasher = new WithdrawalCodeHasher(
      this.configService.get<string>('WITHDRAWAL_CODE_PEPPER') || undefined,
    );
    if (
      !this.hasher.hasPepper &&
      this.configService.get<string>('NODE_ENV') === 'production'
    ) {
      this.logger.warn(
        'WITHDRAWAL_CODE_PEPPER is not set: withdrawal codes are stored with bcrypt only, so a leaked database would give them away. Set it (openssl rand -hex 32) and never change it afterwards.',
      );
    }
  }

  async getStatus(userId: string): Promise<WithdrawalCodeStatus> {
    return this.toStatus(await this.readState(userId), new Date());
  }

  /** The first code. Refused when one already exists (use change). */
  async create(
    userId: string,
    code: string,
    confirm?: string,
  ): Promise<WithdrawalCodeStatus> {
    const state = await this.readState(userId);
    if (state.withdrawalCodeHash) throw withdrawalCodeAlreadySet();
    const newCode = this.assertNewCode(code, confirm);

    const hash = await this.hasher.hash(newCode);
    // Conditional on "still no code": two racing creates set exactly one.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, withdrawalCodeHash: null },
      data: {
        withdrawalCodeHash: hash,
        withdrawalCodeSetAt: new Date(),
        withdrawalCodeFailedCount: 0,
        withdrawalCodeLockedUntil: null,
      },
    });
    if (count !== 1) throw withdrawalCodeAlreadySet();
    return this.getStatus(userId);
  }

  /** "Is this my current code?" — counts toward the lock like a withdrawal. */
  async verify(userId: string, code: string): Promise<WithdrawalCodeStatus> {
    await this.assertRight(userId, code);
    return this.getStatus(userId);
  }

  /**
   * The gate inside POST /withdrawals, before any money moves. Resolves
   * only when `code` is the account's right code; otherwise throws
   * WITHDRAWAL_CODE_NOT_SET (409), _REQUIRED / _INVALID_FORMAT / _WRONG
   * (400) or _LOCKED (423).
   */
  async assertValidForWithdrawal(
    userId: string,
    code: string | undefined,
  ): Promise<void> {
    await this.assertRight(userId, code);
  }

  /**
   * Current code -> new code. The new code's own rules are checked first
   * (no try is used up on them), then the current code under the lock. The
   * new code replaces the old one in the same locked transaction that found
   * the current one right.
   */
  async change(
    userId: string,
    currentCode: string,
    newCode: string,
    confirm?: string,
  ): Promise<WithdrawalCodeStatus> {
    const state = await this.readState(userId);
    if (!state.withdrawalCodeHash) throw withdrawalCodeNotSet();
    if (!isSixDigitCode(currentCode)) throw withdrawalCodeInvalidFormat();
    const next = this.assertNewCode(newCode, confirm);

    // Compared only AFTER the current code proved right, and then as plain
    // strings: comparing a new code against the stored hash while the
    // current one is wrong would hand out a free extra guess.
    const same = next === currentCode;
    const hash = same ? null : await this.hasher.hash(next);
    await this.assertRight(
      userId,
      currentCode,
      hash
        ? async (tx, now) => {
            await tx.user.update({
              where: { id: userId },
              data: {
                withdrawalCodeHash: hash,
                withdrawalCodeSetAt: now,
                withdrawalCodeFailedCount: 0,
                withdrawalCodeLockedUntil: null,
              },
            });
          }
        : undefined,
    );
    if (same) throw withdrawalCodeSame();
    return this.getStatus(userId);
  }

  /**
   * "Forgot code?" step 1: an SMS code to the account phone. OtpService's
   * resend cooldown (60 s, per phone and purpose), hourly cap and SMS
   * gateway refusals (409 / 503 / 400) pass through unchanged.
   */
  async requestReset(userId: string): Promise<WithdrawalCodeResetRequested> {
    const state = await this.readState(userId);
    if (!state.withdrawalCodeHash) throw withdrawalCodeNotSet();
    if (!state.phone) throw withdrawalCodeResetNoPhone();
    await this.otpService.requestOtp(
      state.phone,
      OtpPurpose.WITHDRAWAL_CODE_RESET,
    );
    return {
      sent: true,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_MS / 1000,
      expiresInSeconds: OTP_CODE_TTL_MS / 1000,
    };
  }

  /**
   * "Forgot code?" step 2 (the design checks the SMS code before the new
   * code is typed): spends the SMS code and hands back a 10-minute,
   * single-use resetToken for reset/confirm.
   */
  async verifyReset(
    userId: string,
    otpCode: string,
  ): Promise<WithdrawalCodeResetVerified> {
    const { phone, setAt } = await this.readResetState(userId);
    await this.verifyResetSms(phone, otpCode);
    const payload: ResetStepPayload = {
      sub: userId,
      pur: RESET_STEP_PURPOSE,
      v: versionOf(setAt),
    };
    const resetToken = await this.jwtService.signAsync(payload, {
      secret: this.resetStepSecret(),
      expiresIn: RESET_STEP_TTL_SECONDS,
    });
    return { resetToken, expiresInSeconds: RESET_STEP_TTL_SECONDS };
  }

  /**
   * "Forgot code?" last step: the new code, proven by the resetToken from
   * verifyReset OR by the SMS code itself. The new code's rules are checked
   * before the SMS code is spent. Clears the lock and the wrong-try count.
   */
  async confirmReset(
    userId: string,
    input: {
      newCode: string;
      confirm?: string;
      resetToken?: string;
      otpCode?: string;
    },
  ): Promise<WithdrawalCodeStatus> {
    const hasToken = Boolean(input.resetToken);
    const hasOtp = Boolean(input.otpCode);
    if (hasToken === hasOtp) {
      throw new BadRequestException(
        'Send either resetToken or otpCode, not both.',
      );
    }
    const next = this.assertNewCode(input.newCode, input.confirm);

    let version: number;
    if (input.resetToken) {
      version = await this.readResetToken(input.resetToken, userId);
    } else {
      const { phone, setAt } = await this.readResetState(userId);
      await this.verifyResetSms(phone, input.otpCode ?? '');
      version = versionOf(setAt);
    }

    const hash = await this.hasher.hash(next);
    // Writes only while the code is still the version the SMS check saw:
    // the write moves withdrawalCodeSetAt, so a replayed token (or one that
    // raced a change) matches no row.
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        withdrawalCodeSetAt: version === 0 ? null : new Date(version),
      },
      data: {
        withdrawalCodeHash: hash,
        withdrawalCodeSetAt: new Date(),
        withdrawalCodeFailedCount: 0,
        withdrawalCodeLockedUntil: null,
      },
    });
    if (count !== 1) throw withdrawalCodeResetExpired();
    return this.getStatus(userId);
  }

  // ---------------------------------------------------------------------

  private async readState(userId: string): Promise<CodeState> {
    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: STATE_SELECT,
    });
    if (!state) throw new NotFoundException('User not found');
    return state;
  }

  private toStatus(state: CodeState, now: Date): WithdrawalCodeStatus {
    const hasCode = state.withdrawalCodeHash !== null;
    const lockedUntil = state.withdrawalCodeLockedUntil;
    const locked = hasCode && lockedUntil !== null && lockedUntil > now;
    // A lock in the past means the count starts again from 0.
    const failed = lockedUntil === null ? state.withdrawalCodeFailedCount : 0;
    return {
      hasCode,
      lockedUntil: locked ? lockedUntil.toISOString() : null,
      triesLeft: locked
        ? 0
        : hasCode
          ? Math.max(0, WITHDRAWAL_CODE_MAX_TRIES - failed)
          : WITHDRAWAL_CODE_MAX_TRIES,
      maxTries: WITHDRAWAL_CODE_MAX_TRIES,
      canResetBySms: Boolean(state.phone),
    };
  }

  /** A new code: 6 digits, not too easy, and equal to `confirm` if sent. */
  private assertNewCode(code: string, confirm?: string): string {
    if (!isSixDigitCode(code)) throw withdrawalCodeInvalidFormat();
    if (isTooEasyWithdrawalCode(code)) throw withdrawalCodeTooEasy();
    if (confirm !== undefined && confirm !== code) {
      throw withdrawalCodeMismatch();
    }
    return code;
  }

  /**
   * Resolves only when `code` is the account's right code (running
   * `onRight` in the same locked transaction); throws the coded refusal
   * otherwise. "No code yet" wins over every other answer, so a client is
   * always told to create one first; then an active lock; then a missing
   * or malformed code (which never uses up a try).
   */
  private async assertRight(
    userId: string,
    code: string | undefined,
    onRight?: OnRight,
  ): Promise<void> {
    if (!isSixDigitCode(code)) {
      const state = await this.readState(userId);
      if (!state.withdrawalCodeHash) throw withdrawalCodeNotSet();
      const lockedUntil = state.withdrawalCodeLockedUntil;
      if (lockedUntil && lockedUntil > new Date()) {
        throw withdrawalCodeLocked(lockedUntil);
      }
      throw code === undefined || code === ''
        ? withdrawalCodeRequired()
        : withdrawalCodeInvalidFormat();
    }

    const outcome = await this.check(userId, code, onRight);
    switch (outcome.kind) {
      case 'right':
        return;
      case 'not_set':
        throw withdrawalCodeNotSet();
      case 'unavailable':
        // Ids only — never the code or the hash.
        this.logger.error(
          `Withdrawal code of user ${userId} cannot be checked: it was saved with a different WITHDRAWAL_CODE_PEPPER, or none is set now. Restore the earlier value; the user can also set a new code with "Forgot code".`,
        );
        throw withdrawalCodeUnavailable();
      case 'wrong':
        throw withdrawalCodeWrong(outcome.triesLeft);
      case 'locked':
        throw withdrawalCodeLocked(outcome.lockedUntil);
    }
  }

  /**
   * ONE transaction: lock the account row FOR UPDATE, read the code state,
   * judge the code, write the new count/lock (or run `onRight`). The
   * outcome is returned, not thrown, so the count a wrong code writes is
   * committed before the refusal goes out.
   */
  private check(
    userId: string,
    code: string,
    onRight?: OnRight,
  ): Promise<CheckOutcome> {
    return this.prisma.$transaction(async (tx): Promise<CheckOutcome> => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      const row = await tx.user.findUnique({
        where: { id: userId },
        select: {
          withdrawalCodeHash: true,
          withdrawalCodeFailedCount: true,
          withdrawalCodeLockedUntil: true,
        },
      });
      if (!row?.withdrawalCodeHash) return { kind: 'not_set' };

      // Read after the lock was granted: time spent queueing behind a
      // parallel guess counts.
      const now = new Date();
      const lockedUntil = row.withdrawalCodeLockedUntil;
      if (lockedUntil && lockedUntil > now) {
        return { kind: 'locked', lockedUntil };
      }
      const failedBefore = lockedUntil ? 0 : row.withdrawalCodeFailedCount;

      const match = await this.hasher.compare(code, row.withdrawalCodeHash);
      // A hash this server cannot read is no answer at all: nothing counted.
      if (match === 'unavailable') return { kind: 'unavailable' };
      if (match !== 'wrong') {
        if (onRight) {
          await onRight(tx, now);
        } else if (
          match === 'right_rehash' ||
          failedBefore !== 0 ||
          lockedUntil !== null
        ) {
          await tx.user.update({
            where: { id: userId },
            data: {
              withdrawalCodeFailedCount: 0,
              withdrawalCodeLockedUntil: null,
              // Saved before the pepper was set: store it peppered now. Same
              // code, so withdrawalCodeSetAt (the reset-token version) stays.
              ...(match === 'right_rehash'
                ? { withdrawalCodeHash: await this.hasher.hash(code) }
                : {}),
            },
          });
        }
        return { kind: 'right' };
      }

      const failed = failedBefore + 1;
      if (failed >= WITHDRAWAL_CODE_MAX_TRIES) {
        const until = new Date(now.getTime() + WITHDRAWAL_CODE_LOCK_MS);
        await tx.user.update({
          where: { id: userId },
          data: {
            withdrawalCodeFailedCount: failed,
            withdrawalCodeLockedUntil: until,
          },
        });
        // Ids only — never the code.
        this.logger.warn(
          `Withdrawal code of user ${userId} locked for 15 minutes after ${failed} wrong tries`,
        );
        return { kind: 'locked', lockedUntil: until };
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          withdrawalCodeFailedCount: failed,
          withdrawalCodeLockedUntil: null,
        },
      });
      return { kind: 'wrong', triesLeft: WITHDRAWAL_CODE_MAX_TRIES - failed };
    });
  }

  private async readResetState(
    userId: string,
  ): Promise<{ phone: string; setAt: Date | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, withdrawalCodeSetAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.phone) throw withdrawalCodeResetNoPhone();
    return { phone: user.phone, setAt: user.withdrawalCodeSetAt };
  }

  /**
   * Spends the SMS code. OtpService answers 401 for a wrong/expired/used
   * code; here that becomes a coded 400 — a 401 would sign the user out.
   */
  private async verifyResetSms(phone: string, otpCode: string): Promise<void> {
    if (!isSixDigitCode(otpCode)) throw withdrawalCodeResetSmsInvalid();
    try {
      await this.otpService.verifyOtp(
        phone,
        otpCode,
        OtpPurpose.WITHDRAWAL_CODE_RESET,
      );
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error.message === OTP_TOO_MANY_ATTEMPTS_MESSAGE
          ? withdrawalCodeResetSmsTooMany()
          : withdrawalCodeResetSmsInvalid();
      }
      throw error;
    }
  }

  /** The token's code version, or RESET_EXPIRED for anything not ours. */
  private async readResetToken(token: string, userId: string): Promise<number> {
    let payload: ResetStepPayload;
    try {
      payload = await this.jwtService.verifyAsync<ResetStepPayload>(token, {
        secret: this.resetStepSecret(),
      });
    } catch {
      throw withdrawalCodeResetExpired();
    }
    if (
      payload.pur !== RESET_STEP_PURPOSE ||
      payload.sub !== userId ||
      typeof payload.v !== 'number'
    ) {
      throw withdrawalCodeResetExpired();
    }
    return payload.v;
  }

  /** Its own secret, so no other token of this platform ever passes here. */
  private resetStepSecret(): string {
    return `${this.configService.get<string>('JWT_SECRET')}:${RESET_STEP_PURPOSE}-step`;
  }
}
