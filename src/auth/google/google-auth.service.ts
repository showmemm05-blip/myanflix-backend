import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';
import type { AuthTokens } from '../auth.service';
import type { AuthenticatedUser } from '../types/authenticated-user.type';
import { PASSWORD_SALT_ROUNDS } from '../password.constants';
import { EXACTLY_ONE_MESSAGE } from './dto/google-login.dto';
import { GoogleTokenVerifier } from './google-token.verifier';
import type { GoogleIdentity } from './google-token.verifier';
import { deriveUsernameBase } from './google-username.util';

/**
 * Exactly one of the two, as GoogleLoginDto already guarantees for HTTP
 * callers: `credential` is a Google ID token (verified directly), `code` is a
 * popup auth-code-flow authorization code (exchanged server-side first).
 */
export interface GoogleLoginInput {
  credential?: string;
  code?: string;
}

const NOT_CONFIGURED = 'Google sign-in is not configured';

/** Same ceiling as UpdateProfileDto's displayName, so the two stay consistent. */
const DISPLAY_NAME_MAX_LENGTH = 40;
/** `base`, then `base_2` … `base_20`, then a random hex suffix. */
const MAX_USERNAME_SUFFIX = 20;
/**
 * A P2002 (unique violation) on create/link means a concurrent request won
 * the race — the next pass finds its row (same Google account double-clicked)
 * or picks the next free username (two new users with the same base).
 */
const MAX_RESOLVE_ATTEMPTS = 3;

export function normalizeDisplayName(name: string | null): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed ? trimmed.slice(0, DISPLAY_NAME_MAX_LENGTH) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * "Continue with Google" for the website. Turns the request into a verified
 * Google identity (ID token directly, or auth code → ID token), resolves (or
 * creates) the account, then hands off to AuthService.completeSignIn so the
 * session ends exactly the way a phone OTP sign-in does. Kept out of
 * AuthService on purpose: its constructor and the frozen phone path stay
 * untouched.
 */
@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly verifier: GoogleTokenVerifier,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  async loginWithGoogle(
    input: GoogleLoginInput,
  ): Promise<{ user: AuthenticatedUser } & AuthTokens> {
    // Checked before the credential/code is even looked at.
    if (!this.verifier.isEnabled) {
      throw new ServiceUnavailableException(NOT_CONFIGURED);
    }

    const identity = await this.resolveIdentity(input);
    if (!identity.email || !identity.emailVerified) {
      throw new UnauthorizedException('Google account email is not verified');
    }

    const email = identity.email.trim().toLowerCase();
    const user = await this.resolveUser(
      identity.googleId,
      email,
      identity.name,
    );
    return this.authService.completeSignIn(user);
  }

  private resolveIdentity(input: GoogleLoginInput): Promise<GoogleIdentity> {
    const hasCredential = typeof input.credential === 'string';
    const hasCode = typeof input.code === 'string';
    if (hasCredential === hasCode) {
      // The DTO rejects this at the edge; kept so the service is safe on its own.
      throw new BadRequestException(EXACTLY_ONE_MESSAGE);
    }
    if (hasCode) {
      // The code path also needs GOOGLE_CLIENT_SECRET — same "off" answer as
      // a missing client id, so the website needs no second failure mode.
      if (!this.verifier.isCodeExchangeEnabled) {
        throw new ServiceUnavailableException(NOT_CONFIGURED);
      }
      return this.verifier.exchangeCode(input.code as string);
    }
    return this.verifier.verify(input.credential as string);
  }

  /**
   * (1) by googleId → (2) by email (link when the row has no googleId yet)
   * → (3) create. Existing phone/username accounts have NULL in both
   * columns, so neither lookup can ever match them — nothing silently
   * merges.
   */
  private async resolveUser(
    googleId: string,
    email: string,
    name: string | null,
  ): Promise<User> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.resolveUserOnce(googleId, email, name);
      } catch (error) {
        if (attempt >= MAX_RESOLVE_ATTEMPTS || !isUniqueViolation(error)) {
          throw error;
        }
      }
    }
  }

  private async resolveUserOnce(
    googleId: string,
    email: string,
    name: string | null,
  ): Promise<User> {
    const byGoogleId = await this.usersService.findByGoogleId(googleId);
    if (byGoogleId) return byGoogleId;

    const byEmail = await this.usersService.findByEmail(email);
    if (byEmail) {
      if (byEmail.googleId !== null) {
        // Google `sub` is stable per account, so this only happens if the
        // e-mail was re-issued to a different person — refuse to re-point.
        throw new ConflictException(
          'This email is already linked to a different Google account',
        );
      }
      // Same wording and same gate as the phone path, and BEFORE any write.
      if (byEmail.status !== 'ACTIVE') {
        throw new UnauthorizedException('This account is no longer active');
      }
      // Safe same-email link: the e-mail on the row was itself only ever
      // written from a verified Google token.
      return this.usersService.linkGoogleId(byEmail.id, googleId);
    }

    // A Google account has no password of its own; the column is NOT NULL,
    // so store the hash of 32 random bytes nobody knows. Never returned or
    // logged. Google's `picture` is deliberately not stored — `avatar` is a
    // MinIO object key, not a URL.
    return this.usersService.create({
      username: await this.pickUsername(email),
      password: await bcrypt.hash(
        randomBytes(32).toString('hex'),
        PASSWORD_SALT_ROUNDS,
      ),
      email,
      googleId,
      displayName: normalizeDisplayName(name) ?? undefined,
    });
  }

  private async pickUsername(email: string): Promise<string> {
    const base = deriveUsernameBase(email);
    const candidates = [base];
    for (let i = 2; i <= MAX_USERNAME_SUFFIX; i++) {
      candidates.push(`${base}_${i}`);
    }
    for (const candidate of candidates) {
      if (!(await this.usersService.findByUsername(candidate))) {
        return candidate;
      }
    }
    return `${base}_${randomBytes(3).toString('hex')}`;
  }
}
