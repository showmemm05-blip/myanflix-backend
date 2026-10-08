import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomInt } from 'node:crypto';
import { OtpPurpose, SmsMessageStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TOO_MANY_CODE_REQUESTS_MESSAGE } from '../sms/sms.config';
import { type AfterCommit, SmsService } from '../sms/sms.service';
import { maskPhoneNumber } from '../tracking/pii.util';
import {
  OTP_CODE_PEPPER_ENV,
  OtpCodeHasher,
  resolveOtpCodePepper,
} from './otp-code.hasher';
import { OTP_DEV_CODE_WARNING, resolveOtpDevCode } from './otp-dev-code';

const CODE_LENGTH = 6;
/** How long a code works — exported so a caller can tell the client. */
export const OTP_CODE_TTL_MS = 5 * 60 * 1000;
/** The per phone-and-purpose resend wait — exported for the same reason. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const CODE_TTL_MS = OTP_CODE_TTL_MS;
const RESEND_COOLDOWN_MS = OTP_RESEND_COOLDOWN_MS;
const MAX_REQUESTS_PER_HOUR = 8;
const MAX_VERIFY_ATTEMPTS = 5;
/**
 * How long a row is kept before the nightly sweep deletes it. Far past the
 * 5-minute code life and the 1-hour request cap window, which is all a row
 * is ever read for; a consumed or expired row is only a hash by then, but
 * there is no reason to keep it.
 */
export const OTP_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * verifyOtp's two refusals (both 401). Exported so a signed-in flow that
 * must not answer 401 (clients treat 401 as "session expired") can tell
 * them apart without matching free text.
 */
export const OTP_INVALID_MESSAGE = 'Invalid or expired code';
export const OTP_TOO_MANY_ATTEMPTS_MESSAGE =
  'Too many incorrect attempts — request a new code';

function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  /** M-1: only a keyed hash of a code is ever stored (otp-code.hasher.ts). */
  private readonly hasher: OtpCodeHasher;
  /**
   * OTP_DEV_CODE (otp-dev-code.ts): the fixed code every request stores
   * while it is set, with no SMS sent. Undefined = normal operation.
   */
  private readonly devCode: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly configService: ConfigService,
  ) {
    const pepper = resolveOtpCodePepper(this.configService);
    this.hasher = new OtpCodeHasher(pepper.secret);
    if (
      pepper.derivedFromJwtSecret &&
      this.configService.get<string>('NODE_ENV') === 'production'
    ) {
      this.logger.warn(
        `${OTP_CODE_PEPPER_ENV} is not set: SMS codes are hashed under a key derived from JWT_SECRET instead. Set it (openssl rand -hex 32) so a leaked JWT_SECRET does not also give live codes away; changing it only invalidates codes still in flight (they live 5 minutes).`,
      );
    }
    // Throws (no boot) for a malformed value or a public deployment.
    this.devCode = resolveOtpDevCode(this.configService);
    if (this.devCode !== undefined) this.logger.warn(OTP_DEV_CODE_WARNING);
  }

  /**
   * Generates and stores a code for `phone`, bound to `purpose`, then hands
   * it to SmsService for delivery. Expects an already-normalized phone. The
   * resend cooldown counts only codes of the same purpose, so a sign-in code
   * never holds up a reset code (or the other way round); the hourly cap
   * counts every code for the phone, whatever it was requested for.
   *
   * All of it is ONE transaction, serialised per phone by an advisory lock
   * taken first (B2): the cooldown and hourly checks, the code row, the
   * queued SMS and the cancel below see and write one consistent state, so
   * a double tap or a client retry creates one code and queues one SMS —
   * the second request waits for the first, then gets the 409 cooldown
   * answer. The lock is per phone rather than per phone and purpose so the
   * hourly (and the gateway's per-phone daily) cap, which span both
   * purposes, are atomic too; different phones never wait for each other.
   *
   * B1: the new code replaces every older code of the same phone and
   * purpose (verifyOtp accepts only the newest), so their SMS still QUEUED
   * are CANCELLED — the phone never sends a stale code. A LEASED one is
   * left alone: the phone may already be sending it.
   *
   * When SmsService refuses (503 offline/daily cap, 409 per-phone cap, 400
   * not a Myanmar mobile), the transaction rolls back: no code row, no
   * cancelled SMS, and neither the cooldown nor the hourly allowance spent.
   *
   * OTP_DEV_CODE (local development only): the stored code is that fixed
   * code instead of a random one — hashed and checked exactly like a real
   * one — and SmsService is never called, so nothing is sent or queued for
   * the gateway phone and none of its caps or refusals apply. The lock, the
   * cooldown, the hourly cap and B1's cancel of older queued SMS still run.
   */
  async requestOtp(
    phone: string,
    purpose: OtpPurpose = OtpPurpose.LOGIN,
  ): Promise<void> {
    const afterCommit = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('otp_codes.request'), hashtext(${phone}))`;

      const mostRecent = await tx.otpCode.findFirst({
        where: { phone, purpose },
        orderBy: { createdAt: 'desc' },
      });
      if (
        mostRecent &&
        Date.now() - mostRecent.createdAt.getTime() < RESEND_COOLDOWN_MS
      ) {
        throw new ConflictException(
          'Please wait before requesting another code',
        );
      }

      const windowStart = new Date(Date.now() - 60 * 60 * 1000);
      const requestsThisHour = await tx.otpCode.count({
        where: { phone, createdAt: { gte: windowStart } },
      });
      if (requestsThisHour >= MAX_REQUESTS_PER_HOUR) {
        throw new ConflictException(TOO_MANY_CODE_REQUESTS_MESSAGE);
      }

      // M-1: the row holds a keyed hash of the code, never the code. The
      // digits themselves go only to the SMS text below.
      const code = this.devCode ?? generateCode();
      const otp = await tx.otpCode.create({
        data: {
          phone,
          codeHash: this.hasher.hash(phone, code),
          purpose,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });

      const wakeGateway: AfterCommit =
        this.devCode !== undefined
          ? this.skipSmsForDevCode(phone, purpose)
          : await this.smsService.sendWithin(
              tx,
              phone,
              // "MyanFlix: 482 913". The space is on purpose: Myanmar
              // operators silently dropped SMS from the company SIM that
              // carried the code as one 6-digit block, while this form
              // arrived (owner's real tests on 2026-10-01). The code-entry
              // fields and the verify/reset DTOs strip spaces, so a pasted
              // "482 913" still works.
              `MyanFlix: ${code.slice(0, 3)} ${code.slice(3)}`,
              { otpCodeId: otp.id, expiresAt: otp.expiresAt },
            );

      const cancelled = await tx.smsMessage.updateMany({
        where: {
          phone,
          status: SmsMessageStatus.QUEUED,
          otpCodeId: { not: otp.id },
          otpCode: { is: { phone, purpose } },
        },
        data: { status: SmsMessageStatus.CANCELLED },
      });
      if (cancelled.count > 0) {
        this.logger.log(
          `Cancelled ${cancelled.count} queued SMS for ${maskPhoneNumber(phone)}: replaced by a newer ${purpose} code`,
        );
      }
      return wakeGateway;
    });
    afterCommit();
  }

  /**
   * OTP_DEV_CODE: no SMS for this code. One masked line (never the code,
   * never the full phone) and nothing to wake after the commit.
   */
  private skipSmsForDevCode(phone: string, purpose: OtpPurpose): AfterCommit {
    this.logger.log(
      `OTP_DEV_CODE: ${purpose} code for ${maskPhoneNumber(phone)} is the fixed dev code — no SMS sent or queued`,
    );
    return () => undefined;
  }

  /**
   * Throws on any invalid/expired/exhausted code; resolves (no return value)
   * on success and marks the code consumed. Only codes requested for
   * `purpose` count: a code of the other purpose is no code at all here
   * (same 401, its attempts untouched).
   *
   * Every guess first CLAIMS one of the code's MAX_VERIFY_ATTEMPTS tries in
   * one conditional statement, and only a guess that got a try is judged.
   * Parallel guesses therefore cannot judge more than 5 codes between them
   * (reading the count, comparing, then incrementing let every guess that
   * read "4" through). Sequentially nothing changes: 4 wrong codes, then
   * the right one still works; after 5 wrong codes even the right one is
   * refused. The right code spends a try too, but it is consumed anyway.
   */
  async verifyOtp(
    phone: string,
    code: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.expiresAt < new Date()) {
      throw new UnauthorizedException(OTP_INVALID_MESSAGE);
    }
    if (otp.attemptCount >= MAX_VERIFY_ATTEMPTS) {
      throw new UnauthorizedException(OTP_TOO_MANY_ATTEMPTS_MESSAGE);
    }
    const claimed = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, attemptCount: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      // Parallel guesses took the last tries first: refused unjudged.
      throw new UnauthorizedException(OTP_TOO_MANY_ATTEMPTS_MESSAGE);
    }
    if (!this.hasher.matches(phone, code, otp.codeHash)) {
      throw new UnauthorizedException(OTP_INVALID_MESSAGE);
    }

    // Consume in one conditional statement so concurrent verifies of the same
    // code can succeed at most once (the losers match 0 rows and get a 401).
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException(OTP_INVALID_MESSAGE);
    }
  }

  /**
   * M-1: nightly sweep of rows nothing reads any more — every code older
   * than OTP_ROW_RETENTION_MS, consumed or not (a code lives 5 minutes and
   * the hourly cap looks back one hour, so a day-old row is only history).
   * Same @nestjs/schedule pattern as UploadCleanupService; 5 AM so it never
   * runs alongside the upload sweeps at 3 and 4.
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async sweepOldCodes(): Promise<number> {
    const cutoff = new Date(Date.now() - OTP_ROW_RETENTION_MS);
    const { count } = await this.prisma.otpCode.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Deleted ${count} one-time code row(s) older than a day`);
    }
    return count;
  }
}
