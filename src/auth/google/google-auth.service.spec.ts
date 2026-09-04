jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn() }));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma, Role, UserStatus } from '../../generated/prisma/client';
import type { User } from '../../generated/prisma/client';
import { GoogleAuthService } from './google-auth.service';

const SUB = 'google-sub-123';

function makeP2002() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`googleId`)',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['googleId'] },
    },
  );
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    username: 'john.doe',
    password: '$2b$10$placeholder',
    phone: null,
    email: 'john.doe@gmail.com',
    googleId: SUB,
    displayName: 'John Doe',
    avatar: null,
    role: Role.USER,
    appRoleId: null,
    status: UserStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    lastSeenAt: null,
    lastIpAddress: null,
    lastPlatform: null,
    ...overrides,
  } as User;
}

function makeIdentity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    googleId: SUB,
    email: 'John.Doe@Gmail.com',
    emailVerified: true,
    name: 'John Doe',
    ...overrides,
  };
}

describe('GoogleAuthService', () => {
  let service: GoogleAuthService;
  let verifier: {
    isEnabled: boolean;
    isCodeExchangeEnabled: boolean;
    verify: jest.Mock;
    exchangeCode: jest.Mock;
  };
  let usersService: {
    findByGoogleId: jest.Mock;
    findByEmail: jest.Mock;
    findByUsername: jest.Mock;
    linkGoogleId: jest.Mock;
    create: jest.Mock;
  };
  let authService: { completeSignIn: jest.Mock };
  const signedIn = {
    user: { id: 'user-1' },
    accessToken: 'a',
    refreshToken: 'r',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    verifier = {
      isEnabled: true,
      isCodeExchangeEnabled: true,
      verify: jest.fn().mockResolvedValue(makeIdentity()),
      exchangeCode: jest.fn().mockResolvedValue(makeIdentity()),
    };
    usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByUsername: jest.fn().mockResolvedValue(null),
      linkGoogleId: jest.fn(),
      create: jest.fn(),
    };
    authService = { completeSignIn: jest.fn().mockResolvedValue(signedIn) };
    service = new GoogleAuthService(
      verifier as any,
      usersService as any,
      authService as any,
    );
  });

  it('answers 503 when the feature is disabled, before touching the credential', async () => {
    verifier.isEnabled = false;

    await expect(service.loginWithGoogle({ credential: 'x' })).rejects.toThrow(
      new ServiceUnavailableException('Google sign-in is not configured'),
    );
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(usersService.findByGoogleId).not.toHaveBeenCalled();
    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
    expect(authService.completeSignIn).not.toHaveBeenCalled();
  });

  describe('auth-code path', () => {
    it('answers 503 when GOOGLE_CLIENT_SECRET is unset, before exchanging anything', async () => {
      verifier.isCodeExchangeEnabled = false;

      await expect(service.loginWithGoogle({ code: 'c' })).rejects.toThrow(
        new ServiceUnavailableException('Google sign-in is not configured'),
      );
      expect(verifier.exchangeCode).not.toHaveBeenCalled();
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(usersService.findByGoogleId).not.toHaveBeenCalled();
      expect(authService.completeSignIn).not.toHaveBeenCalled();
    });

    it('exchanges the code (never calling verify directly) and signs in', async () => {
      usersService.findByGoogleId.mockResolvedValue(makeUser());

      await expect(service.loginWithGoogle({ code: 'c' })).resolves.toBe(
        signedIn,
      );
      expect(verifier.exchangeCode).toHaveBeenCalledTimes(1);
      expect(verifier.exchangeCode).toHaveBeenCalledWith('c');
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(authService.completeSignIn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
      );
    });

    it('propagates a 401 from the exchange without touching UsersService', async () => {
      verifier.exchangeCode.mockRejectedValue(
        new UnauthorizedException('Google sign-in could not be verified'),
      );

      await expect(service.loginWithGoogle({ code: 'used' })).rejects.toThrow(
        new UnauthorizedException('Google sign-in could not be verified'),
      );
      expect(usersService.findByGoogleId).not.toHaveBeenCalled();
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('the credential path does not need the secret', async () => {
      verifier.isCodeExchangeEnabled = false;
      usersService.findByGoogleId.mockResolvedValue(makeUser());

      await expect(service.loginWithGoogle({ credential: 'x' })).resolves.toBe(
        signedIn,
      );
      expect(verifier.verify).toHaveBeenCalledWith('x');
      expect(verifier.exchangeCode).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['neither', {}],
    ['both', { credential: 'x', code: 'c' }],
  ])(
    'rejects %s credential and code with 400 before verifying anything',
    async (_label, input) => {
      await expect(service.loginWithGoogle(input)).rejects.toThrow(
        new BadRequestException('Send exactly one of credential or code'),
      );
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(verifier.exchangeCode).not.toHaveBeenCalled();
    },
  );

  it('propagates a bad token without touching UsersService', async () => {
    verifier.verify.mockRejectedValue(
      new UnauthorizedException('Google sign-in could not be verified'),
    );

    await expect(
      service.loginWithGoogle({ credential: 'bad' }),
    ).rejects.toThrow(
      new UnauthorizedException('Google sign-in could not be verified'),
    );
    expect(usersService.findByGoogleId).not.toHaveBeenCalled();
    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['email_verified false', { emailVerified: false }],
    ['email missing', { email: null }],
  ])(
    'rejects an unverified email (%s) with no create/link',
    async (_label, overrides) => {
      verifier.verify.mockResolvedValue(makeIdentity(overrides));

      await expect(
        service.loginWithGoogle({ credential: 'x' }),
      ).rejects.toThrow(
        new UnauthorizedException('Google account email is not verified'),
      );
      expect(usersService.create).not.toHaveBeenCalled();
      expect(usersService.linkGoogleId).not.toHaveBeenCalled();
      expect(authService.completeSignIn).not.toHaveBeenCalled();
    },
  );

  it('signs in the row matched by googleId without creating or linking', async () => {
    const existing = makeUser();
    usersService.findByGoogleId.mockResolvedValue(existing);

    await expect(service.loginWithGoogle({ credential: 'x' })).resolves.toBe(
      signedIn,
    );

    expect(usersService.findByGoogleId).toHaveBeenCalledWith(SUB);
    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
    expect(usersService.linkGoogleId).not.toHaveBeenCalled();
    expect(authService.completeSignIn).toHaveBeenCalledWith(existing);
  });

  it('links a same-email row that has no googleId yet, then signs it in', async () => {
    const row = makeUser({ id: 'user-7', googleId: null });
    const linked = makeUser({ id: 'user-7', googleId: SUB });
    usersService.findByEmail.mockResolvedValue(row);
    usersService.linkGoogleId.mockResolvedValue(linked);

    await expect(service.loginWithGoogle({ credential: 'x' })).resolves.toBe(
      signedIn,
    );

    expect(usersService.findByEmail).toHaveBeenCalledWith('john.doe@gmail.com');
    expect(usersService.linkGoogleId).toHaveBeenCalledWith('user-7', SUB);
    expect(usersService.create).not.toHaveBeenCalled();
    expect(authService.completeSignIn).toHaveBeenCalledWith(linked);
  });

  it('refuses with 409 when the email row carries a different googleId', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({ googleId: 'someone-else' }),
    );

    await expect(service.loginWithGoogle({ credential: 'x' })).rejects.toThrow(
      new ConflictException(
        'This email is already linked to a different Google account',
      ),
    );
    expect(usersService.linkGoogleId).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
    expect(authService.completeSignIn).not.toHaveBeenCalled();
  });

  it('rejects a SUSPENDED email row before linking anything', async () => {
    usersService.findByEmail.mockResolvedValue(
      makeUser({ googleId: null, status: UserStatus.SUSPENDED }),
    );

    await expect(service.loginWithGoogle({ credential: 'x' })).rejects.toThrow(
      new UnauthorizedException('This account is no longer active'),
    );
    expect(usersService.linkGoogleId).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('creates a new user from the verified token (username from the email, random bcrypt password)', async () => {
    const created = makeUser({ id: 'user-new' });
    usersService.create.mockResolvedValue(created);

    await expect(service.loginWithGoogle({ credential: 'x' })).resolves.toBe(
      signedIn,
    );

    expect(usersService.create).toHaveBeenCalledTimes(1);
    const input = usersService.create.mock.calls[0][0];
    expect(input).toEqual({
      username: 'john.doe',
      password: expect.any(String),
      email: 'john.doe@gmail.com',
      googleId: SUB,
      displayName: 'John Doe',
    });
    expect(input.password.startsWith('$2')).toBe(true);
    await expect(bcrypt.compare('', input.password)).resolves.toBe(false);
    expect(usersService.linkGoogleId).not.toHaveBeenCalled();
    expect(authService.completeSignIn).toHaveBeenCalledWith(created);
  });

  it('picks the next free username when the base and _2 are taken', async () => {
    usersService.findByUsername.mockImplementation((username: string) =>
      Promise.resolve(
        username === 'john.doe' || username === 'john.doe_2'
          ? makeUser({ username })
          : null,
      ),
    );
    usersService.create.mockResolvedValue(makeUser({ username: 'john.doe_3' }));

    await service.loginWithGoogle({ credential: 'x' });

    expect(usersService.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'john.doe_3' }),
    );
  });

  it('P2002 race: retries once and signs in the concurrent winner; create called exactly once', async () => {
    const winner = makeUser({ id: 'winner' });
    usersService.findByGoogleId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    usersService.create.mockRejectedValueOnce(makeP2002());

    await expect(service.loginWithGoogle({ credential: 'x' })).resolves.toBe(
      signedIn,
    );

    expect(usersService.create).toHaveBeenCalledTimes(1);
    expect(authService.completeSignIn).toHaveBeenCalledWith(winner);
  });

  it('rethrows a non-P2002 create failure untouched', async () => {
    usersService.create.mockRejectedValue(new Error('db down'));

    await expect(service.loginWithGoogle({ credential: 'x' })).rejects.toThrow(
      'db down',
    );
    expect(usersService.create).toHaveBeenCalledTimes(1);
    expect(authService.completeSignIn).not.toHaveBeenCalled();
  });

  it('leaves displayName unset when the token has no name', async () => {
    verifier.verify.mockResolvedValue(makeIdentity({ name: null }));
    usersService.create.mockResolvedValue(makeUser());

    await service.loginWithGoogle({ credential: 'x' });

    expect(usersService.create.mock.calls[0][0].displayName).toBeUndefined();
  });

  it('truncates a 60-character name to 40', async () => {
    verifier.verify.mockResolvedValue(makeIdentity({ name: 'n'.repeat(60) }));
    usersService.create.mockResolvedValue(makeUser());

    await service.loginWithGoogle({ credential: 'x' });

    expect(usersService.create.mock.calls[0][0].displayName).toBe(
      'n'.repeat(40),
    );
  });
});
