import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { StringValue } from 'ms';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';
import type { AuthenticatedUser } from './types/authenticated-user.type';
import type { JwtPayload, RefreshPayload } from './types/jwt-payload.type';

const PASSWORD_SALT_ROUNDS = 10;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly otpService: OtpService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    const existing = await this.usersService.findByEmailOrUsername(
      dto.email,
      dto.username,
    );
    if (existing) {
      throw new ConflictException('Email or username is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const user = await this.usersService.create({
      username: dto.username,
      email: dto.email,
      password: passwordHash,
    });

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    const tokens = await this.issueTokens(authenticatedUser);
    return { user: authenticatedUser, ...tokens };
  }

  async login(
    dto: LoginDto,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    const user = await this.usersService.findByUsername(dto.username);
    if (!user) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid username or password');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is no longer active');
    }

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    const [tokens] = await Promise.all([
      this.issueTokens(authenticatedUser),
      this.usersService.updateLastLogin(user.id),
    ]);
    return { user: authenticatedUser, ...tokens };
  }

  /** Step 1: does an account already exist for this phone? Drives the frontend's "enter your password" vs "create a password" branch. Expects an already-normalized phone. */
  async checkPhoneExists(phone: string): Promise<{ exists: boolean }> {
    const user = await this.usersService.findByPhone(phone);
    return { exists: Boolean(user) };
  }

  /**
   * Step 2 for a returning phone: checks the password before an OTP is even
   * sent. Deliberately the same generic message on both "no such phone" and
   * "wrong password" — same reasoning as the email/password login() below.
   */
  async verifyPhonePassword(
    phone: string,
    password: string,
  ): Promise<{ valid: true }> {
    const user = await this.usersService.findByPhone(phone);
    if (!user) throw new UnauthorizedException('Invalid phone or password');

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches)
      throw new UnauthorizedException('Invalid phone or password');

    if (user.status !== 'ACTIVE')
      throw new UnauthorizedException('This account is no longer active');

    return { valid: true };
  }

  /** Expects an already-normalized phone (RequestOtpDto normalizes it). */
  requestPhoneOtp(phone: string): Promise<void> {
    return this.otpService.requestOtp(phone);
  }

  /**
   * Step 3: verifies the code, then logs into the existing account (its
   * password was already checked in step 2, not re-checked here) or creates
   * a new one using the password chosen in step 2 — required in that case,
   * since a brand-new account has nothing else to set it from.
   */
  async verifyPhoneOtp(
    phone: string,
    code: string,
    password?: string,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    await this.otpService.verifyOtp(phone, code);

    let user = await this.usersService.findByPhone(phone);
    if (!user) {
      if (!password) {
        throw new BadRequestException(
          'A password is required to create a new account',
        );
      }
      // Username/email have no independent meaning for a phone account —
      // synthesize unique placeholders (the digits make them unique per
      // phone) so the existing required columns stay satisfied.
      const digits = phone.replace(/\D/g, '');
      user = await this.usersService.create({
        username: `user_${digits}`,
        email: `${digits}@phone.myanflix.local`,
        password: await bcrypt.hash(password, PASSWORD_SALT_ROUNDS),
        phone,
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is no longer active');
    }

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    const tokens = await this.issueTokens(authenticatedUser);
    return { user: authenticatedUser, ...tokens };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(
        refreshToken,
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        },
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });
    if (
      !stored ||
      stored.revoked ||
      stored.expiresAt < new Date() ||
      stored.tokenHash !== hashToken(refreshToken)
    ) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Rotate: the old refresh token is single-use.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    });

    const user = await this.usersService.findByIdOrThrow(stored.userId);
    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
    return this.issueTokens(authenticatedUser);
  }

  async logout(refreshToken: string): Promise<void> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(
        refreshToken,
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
          ignoreExpiration: true,
        },
      );
    } catch {
      return;
    }

    await this.prisma.refreshToken.updateMany({
      where: { id: payload.jti, userId: payload.sub },
      data: { revoked: true },
    });
  }

  private async issueTokens(user: AuthenticatedUser): Promise<AuthTokens> {
    const accessPayload: JwtPayload = { sub: user.id, email: user.email };
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_ACCESS_EXPIRES_IN',
      ) as StringValue,
    });

    const jti = randomUUID();
    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
    )! as StringValue;
    const refreshPayload: RefreshPayload = { sub: user.id, jti };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    });

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + parseDurationMs(refreshExpiresIn)),
      },
    });

    return { accessToken, refreshToken };
  }
}

/** Parses simple JWT-style durations like "15m", "7d", "1h" into milliseconds. */
function parseDurationMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return value * unitMs[unit];
}
