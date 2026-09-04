jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleTokenVerifier } from './google-token.verifier';

const CLIENT_ID = '1234.apps.googleusercontent.com';

const CLIENT_SECRET = 'GOCSPX-test-secret';

function makeVerifier(
  clientId: string | undefined,
  clientSecret: string | undefined = undefined,
) {
  const env: Record<string, string | undefined> = {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
  };
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  return new GoogleTokenVerifier(configService);
}

describe('GoogleTokenVerifier', () => {
  let verifyIdToken: jest.Mock;
  let getToken: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    verifyIdToken = jest.fn();
    getToken = jest.fn();
    (OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
      verifyIdToken,
      getToken,
    }));
  });

  describe('isEnabled', () => {
    it('is false when GOOGLE_CLIENT_ID is undefined', () => {
      expect(makeVerifier(undefined).isEnabled).toBe(false);
    });

    it('is false when GOOGLE_CLIENT_ID is blank', () => {
      expect(makeVerifier('   ').isEnabled).toBe(false);
    });

    it('is true when GOOGLE_CLIENT_ID is set', () => {
      expect(makeVerifier(CLIENT_ID).isEnabled).toBe(true);
    });
  });

  describe('isCodeExchangeEnabled', () => {
    it('is false when only GOOGLE_CLIENT_ID is set (secret unset)', () => {
      expect(makeVerifier(CLIENT_ID).isCodeExchangeEnabled).toBe(false);
    });

    it('is false when the secret is blank', () => {
      expect(makeVerifier(CLIENT_ID, '  ').isCodeExchangeEnabled).toBe(false);
    });

    it('is false when the secret is set but the client id is not', () => {
      expect(makeVerifier(undefined, CLIENT_SECRET).isCodeExchangeEnabled).toBe(
        false,
      );
    });

    it('is true when both are set', () => {
      expect(makeVerifier(CLIENT_ID, CLIENT_SECRET).isCodeExchangeEnabled).toBe(
        true,
      );
    });

    it('only builds the code-exchange client (id, secret, "postmessage") when both are set', () => {
      makeVerifier(CLIENT_ID);
      expect(OAuth2Client).toHaveBeenCalledTimes(1);
      expect(OAuth2Client).toHaveBeenCalledWith();

      jest.clearAllMocks();
      makeVerifier(CLIENT_ID, CLIENT_SECRET);
      expect(OAuth2Client).toHaveBeenCalledTimes(2);
      expect(OAuth2Client).toHaveBeenNthCalledWith(2, {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: 'postmessage',
      });
    });
  });

  describe('verify', () => {
    it('calls verifyIdToken with the credential and our client id as audience, and maps the payload', async () => {
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-1',
          email: 'John.Doe@gmail.com',
          email_verified: true,
          name: 'John Doe',
        }),
      });

      const identity = await makeVerifier(CLIENT_ID).verify('the-credential');

      expect(verifyIdToken).toHaveBeenCalledTimes(1);
      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: 'the-credential',
        audience: CLIENT_ID,
      });
      expect(identity).toEqual({
        googleId: 'google-sub-1',
        email: 'John.Doe@gmail.com',
        emailVerified: true,
        name: 'John Doe',
      });
    });

    it('treats a missing email_verified as false and a missing name as null', async () => {
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'google-sub-1', email: 'x@y.com' }),
      });

      const identity = await makeVerifier(CLIENT_ID).verify('the-credential');

      expect(identity.emailVerified).toBe(false);
      expect(identity.name).toBeNull();
    });

    it('maps a library rejection to UnauthorizedException', async () => {
      verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));

      await expect(
        makeVerifier(CLIENT_ID).verify('bad-credential'),
      ).rejects.toThrow(
        new UnauthorizedException('Google sign-in could not be verified'),
      );
    });

    it('rejects a payload without sub (undefined payload)', async () => {
      verifyIdToken.mockResolvedValue({ getPayload: () => undefined });

      await expect(makeVerifier(CLIENT_ID).verify('x')).rejects.toThrow(
        new UnauthorizedException('Google sign-in could not be verified'),
      );
    });

    it('rejects a payload without sub (empty payload)', async () => {
      verifyIdToken.mockResolvedValue({ getPayload: () => ({}) });

      await expect(makeVerifier(CLIENT_ID).verify('x')).rejects.toThrow(
        new UnauthorizedException('Google sign-in could not be verified'),
      );
    });
  });

  describe('exchangeCode', () => {
    const rejected = new UnauthorizedException(
      'Google sign-in could not be verified',
    );

    it('exchanges the code, then verifies the returned id_token with our client id as audience', async () => {
      getToken.mockResolvedValue({
        tokens: { id_token: 'the-id-token', access_token: 'never-used' },
      });
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-1',
          email: 'x@y.com',
          email_verified: true,
          name: 'X',
        }),
      });

      const identity = await makeVerifier(
        CLIENT_ID,
        CLIENT_SECRET,
      ).exchangeCode('the-code');

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith('the-code');
      expect(verifyIdToken).toHaveBeenCalledTimes(1);
      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: 'the-id-token',
        audience: CLIENT_ID,
      });
      expect(identity).toEqual({
        googleId: 'google-sub-1',
        email: 'x@y.com',
        emailVerified: true,
        name: 'X',
      });
    });

    it('maps a getToken rejection to 401 without calling verifyIdToken', async () => {
      getToken.mockRejectedValue(new Error('invalid_grant: code=the-code'));

      await expect(
        makeVerifier(CLIENT_ID, CLIENT_SECRET).exchangeCode('the-code'),
      ).rejects.toThrow(rejected);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('answers 401 when the exchange returns no id_token', async () => {
      getToken.mockResolvedValue({ tokens: { access_token: 'only' } });

      await expect(
        makeVerifier(CLIENT_ID, CLIENT_SECRET).exchangeCode('the-code'),
      ).rejects.toThrow(rejected);
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('propagates the 401 from verify when the exchanged id_token is bad', async () => {
      getToken.mockResolvedValue({ tokens: { id_token: 'forged' } });
      verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));

      await expect(
        makeVerifier(CLIENT_ID, CLIENT_SECRET).exchangeCode('the-code'),
      ).rejects.toThrow(rejected);
    });

    it('refuses (401) without contacting Google when the secret is unset', async () => {
      await expect(makeVerifier(CLIENT_ID).exchangeCode('x')).rejects.toThrow(
        rejected,
      );
      expect(getToken).not.toHaveBeenCalled();
      expect(verifyIdToken).not.toHaveBeenCalled();
    });

    it('never logs the code or the tokens, only the error class', async () => {
      const { Logger } =
        jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      getToken.mockRejectedValue(new TypeError('bad code the-secret-code'));

      await expect(
        makeVerifier(CLIENT_ID, CLIENT_SECRET).exchangeCode('the-secret-code'),
      ).rejects.toThrow(rejected);

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('TypeError');
      expect(message).not.toContain('the-secret-code');
      warn.mockRestore();
    });
  });
});
