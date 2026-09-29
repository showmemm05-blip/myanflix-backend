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
import { OtpPurpose, Role, UserStatus } from '../generated/prisma/client';
import type { Prisma, User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { OtpService } from '../otp/otp.service';
import { TrackingService } from '../tracking/tracking.service';
import { AuditService } from '../audit/audit.service';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';
import type { OtpRequestPurpose } from './dto/request-otp.dto';
import type { AuthenticatedUser } from './types/authenticated-user.type';
import type { JwtPayload, RefreshPayload } from './types/jwt-payload.type';
import { PASSWORD_SALT_ROUNDS } from './password.constants';
import { SessionRevocationService } from './session-revocation.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * H-6: proof that step 2 (the password) of the returning-phone sign-in
 * passed. Handed out by POST /auth/phone/verify-password and required by
 * POST /auth/otp/verify for an existing account, so the code alone never
 * opens one. Lives long enough to cover the 5-minute code plus a resend.
 */
const PHONE_LOGIN_STEP_TTL = '10m';
const PHONE_LOGIN_STEP_PURPOSE = 'phone-login';
const STEP_TOKEN_REFUSED = 'Please enter your password again.';
const RESET_UNKNOWN_PHONE = 'No account was found for this phone number.';

interface PhoneLoginStepPayload {
  sub: string;
  pur: typeof PHONE_LOGIN_STEP_PURPOSE;
  /** Fingerprint of the password hash it proved — any password change voids it. */
  pv: string;
}

/**
 * A short fingerprint of the stored hash, never of the password itself. The
 * bcrypt salt it would take to test a guess against it never leaves the
 * database, so the fingerprint reveals nothing usable.
 */
function passwordVersion(user: Pick<User, 'password'>): string {
  return createHash('sha256').update(user.password).digest('hex').slice(0, 16);
}

/** The stored purpose of each POST /auth/otp/request `purpose` (B1). */
const OTP_PURPOSES: Record<OtpRequestPurpose, OtpPurpose> = {
  login: OtpPurpose.LOGIN,
  password_reset: OtpPurpose.PASSWORD_RESET,
};

/** The account row /auth/refresh share-locks: all a token pair needs (B2). */
type RefreshAccountRow = Pick<
  User,
  'id' | 'username' | 'role' | 'appRoleId' | 'status'
>;

function toAuthenticatedUser(
  user: Pick<User, 'id' | 'username' | 'role' | 'appRoleId'>,
): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    appRoleId: user.appRoleId,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly otpService: OtpService,
    private readonly trackingService: TrackingService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    const existing = await this.usersService.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException('Username is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const user = await this.usersService.create({
      username: dto.username,
      password: passwordHash,
    });

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      appRoleId: user.appRoleId,
    };
    const tokens = await this.issueTokens(authenticatedUser);
    return { user: authenticatedUser, ...tokens };
  }

  /**
   * The staff door (the admin app). H-6: a customer account (role USER)
   * signs in with phone + password + code, or Google — never with a
   * password alone, and a phone account's username is just `user_<digits>`.
   * It is refused BEFORE the password is compared and with the same message
   * as a wrong password, so this route is no password oracle for customers.
   */
  async login(
    dto: LoginDto,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    const user = await this.usersService.findByUsername(dto.username);
    if (!user || user.role === Role.USER) {
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
      username: user.username,
      role: user.role,
      appRoleId: user.appRoleId,
    };
    const [tokens] = await Promise.all([
      this.issueTokens(authenticatedUser),
      this.usersService.updateLastLogin(user.id),
    ]);
    // Opens the session row behind presence and the admin's Phone/IP view.
    // Fire-and-forget: a tracking failure must never cost someone their
    // login, and nothing in the response depends on it.
    this.trackingService.fireAndForget(
      'session start',
      this.trackingService.startSession(user.id),
    );
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
   * "wrong password" — same reasoning as the username/password login() above.
   *
   * H-6: success hands back `stepToken`, the proof step 3 must present — the
   * server, not the client, now enforces "password, then code".
   */
  async verifyPhonePassword(
    phone: string,
    password: string,
  ): Promise<{ valid: true; stepToken: string }> {
    const user = await this.usersService.findByPhone(phone);
    if (!user) throw new UnauthorizedException('Invalid phone or password');

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches)
      throw new UnauthorizedException('Invalid phone or password');

    if (user.status !== 'ACTIVE')
      throw new UnauthorizedException('This account is no longer active');

    const payload: PhoneLoginStepPayload = {
      sub: user.id,
      pur: PHONE_LOGIN_STEP_PURPOSE,
      pv: passwordVersion(user),
    };
    const stepToken = await this.jwtService.signAsync(payload, {
      secret: this.stepTokenSecret(),
      expiresIn: PHONE_LOGIN_STEP_TTL,
    });
    return { valid: true, stepToken };
  }

  /**
   * Expects an already-normalized phone (RequestOtpDto normalizes it). B1:
   * the code is bound to `purpose` (sign-in by default). A reset code is
   * refused BEFORE one is created when the phone has no customer account —
   * staff included — or that account is not ACTIVE, exactly as (and with
   * the same answers as) POST /auth/password/reset refuses them, so no code,
   * cooldown or hourly allowance is spent on a reset that can never happen.
   */
  async requestPhoneOtp(
    phone: string,
    purpose: OtpRequestPurpose = 'login',
  ): Promise<void> {
    if (purpose === 'password_reset') {
      const user = await this.usersService.findByPhone(phone);
      if (!user || user.role !== Role.USER) {
        throw new BadRequestException(RESET_UNKNOWN_PHONE);
      }
      if (user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('This account is no longer active');
      }
    }
    await this.otpService.requestOtp(phone, OTP_PURPOSES[purpose]);
  }

  /**
   * Step 3: verifies the code, then logs into the existing account or
   * creates a new one using the password chosen in step 2 — required in
   * that case, since a brand-new account has nothing else to set it from.
   *
   * H-6: an existing account also needs the `stepToken` step 2 handed out,
   * checked BEFORE the code, so the code alone never opens it (and a caller
   * without the password cannot even spend the owner's code attempts). The
   * password is not re-checked here and is ignored for an existing account.
   */
  async verifyPhoneOtp(
    phone: string,
    code: string,
    password?: string,
    stepToken?: string,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    let user = await this.usersService.findByPhone(phone);
    if (user) await this.assertPhoneLoginStep(user, stepToken);

    // B1: only a code requested for sign-in; a reset code never opens (or
    // creates) an account.
    await this.otpService.verifyOtp(phone, code, OtpPurpose.LOGIN);

    if (!user) {
      if (!password) {
        throw new BadRequestException(
          'A password is required to create a new account',
        );
      }
      // A username has no independent meaning for a phone account —
      // synthesize a unique placeholder (the digits make it unique per
      // phone) so the required unique column stays satisfied.
      const digits = phone.replace(/\D/g, '');
      user = await this.usersService.create({
        username: `user_${digits}`,
        password: await bcrypt.hash(password, PASSWORD_SALT_ROUNDS),
        phone,
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is no longer active');
    }

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      appRoleId: user.appRoleId,
    };
    const tokens = await this.issueTokens(authenticatedUser);
    // Same session bookkeeping as password login — this is the sign-in path
    // both the website and the mobile app actually use.
    this.trackingService.fireAndForget(
      'session start',
      this.trackingService.startSession(user.id),
    );
    return { user: authenticatedUser, ...tokens };
  }

  /**
   * The tail every sign-in shares: the ACTIVE gate, the token pair, the
   * session row. Public so Google sign-in (GoogleAuthService) ends exactly
   * the way a phone OTP sign-in does. verifyPhoneOtp above deliberately
   * keeps its own inline copy — that path is frozen by design.
   */
  async completeSignIn(
    user: User,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is no longer active');
    }
    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      appRoleId: user.appRoleId,
    };
    const tokens = await this.issueTokens(authenticatedUser);
    this.trackingService.fireAndForget(
      'session start',
      this.trackingService.startSession(user.id),
    );
    return { user: authenticatedUser, ...tokens };
  }

  /**
   * H-8 "forgot password": phone -> code (POST /auth/otp/request with
   * `purpose: 'password_reset'`) -> new password. The code is checked by the
   * same OtpService as sign-in, but only a reset code counts (B1): a code
   * requested for sign-in never resets a password. Every session of the
   * account is revoked, and no new one is opened: the user then signs in
   * normally with the new password and a fresh code.
   *
   * Customer accounts only. A staff password is reset by another staff
   * member (PATCH /staff/:id/password) — an SMS code alone must never reach
   * a staff account, and the admin signs in without any code. Unknown,
   * staff and inactive accounts are refused BEFORE the code is spent.
   */
  async resetPasswordWithOtp(
    phone: string,
    code: string,
    newPassword: string,
  ): Promise<{ reset: true }> {
    const user = await this.usersService.findByPhone(phone);
    if (!user || user.role !== Role.USER) {
      throw new BadRequestException(RESET_UNKNOWN_PHONE);
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is no longer active');
    }

    await this.otpService.verifyOtp(phone, code, OtpPurpose.PASSWORD_RESET);

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { password: passwordHash },
      });
      await this.sessions.revokeAll(user.id, { client: tx });
    });
    this.sessions.disconnectUser(user.id);

    // The owner is the actor (no staff member was involved), so the row is
    // forced past AuditService's end-user filter. A pure event: nothing
    // password-shaped, not even a hash, ever reaches the log.
    await this.audit.record({
      action: 'user.password_reset',
      actor: toAuthenticatedUser(user),
      target: { type: 'user', id: user.id, label: `@${user.username}` },
      force: true,
    });
    return { reset: true };
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

    // B2 (H-21): the whole rotation is ONE transaction that first takes the
    // account row FOR SHARE. SessionRevocationService.revokeAll takes the
    // same row FOR UPDATE before it revokes anything and stamps
    // sessionsRevokedAt only once it holds it, so the two never interleave:
    // a revoke that got there first makes this refresh wait and then find
    // its token revoked (401); a refresh that got there first commits its new
    // row — and an access token older than the stamp — before the revoke
    // runs, and the revoke then takes both. Both lock users, then
    // refresh_tokens, in that order.
    const tokens = await this.prisma.$transaction(async (tx) => {
      const [account] = await tx.$queryRaw<RefreshAccountRow[]>`
        SELECT "id", "username", "role", "appRoleId", "status"
        FROM "users" WHERE "id" = ${payload.sub} FOR SHARE`;
      if (!account) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // Rotate: the old refresh token is single-use. Verify AND consume it in
      // ONE conditional statement. Under READ COMMITTED a concurrent UPDATE
      // on the same row waits for the first to commit, re-evaluates the
      // WHERE on the new row version (revoked = true) and matches 0 rows, so
      // exactly one caller ever sees count === 1 — parallel replays of one
      // token get a 401.
      const consumed = await tx.refreshToken.updateMany({
        where: {
          id: payload.jti,
          userId: payload.sub,
          tokenHash: hashToken(refreshToken),
          revoked: false,
          expiresAt: { gt: new Date() },
        },
        data: { revoked: true },
      });
      if (consumed.count !== 1) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      // H-21: a suspended, banned or closed account mints nothing — its
      // refresh tokens were revoked when it left ACTIVE, and one that slipped
      // through must not spring back to life on reactivation either. So the
      // consume above COMMITS and the refusal is thrown after it.
      if (account.status !== UserStatus.ACTIVE) return null;
      return this.issueTokens(toAuthenticatedUser(account), tx);
    });
    if (!tokens) {
      throw new UnauthorizedException('This account is no longer active');
    }
    return tokens;
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

  /**
   * Step tokens are signed with a key derived from JWT_SECRET, never with
   * JWT_SECRET or JWT_REFRESH_SECRET themselves: JwtStrategy, the socket
   * handshake and /auth/refresh therefore can never accept one.
   */
  private stepTokenSecret(): string {
    return `${this.configService.get<string>('JWT_SECRET')}:${PHONE_LOGIN_STEP_PURPOSE}-step`;
  }

  private async assertPhoneLoginStep(
    user: User,
    stepToken: string | undefined,
  ): Promise<void> {
    if (!stepToken) throw new UnauthorizedException(STEP_TOKEN_REFUSED);
    let payload: PhoneLoginStepPayload;
    try {
      payload = await this.jwtService.verifyAsync<PhoneLoginStepPayload>(
        stepToken,
        { secret: this.stepTokenSecret() },
      );
    } catch {
      throw new UnauthorizedException(STEP_TOKEN_REFUSED);
    }
    if (
      payload.pur !== PHONE_LOGIN_STEP_PURPOSE ||
      payload.sub !== user.id ||
      payload.pv !== passwordVersion(user)
    ) {
      throw new UnauthorizedException(STEP_TOKEN_REFUSED);
    }
  }

  private async issueTokens(
    user: AuthenticatedUser,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<AuthTokens> {
    // The refresh row's id doubles as the session id (`sid`) the access
    // token carries — what a self-service password change keeps signed in.
    // `ims` is the exact mint time the "sessions revoked" cutoff compares.
    const jti = randomUUID();
    const accessPayload: JwtPayload = {
      sub: user.id,
      sid: jti,
      ims: Date.now(),
    };
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_ACCESS_EXPIRES_IN',
      ) as StringValue,
    });

    const refreshExpiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
    )! as StringValue;
    const refreshPayload: RefreshPayload = { sub: user.id, jti };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    });

    await client.refreshToken.create({
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
