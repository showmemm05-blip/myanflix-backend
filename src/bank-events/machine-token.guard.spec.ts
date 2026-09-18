import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MachineTokenGuard } from './machine-token.guard';
import { MACHINE_PERMISSION_KEY } from './machine-permissions';

const TOKEN = 'x'.repeat(48);

function contextFor(
  headers: Record<string, string>,
  required: string | undefined = 'BANK_EVENTS.INGEST',
) {
  const request: {
    headers: Record<string, string>;
    machine?: unknown;
    user?: unknown;
  } = {
    headers,
  };
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === MACHINE_PERMISSION_KEY ? required : undefined,
    ),
  } as unknown as Reflector;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { request, reflector, context };
}

describe('MachineTokenGuard', () => {
  const configWith = (token: string | undefined) =>
    ({ get: jest.fn().mockReturnValue(token) }) as never;

  it('answers 503 when BANK_EVENTS_TOKEN is unset — ingestion is simply off', () => {
    const { context, reflector } = contextFor({
      authorization: `Bearer ${TOKEN}`,
    });
    const guard = new MachineTokenGuard(configWith(undefined), reflector);
    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects a missing, malformed or wrong bearer with 401', () => {
    const reflector = contextFor({}).reflector;
    const guard = new MachineTokenGuard(configWith(TOKEN), reflector);
    for (const headers of [
      {},
      { authorization: TOKEN },
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}y` },
      { authorization: `Bearer ${TOKEN}extra` },
    ]) {
      expect(() => guard.canActivate(contextFor(headers).context)).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('attaches the machine principal and leaves request.user undefined on success', () => {
    const { context, reflector, request } = contextFor({
      authorization: `Bearer ${TOKEN}`,
    });
    const guard = new MachineTokenGuard(configWith(TOKEN), reflector);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.machine).toEqual({
      kind: 'phone-monitor',
      permissions: ['BANK_EVENTS.INGEST'],
    });
    expect(request.user).toBeUndefined();
  });

  it('refuses a route that requires a permission the machine set does not carry', () => {
    const { context, reflector } = contextFor(
      { authorization: `Bearer ${TOKEN}` },
      'DEPOSITS.APPROVE',
    );
    const guard = new MachineTokenGuard(configWith(TOKEN), reflector);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
