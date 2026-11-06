import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { BankEventsDeviceBindingService } from './bank-events-device-binding.service';
import { MachineTokenGuard, deviceSerialOf } from './machine-token.guard';
import { MACHINE_PERMISSION_KEY } from './machine-permissions';

const TOKEN = 'x'.repeat(48);
/** The owner's phone-monitor serial (a uuid the monitor generated once). */
const SERIAL = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';

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

/** The right token and the pinned serial — the owner's monitor as it posts. */
const monitorHeaders = (serial: string = SERIAL) => ({
  authorization: `Bearer ${TOKEN}`,
  'x-device-serial': serial,
});

describe('MachineTokenGuard', () => {
  const configWith = (token: string | undefined) =>
    ({ get: jest.fn().mockReturnValue(token) }) as never;
  let binding: { admit: jest.Mock };
  const guardWith = (token: string | undefined, reflector: Reflector) =>
    new MachineTokenGuard(
      configWith(token),
      reflector,
      binding as unknown as BankEventsDeviceBindingService,
    );

  beforeEach(() => {
    binding = { admit: jest.fn().mockResolvedValue(true) };
  });

  it('answers 503 when BANK_EVENTS_TOKEN is unset — ingestion is simply off', async () => {
    const { context, reflector } = contextFor(monitorHeaders());
    const guard = guardWith(undefined, reflector);
    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('rejects a missing, malformed or wrong bearer with 401 — before the pin is ever consulted', async () => {
    const reflector = contextFor({}).reflector;
    const guard = guardWith(TOKEN, reflector);
    for (const headers of [
      {},
      { authorization: TOKEN },
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}y` },
      { authorization: `Bearer ${TOKEN}extra` },
    ]) {
      await expect(
        guard.canActivate(
          contextFor({ ...headers, 'x-device-serial': SERIAL }).context,
        ),
      ).rejects.toThrow(UnauthorizedException);
    }
    // A wrong token never pins anything and is never a "rejected device".
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('SEC-004: a right token with no (or a malformed) X-Device-Serial is 401 DEVICE_SERIAL_REQUIRED', async () => {
    const reflector = contextFor({}).reflector;
    const guard = guardWith(TOKEN, reflector);
    for (const serial of [
      undefined,
      '',
      '   ',
      'short',
      'x'.repeat(65),
      'bad serial',
      'a;b',
    ]) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${TOKEN}`,
      };
      if (serial !== undefined) headers['x-device-serial'] = serial;
      await expect(
        guard.canActivate(contextFor(headers).context),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: 'DEVICE_SERIAL_REQUIRED',
      });
    }
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('SEC-004: a serial the pin refuses is 401 DEVICE_SERIAL_REJECTED and nothing is attached', async () => {
    binding.admit.mockResolvedValue(false);
    const { context, reflector, request } = contextFor(
      monitorHeaders('OTHER-MONITOR-01'),
    );
    const guard = guardWith(TOKEN, reflector);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      constructor: UnauthorizedException,
      message: 'DEVICE_SERIAL_REJECTED',
    });
    expect(binding.admit).toHaveBeenCalledWith('OTHER-MONITOR-01');
    expect(request.machine).toBeUndefined();
  });

  it('attaches the machine principal (with its serial) and leaves request.user undefined on success', async () => {
    const { context, reflector, request } = contextFor(
      monitorHeaders(`  ${SERIAL} `),
    );
    const guard = guardWith(TOKEN, reflector);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Trimmed, so a stray space in the monitor's config never makes a second pin.
    expect(binding.admit).toHaveBeenCalledWith(SERIAL);
    expect(request.machine).toEqual({
      kind: 'phone-monitor',
      deviceSerial: SERIAL,
      permissions: ['BANK_EVENTS.INGEST'],
    });
    expect(request.user).toBeUndefined();
  });

  it('refuses a route that requires a permission the machine set does not carry', async () => {
    const { context, reflector } = contextFor(
      monitorHeaders(),
      'DEPOSITS.APPROVE',
    );
    const guard = guardWith(TOKEN, reflector);
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('deviceSerialOf', () => {
  it('accepts 8–64 chars of letters, digits, dot, underscore and dash, trimmed; nothing else', () => {
    expect(deviceSerialOf({ 'x-device-serial': SERIAL })).toBe(SERIAL);
    expect(deviceSerialOf({ 'x-device-serial': ' PC-01.home_1 ' })).toBe(
      'PC-01.home_1',
    );
    expect(deviceSerialOf({ 'x-device-serial': 'a'.repeat(64) })).toBe(
      'a'.repeat(64),
    );
    for (const bad of [
      undefined,
      '',
      'abcdefg',
      'a'.repeat(65),
      '-leading',
      'has space',
      'semi;colon',
    ]) {
      const headers: Record<string, string> = {};
      if (bad !== undefined) headers['x-device-serial'] = bad;
      expect(deviceSerialOf(headers)).toBeNull();
    }
    expect(deviceSerialOf(undefined)).toBeNull();
    // An array (a repeated header) is not a serial.
    expect(deviceSerialOf({ 'x-device-serial': [SERIAL, SERIAL] })).toBeNull();
  });
});
