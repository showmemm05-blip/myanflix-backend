import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, type IAuthGuard } from '@nestjs/passport';
import { OptionalAuth } from '../../common/decorators/optional-auth.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Carries the real decorators so the guard reads the same metadata the
 * controllers produce — no hand-set Reflect keys that could drift.
 */
class RoutesStub {
  @Public()
  publicRoute() {}

  @OptionalAuth()
  optionalRoute() {}

  protectedRoute() {}
}

type Handler = keyof RoutesStub;

function contextFor(
  handler: Handler,
  headers: Record<string, string> = {},
): ExecutionContext {
  const request = { headers, user: undefined };
  return {
    getHandler: () => RoutesStub.prototype[handler],
    getClass: () => RoutesStub,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let passportCanActivate: jest.SpyInstance;

  beforeEach(() => {
    guard = new JwtAuthGuard(new Reflector());
    // AuthGuard() is memoized, so this is the exact parent prototype
    // JwtAuthGuard extends — the passport flow every non-guest path hits.
    passportCanActivate = jest
      .spyOn(AuthGuard('jwt').prototype as IAuthGuard, 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    passportCanActivate.mockRestore();
  });

  it('@Public: passes without touching passport, even with a header', () => {
    expect(
      guard.canActivate(
        contextFor('publicRoute', { authorization: 'Bearer whatever' }),
      ),
    ).toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('@OptionalAuth + no Authorization header: passes as a guest without passport', () => {
    expect(guard.canActivate(contextFor('optionalRoute'))).toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('@OptionalAuth + blank Authorization header: still a guest', () => {
    expect(
      guard.canActivate(contextFor('optionalRoute', { authorization: '   ' })),
    ).toBe(true);
    expect(passportCanActivate).not.toHaveBeenCalled();
  });

  it('@OptionalAuth + Authorization header: delegates to the passport flow', async () => {
    const context = contextFor('optionalRoute', {
      authorization: 'Bearer token',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(passportCanActivate).toHaveBeenCalledTimes(1);
    expect(passportCanActivate).toHaveBeenCalledWith(context);
  });

  it('@OptionalAuth + bad token: whatever passport decides (401) is not swallowed', async () => {
    const rejection = new Error('Unauthorized');
    passportCanActivate.mockRejectedValue(rejection);
    await expect(
      guard.canActivate(
        contextFor('optionalRoute', { authorization: 'Bearer expired' }),
      ),
    ).rejects.toBe(rejection);
  });

  it('plain route + no header: still goes through passport (which will 401)', async () => {
    const context = contextFor('protectedRoute');
    await guard.canActivate(context);
    expect(passportCanActivate).toHaveBeenCalledWith(context);
  });
});
