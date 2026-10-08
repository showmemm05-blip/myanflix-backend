import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '../generated/prisma/client';
import type { SmsGatewayService } from '../sms-gateway/sms-gateway.service';
import { SMS_UNAVAILABLE_MESSAGE } from './sms.config';
import { SmsService } from './sms.service';

const PHONE = '+959123456789';
const MESSAGE =
  '482913 - MyanFlix';
const TX = {
  marker: 'the caller transaction',
} as unknown as Prisma.TransactionClient;

describe('SmsService', () => {
  let gateway: {
    enqueue: jest.Mock;
    enqueueWithin: jest.Mock;
    notifyJobQueued: jest.Mock;
  };
  let logged: string[];

  const build = (env: Record<string, unknown>) =>
    new SmsService(
      { get: (key: string) => env[key] } as unknown as ConfigService,
      gateway as unknown as SmsGatewayService,
    );

  beforeEach(() => {
    gateway = {
      enqueue: jest.fn().mockResolvedValue(undefined),
      enqueueWithin: jest.fn().mockResolvedValue(true),
      notifyJobQueued: jest.fn(),
    };
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('SMS_PROVIDER=log (the default)', () => {
    it.each([{}, { SMS_PROVIDER: 'log' }, { SMS_PROVIDER: '' }])(
      'sends nothing and queues nothing (%p)',
      async (env) => {
        const sms = build(env);

        await expect(sms.send(PHONE, MESSAGE)).resolves.toBeUndefined();

        expect(gateway.enqueue).not.toHaveBeenCalled();
      },
    );

    it('sendWithin queues nothing, touches no transaction and hands back a no-op', async () => {
      const afterCommit = await build({}).sendWithin(TX, PHONE, MESSAGE);

      expect(gateway.enqueueWithin).not.toHaveBeenCalled();
      expect(() => afterCommit()).not.toThrow();
      expect(gateway.notifyJobQueued).not.toHaveBeenCalled();
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain('482913');
      expect(logged[0]).not.toContain(PHONE);
    });

    it('warns loudly at startup', () => {
      build({}).onModuleInit();

      expect(logged.join('\n')).toMatch(/SMS_PROVIDER=log — NO SMS IS SENT/);
    });

    it('never logs the code, the message or the full phone number (audit C-2)', async () => {
      await build({}).send(PHONE, MESSAGE);

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('+9*****789');
      expect(logged[0]).not.toContain('482913');
      expect(logged[0]).not.toContain(MESSAGE);
      expect(logged[0]).not.toContain(PHONE);
    });
  });

  describe('SMS_PROVIDER=phone-gateway', () => {
    const env = {
      SMS_PROVIDER: 'phone-gateway',
      SMS_GATEWAY_TOKEN: 'x'.repeat(40),
    };

    it('queues the SMS for the gateway phone with the code id and expiry', async () => {
      const expiresAt = new Date();

      await build(env).send(PHONE, MESSAGE, { otpCodeId: 'otp-1', expiresAt });

      expect(gateway.enqueue).toHaveBeenCalledWith(PHONE, MESSAGE, {
        otpCodeId: 'otp-1',
        expiresAt,
      });
    });

    it("passes the gateway's 503 straight through", async () => {
      gateway.enqueue.mockRejectedValue(
        new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE),
      );

      await expect(build(env).send(PHONE, MESSAGE)).rejects.toThrow(
        SMS_UNAVAILABLE_MESSAGE,
      );
    });

    it('sendWithin queues inside the caller transaction and wakes the phone only when told (after the commit)', async () => {
      const expiresAt = new Date();

      const afterCommit = await build(env).sendWithin(TX, PHONE, MESSAGE, {
        otpCodeId: 'otp-1',
        expiresAt,
      });

      expect(gateway.enqueueWithin).toHaveBeenCalledWith(TX, PHONE, MESSAGE, {
        otpCodeId: 'otp-1',
        expiresAt,
      });
      expect(gateway.enqueue).not.toHaveBeenCalled();
      expect(gateway.notifyJobQueued).not.toHaveBeenCalled();
      afterCommit();
      expect(gateway.notifyJobQueued).toHaveBeenCalledTimes(1);
    });

    it('sendWithin wakes nobody when the code was already queued (a no-op)', async () => {
      gateway.enqueueWithin.mockResolvedValue(false);

      const afterCommit = await build(env).sendWithin(TX, PHONE, MESSAGE);
      afterCommit();

      expect(gateway.notifyJobQueued).not.toHaveBeenCalled();
    });

    it("sendWithin passes the gateway's refusal straight through", async () => {
      gateway.enqueueWithin.mockRejectedValue(
        new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE),
      );

      await expect(build(env).sendWithin(TX, PHONE, MESSAGE)).rejects.toThrow(
        SMS_UNAVAILABLE_MESSAGE,
      );
    });

    it('does not print the dev warning at startup', () => {
      build(env).onModuleInit();

      expect(logged.join('\n')).not.toMatch(/NO SMS IS SENT/);
      expect(logged.join('\n')).toMatch(/phone-gateway/);
    });
  });
});
