import { Logger, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { TokenPayload } from 'google-auth-library';

/** The only facts about a Google account the rest of the app ever sees. */
export interface GoogleIdentity {
  /** The ID token's `sub` claim — stable per Google account, never reused. */
  googleId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * The redirect_uri Google expects for codes minted by the JavaScript popup
 * flow (`ux_mode: "popup"`) — a fixed literal, not a URL of ours.
 */
const POPUP_REDIRECT_URI = 'postmessage';

const NOT_VERIFIED = 'Google sign-in could not be verified';

/**
 * Thin wrapper over google-auth-library so the rest of the auth code (and
 * its specs) never touch the library directly.
 *
 * - `verify(credential)`: verifyIdToken checks the RS256 signature against
 *   Google's published certs, `exp`/`iat`, the issuer, and that `aud` equals
 *   our GOOGLE_CLIENT_ID — nothing else is trusted.
 * - `exchangeCode(code)`: swaps a popup-flow authorization code for tokens
 *   using GOOGLE_CLIENT_SECRET, then feeds the returned ID token through the
 *   SAME `verify` — so both paths end in the identical audience/signature/
 *   expiry check.
 *
 * Credentials, codes, tokens and decoded payloads are never logged.
 */
@Injectable()
export class GoogleTokenVerifier {
  private readonly logger = new Logger(GoogleTokenVerifier.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly client: OAuth2Client;
  /** Only built when both id and secret are set — null means "code path off". */
  private readonly codeClient: OAuth2Client | null;

  constructor(configService: ConfigService) {
    this.clientId = (
      configService.get<string>('GOOGLE_CLIENT_ID') ?? ''
    ).trim();
    this.clientSecret = (
      configService.get<string>('GOOGLE_CLIENT_SECRET') ?? ''
    ).trim();
    this.client = new OAuth2Client();
    this.codeClient = this.isCodeExchangeEnabled
      ? new OAuth2Client({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          redirectUri: POPUP_REDIRECT_URI,
        })
      : null;
  }

  /** False when GOOGLE_CLIENT_ID is unset/blank — the feature is then off. */
  get isEnabled(): boolean {
    return this.clientId !== '';
  }

  /**
   * The auth-code path additionally needs GOOGLE_CLIENT_SECRET. False until
   * the owner provides it; `verify` (the ID-token path) is unaffected.
   */
  get isCodeExchangeEnabled(): boolean {
    return this.isEnabled && this.clientSecret !== '';
  }

  async verify(credential: string): Promise<GoogleIdentity> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken: credential,
        audience: this.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      // Bad signature, expired, wrong audience/issuer, malformed — all the
      // same to the caller, and none of the detail belongs in a response.
      // Server-side we keep ONLY the error class: enough to tell a cert-fetch
      // outage (network errors) from user-supplied garbage, without ever
      // logging the credential the library embeds in its messages.
      this.logger.warn(`Google ID token rejected (${describeError(error)})`);
      throw new UnauthorizedException(NOT_VERIFIED);
    }

    if (!payload?.sub) {
      throw new UnauthorizedException(NOT_VERIFIED);
    }

    return {
      googleId: payload.sub,
      email: payload.email ?? null,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    };
  }

  /**
   * Popup auth-code flow: exchange the one-time `code` for tokens, then verify
   * the ID token exactly as `verify` does. The service checks
   * `isCodeExchangeEnabled` first (503); this guard only covers a direct call.
   */
  async exchangeCode(code: string): Promise<GoogleIdentity> {
    if (!this.codeClient) {
      throw new UnauthorizedException(NOT_VERIFIED);
    }

    let idToken: string | null | undefined;
    try {
      const { tokens } = await this.codeClient.getToken(code);
      idToken = tokens.id_token;
    } catch (error) {
      // Used/expired/forged code, wrong secret, Google unreachable — the
      // library's error message can carry the code, so log the class only.
      this.logger.warn(
        `Google auth code exchange rejected (${describeError(error)})`,
      );
      throw new UnauthorizedException(NOT_VERIFIED);
    }

    if (!idToken) {
      this.logger.warn('Google auth code exchange returned no id_token');
      throw new UnauthorizedException(NOT_VERIFIED);
    }

    return this.verify(idToken);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
