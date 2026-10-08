import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SmsMessageStatus } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { SMS_REDACTED } from '../sms/sms.config';
import type { SmsGatewayService } from './sms-gateway.service';
import { FINAL_SMS_STATUSES } from './sms-redaction';
import { SmsSweeperService } from './sms-sweeper.service';

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('SmsSweeperService', () => {
  let prisma: { smsMessage: { updateMany: jest.Mock } };
  let gateway: { isOnline: jest.Mock };
  let sweeper: SmsSweeperService;
  let logError: jest.SpyInstance;
  let logLog: jest.SpyInstance;

  const build = (provider = 'phone-gateway') =>
    new SmsSweeperService(
      prisma as unknown as PrismaService,
      gateway as unknown as SmsGatewayService,
      configWith({
        SMS_PROVIDER: provider,
        SMS_GATEWAY_TOKEN: 'x'.repeat(40),
        SMS_GATEWAY_OFFLINE_AFTER_SECONDS: 90,
      }),
    );

  beforeEach(() => {
    prisma = {
      smsMessage: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 2 })
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 5 }),
      },
    };
    gateway = { isOnline: jest.fn().mockResolvedValue(true) };
    sweeper = build();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('expires QUEUED rows past their expiry and turns LEASED rows past their lease UNKNOWN', async () => {
    const now = new Date('2026-09-30T10:00:00.000Z');

    await expect(sweeper.sweep(now)).resolves.toEqual({
      expired: 2,
      unknown: 1,
      redacted: 5,
    });

    // Privacy extra (no audit finding): both moves blank the code in the same write.
    expect(prisma.smsMessage.updateMany).toHaveBeenNthCalledWith(1, {
      where: { status: SmsMessageStatus.QUEUED, expiresAt: { lte: now } },
      data: {
        status: SmsMessageStatus.EXPIRED,
        body: SMS_REDACTED,
        redactedAt: now,
      },
    });
    expect(prisma.smsMessage.updateMany).toHaveBeenNthCalledWith(2, {
      where: { status: SmsMessageStatus.LEASED, leaseExpiresAt: { lte: now } },
      data: {
        status: SmsMessageStatus.UNKNOWN,
        body: SMS_REDACTED,
        redactedAt: now,
      },
    });
  });

  it('B4 / privacy extra: then redacts the body of every final row that still holds one, whatever its age', async () => {
    const now = new Date('2026-09-30T10:00:00.000Z');

    await sweeper.sweep(now);

    expect(prisma.smsMessage.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        redactedAt: null,
        status: { in: [...FINAL_SMS_STATUSES] },
      },
      data: { body: SMS_REDACTED, redactedAt: now },
    });
    expect([...FINAL_SMS_STATUSES].sort()).toEqual(
      [
        SmsMessageStatus.SENT,
        SmsMessageStatus.DELIVERED,
        SmsMessageStatus.FAILED,
        SmsMessageStatus.DELIVERY_FAILED,
        SmsMessageStatus.EXPIRED,
        SmsMessageStatus.UNKNOWN,
        SmsMessageStatus.CANCELLED,
      ].sort(),
    );
    // QUEUED and LEASED rows still need their body.
    expect(FINAL_SMS_STATUSES).not.toContain(SmsMessageStatus.QUEUED);
    expect(FINAL_SMS_STATUSES).not.toContain(SmsMessageStatus.LEASED);
  });

  it('never puts anything back in the queue', async () => {
    await sweeper.sweep();

    for (const [args] of prisma.smsMessage.updateMany.mock.calls as [
      { data: { status: SmsMessageStatus } },
    ][]) {
      expect(args.data.status).not.toBe(SmsMessageStatus.QUEUED);
      expect(args.data.status).not.toBe(SmsMessageStatus.LEASED);
    }
  });

  it('a failing sweep is logged and retried on the next tick, never thrown into the scheduler', async () => {
    prisma.smsMessage.updateMany.mockReset();
    prisma.smsMessage.updateMany.mockRejectedValue(new Error('db down'));

    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      unknown: 0,
      redacted: 0,
    });
    expect(logError).toHaveBeenCalled();
  });

  describe('M-28 (partly): the gateway watchdog', () => {
    const offlineLines = () =>
      logError.mock.calls.filter(([message]) =>
        String(message).includes('SMS gateway is OFFLINE'),
      );
    const backLines = () =>
      logLog.mock.calls.filter(([message]) =>
        String(message).includes('back online'),
      );
    /** Enough sweeps' worth of update results. */
    const plentyOfUpdates = () =>
      prisma.smsMessage.updateMany.mockResolvedValue({ count: 0 });

    it('logs ONE error line when the gateway goes from accepting codes to refusing them, and one line when it is back — never once per tick', async () => {
      plentyOfUpdates();
      gateway.isOnline
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      for (let tick = 0; tick < 6; tick++) await sweeper.sweep();

      expect(offlineLines()).toHaveLength(1);
      expect(String(offlineLines()[0][0])).toContain('90 s');
      expect(String(offlineLines()[0][0])).toContain('SMS_GATEWAY_TOKEN');
      expect(backLines()).toHaveLength(1);
      // The check is made at every tick.
      expect(gateway.isOnline).toHaveBeenCalledTimes(6);
    });

    it('says nothing on the first tick, whatever the state (boot: the phone has not checked in yet)', async () => {
      plentyOfUpdates();
      gateway.isOnline.mockResolvedValue(false);

      await sweeper.sweep();
      await sweeper.sweep();

      expect(offlineLines()).toHaveLength(0);
      expect(backLines()).toHaveLength(0);
    });

    it('never checks with SMS_PROVIDER=log (there is no phone to watch)', async () => {
      plentyOfUpdates();
      sweeper = build('log');

      await sweeper.sweep();
      await sweeper.sweep();

      expect(gateway.isOnline).not.toHaveBeenCalled();
    });

    it('a failing check is logged and tried again next tick; the sweep itself still runs', async () => {
      gateway.isOnline.mockRejectedValueOnce(new Error('db down'));

      await expect(sweeper.sweep()).resolves.toEqual({
        expired: 2,
        unknown: 1,
        redacted: 5,
      });

      expect(
        logError.mock.calls.some(([message]) =>
          String(message).includes('online check failed'),
        ),
      ).toBe(true);
      expect(offlineLines()).toHaveLength(0);
    });
  });
});
