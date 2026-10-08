import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeviceTokenGuard,
  deviceIdOf,
  gatewayTokenMatches,
  smsDeviceTracker,
  type SmsDeviceRequest,
} from './device-token.guard';
import type { SmsDeviceBindingService } from './sms-device-binding.service';

const TOKEN = 'gateway-token-0123456789abcdef-0123456789';
const DEVICE = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';

function config(token: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === 'SMS_GATEWAY_TOKEN' ? token : undefined),
  } as unknown as ConfigService;
}

function contextFor(request: SmsDeviceRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestWith(
  headers: Record<string, string | undefined>,
): SmsDeviceRequest {
  return { headers };
}

describe('DeviceTokenGuard', () => {
  let binding: { admit: jest.Mock };
  let guard: DeviceTokenGuard;
  const guardWith = (token: string | undefined) =>
    new DeviceTokenGuard(
      config(token),
      binding as unknown as SmsDeviceBindingService,
    );

  beforeEach(() => {
    binding = { admit: jest.fn().mockResolvedValue(true) };
    guard = guardWith(TOKEN);
  });

  it('accepts the right token + the pinned device uuid and attaches the device', async () => {
    const request = requestWith({
      authorization: `Bearer ${TOKEN}`,
      'x-device-id': DEVICE.toUpperCase(),
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.smsDevice).toEqual({ id: DEVICE });
    expect(binding.admit).toHaveBeenCalledWith(DEVICE);
  });

  it('H-5: 401 "Unauthorized" for a device the binding refuses (the token belongs to another phone)', async () => {
    binding.admit.mockResolvedValue(false);
    const request = requestWith({
      authorization: `Bearer ${TOKEN}`,
      'x-device-id': DEVICE,
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      new UnauthorizedException(),
    );
    expect(request.smsDevice).toBeUndefined();
  });

  it.each([
    ['no Authorization header', { 'x-device-id': DEVICE }],
    [
      'a wrong token',
      { authorization: 'Bearer wrong-token', 'x-device-id': DEVICE },
    ],
    [
      'the token without the Bearer scheme',
      { authorization: TOKEN, 'x-device-id': DEVICE },
    ],
    [
      'a token that only shares a prefix',
      { authorization: `Bearer ${TOKEN}x`, 'x-device-id': DEVICE },
    ],
    ['no X-Device-Id', { authorization: `Bearer ${TOKEN}` }],
    [
      'an X-Device-Id that is not a uuid',
      { authorization: `Bearer ${TOKEN}`, 'x-device-id': 'phone-1' },
    ],
  ])('401 "Unauthorized" with %s', async (_label, headers) => {
    const request = requestWith(headers);

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      new UnauthorizedException(),
    );
    expect(request.smsDevice).toBeUndefined();
    // The token check comes first: a wrong token never pins a device and
    // is never counted as a rejected one.
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('401 for every request while SMS_GATEWAY_TOKEN is not configured', async () => {
    const unconfigured = guardWith(undefined);
    const request = requestWith({
      authorization: 'Bearer ',
      'x-device-id': DEVICE,
    });

    await expect(unconfigured.canActivate(contextFor(request))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(binding.admit).not.toHaveBeenCalled();
  });

  it('answers with the plain "Unauthorized" message the device expects', async () => {
    try {
      await guard.canActivate(contextFor(requestWith({})));
      fail('expected a 401');
    } catch (error) {
      expect((error as UnauthorizedException).getStatus()).toBe(401);
      expect((error as UnauthorizedException).message).toBe('Unauthorized');
    }
  });
});

describe('gatewayTokenMatches', () => {
  it('matches only the exact token, whatever the lengths', () => {
    expect(gatewayTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(gatewayTokenMatches('', TOKEN)).toBe(false);
    expect(gatewayTokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(gatewayTokenMatches(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe('deviceIdOf', () => {
  it('lower-cases a uuid and refuses anything else', () => {
    expect(deviceIdOf({ 'x-device-id': ` ${DEVICE.toUpperCase()} ` })).toBe(
      DEVICE,
    );
    expect(deviceIdOf({ 'x-device-id': 'not-a-uuid' })).toBeNull();
    expect(deviceIdOf({ 'x-device-id': [DEVICE, DEVICE] })).toBeNull();
    expect(deviceIdOf({})).toBeNull();
  });
});

describe('smsDeviceTracker', () => {
  const saved = process.env.SMS_GATEWAY_TOKEN;
  beforeEach(() => {
    process.env.SMS_GATEWAY_TOKEN = TOKEN;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SMS_GATEWAY_TOKEN;
    else process.env.SMS_GATEWAY_TOKEN = saved;
  });

  const track = (headers: Record<string, string>) =>
    smsDeviceTracker(
      { headers, socket: { remoteAddress: '203.0.113.9' } },
      {} as ExecutionContext,
    );

  it('counts a correct-token request per client address under its own prefix, never per the caller-chosen device id', () => {
    expect(
      track({ authorization: `Bearer ${TOKEN}`, 'x-device-id': DEVICE }),
    ).toBe('sms-gateway:203.0.113.9');
  });

  it("M-28: a token holder gets ONE bucket however many device ids they invent, and cannot address the phone's bucket from elsewhere", () => {
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const fromAttacker = (id: string) =>
      smsDeviceTracker(
        {
          headers: { authorization: `Bearer ${TOKEN}`, 'x-device-id': id },
          socket: { remoteAddress: '198.51.100.7' },
        },
        {} as ExecutionContext,
      );

    // Spraying under the real phone's id from another address lands in the
    // attacker's own bucket, not the phone's.
    expect(fromAttacker(DEVICE)).toBe('sms-gateway:198.51.100.7');
    expect(fromAttacker(DEVICE)).not.toBe(
      track({ authorization: `Bearer ${TOKEN}`, 'x-device-id': DEVICE }),
    );
    // And a made-up id buys no fresh bucket.
    expect(fromAttacker(other)).toBe(fromAttacker(DEVICE));
  });

  it("counts anything without the token per client IP (a different key from the phone's), so made-up device ids buy nothing there either", () => {
    expect(track({ authorization: 'Bearer nope', 'x-device-id': DEVICE })).toBe(
      '203.0.113.9',
    );
    expect(track({ 'x-device-id': DEVICE })).toBe('203.0.113.9');
    expect(track({ 'x-device-id': DEVICE })).not.toBe(
      track({ authorization: `Bearer ${TOKEN}`, 'x-device-id': DEVICE }),
    );
  });

  it('falls back to the IP when no gateway token is configured', () => {
    delete process.env.SMS_GATEWAY_TOKEN;
    expect(track({ authorization: 'Bearer ', 'x-device-id': DEVICE })).toBe(
      '203.0.113.9',
    );
  });
});
