import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_REQUESTS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0');
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
  ) {}

  /** Generates and stores a code for `phone`, then hands it to SmsService for delivery. Expects an already-normalized phone. */
  async requestOtp(phone: string): Promise<void> {
    const mostRecent = await this.prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (
      mostRecent &&
      Date.now() - mostRecent.createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      throw new ConflictException('Please wait before requesting another code');
    }

    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const requestsThisHour = await this.prisma.otpCode.count({
      where: { phone, createdAt: { gte: windowStart } },
    });
    if (requestsThisHour >= MAX_REQUESTS_PER_HOUR) {
      throw new ConflictException(
        'Too many code requests — please try again later',
      );
    }

    const code = generateCode();
    await this.prisma.otpCode.create({
      data: { phone, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });

    await this.smsService.send(
      phone,
      `Your MyanFlix verification code is ${code}. It expires in 5 minutes.`,
    );
  }

  /** Throws on any invalid/expired/exhausted code; resolves (no return value) on success and marks the code consumed. */
  async verifyOtp(phone: string, code: string): Promise<void> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { phone, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    if (otp.attemptCount >= MAX_VERIFY_ATTEMPTS) {
      throw new UnauthorizedException(
        'Too many incorrect attempts — request a new code',
      );
    }
    if (otp.code !== code) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attemptCount: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });
  }
}
