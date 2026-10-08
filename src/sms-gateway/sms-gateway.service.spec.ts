import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SmsMessageStatus } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  INVALID_SMS_PHONE_MESSAGE,
  SMS_REDACTED,
  SMS_UNAVAILABLE_MESSAGE,
  TOO_MANY_CODE_REQUESTS_MESSAGE,
} from '../sms/sms.config';
import type { JobResultDto } from './dto/job-result.dto';
import {
  EMPTY_BINDING,
  type SmsDeviceBindingService,
} from './sms-device-binding.service';
import {
  DEFAULT_SMS_TTL_MS,
  SMS_LEASE_MS,
  SmsGatewayService,
  startOfUtcDay,
} from './sms-gateway.service';
import { SmsJobWaiter } from './sms-job-waiter';

const DEVICE = '3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f38';
const OTHER_DEVICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const PHONE = '+959123456789';
const BODY = '482913 - MyanFlix';

type RawCall = [TemplateStringsArray, ...unknown[]];
const sqlOf = (call: unknown[]) => (call as RawCall)[0].join('?');
const valuesOf = (call: unknown[]) => (call as RawCall).slice(1);

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

type CountArgs = { where: { phone?: string } };

describe('SmsGatewayService', () => {
  let tx: {
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    smsMessage: { count: jest.Mock };
    smsGatewayDevice: { count: jest.Mock };
  };
  /** Today's rows: for this number (per-phone cap) and in all (global cap). */
  let today: { toPhone: number; all: number };
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    smsGatewayDevice: {
      count: jest.Mock;
      upsert: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
    smsMessage: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      groupBy: jest.Mock;
    };
  };
  let waiter: SmsJobWaiter;
  let binding: { view: jest.Mock };
  let service: SmsGatewayService;
  let logged: string[];

  function build(config: Record<string, unknown> = {}) {
    service = new SmsGatewayService(
      prisma as unknown as PrismaService,
      waiter,
      binding as unknown as SmsDeviceBindingService,
      configWith({
        SMS_PROVIDER: 'phone-gateway',
        SMS_GATEWAY_TOKEN: 'x'.repeat(40),
        SMS_DAILY_CAP: 1000,
        SMS_DAILY_CAP_PER_PHONE: 10,
        SMS_GATEWAY_OFFLINE_AFTER_SECONDS: 90,
        ...config,
      }),
    );
  }

  beforeEach(() => {
    today = { toPhone: 0, all: 0 };
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ id: JOB_ID }]),
      smsMessage: {
        count: jest.fn(({ where }: CountArgs) =>
          Promise.resolve(where.phone ? today.toPhone : today.all),
        ),
      },
      smsGatewayDevice: { count: jest.fn().mockResolvedValue(1) },
    };
    prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      smsGatewayDevice: {
        count: jest.fn().mockResolvedValue(1),
        upsert: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        // No row yet: the first heartbeat creates it.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      smsMessage: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    waiter = new SmsJobWaiter();
    binding = { view: jest.fn().mockResolvedValue(EMPTY_BINDING) };
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    }
    build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('enqueue', () => {
    it('refuses with the exact 503 while no device able to send was seen in the offline window, queueing nothing', async () => {
      tx.smsGatewayDevice.count.mockResolvedValue(0);
      const notify = jest.spyOn(waiter, 'notifyJobQueued');

      await expect(service.enqueue(PHONE, BODY)).rejects.toThrow(
        new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE),
      );

      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('asks for a device seen within SMS_GATEWAY_OFFLINE_AFTER_SECONDS whose last heartbeat did not say canSend=false (B5)', async () => {
      build({ SMS_GATEWAY_OFFLINE_AFTER_SECONDS: 120 });
      const before = Date.now();

      await service.enqueue(PHONE, BODY);

      const where = (
        tx.smsGatewayDevice.count.mock.calls[0] as [
          { where: { lastSeenAt: { gte: Date }; canSend: boolean } },
        ]
      )[0].where;
      expect(where.canSend).toBe(true);
      const windowMs = before - where.lastSeenAt.gte.getTime();
      expect(windowMs).toBeGreaterThanOrEqual(120_000 - 50);
      expect(windowMs).toBeLessThanOrEqual(120_000 + 50);
    });

    it('refuses with the exact 503 once today already holds SMS_DAILY_CAP rows', async () => {
      build({ SMS_DAILY_CAP: 3 });
      today.all = 3;
      const notify = jest.spyOn(waiter, 'notifyJobQueued');

      await expect(service.enqueue(PHONE, BODY)).rejects.toThrow(
        new ServiceUnavailableException(SMS_UNAVAILABLE_MESSAGE),
      );

      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });

    it('still queues the last SMS under the cap, counting from UTC midnight', async () => {
      build({ SMS_DAILY_CAP: 3 });
      today.all = 2;

      await service.enqueue(PHONE, BODY);

      expect(tx.smsMessage.count).toHaveBeenCalledWith({
        where: { createdAt: { gte: startOfUtcDay(new Date()) } },
      });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    describe('B3: SMS_DAILY_CAP_PER_PHONE', () => {
      it('refuses a number that got its SMS for the day with the 409 the apps already translate', async () => {
        build({ SMS_DAILY_CAP_PER_PHONE: 4 });
        today.toPhone = 4;
        const notify = jest.spyOn(waiter, 'notifyJobQueued');

        await expect(service.enqueue(PHONE, BODY)).rejects.toThrow(
          new ConflictException(TOO_MANY_CODE_REQUESTS_MESSAGE),
        );
        expect(TOO_MANY_CODE_REQUESTS_MESSAGE).toBe(
          'Too many code requests — please try again later',
        );

        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      });

      it('counts this number since UTC midnight, leaving out CANCELLED and EXPIRED rows (they never left the server)', async () => {
        build({ SMS_DAILY_CAP_PER_PHONE: 4 });
        today.toPhone = 3;

        await service.enqueue(PHONE, BODY);

        expect(tx.smsMessage.count).toHaveBeenCalledWith({
          where: {
            phone: PHONE,
            createdAt: { gte: startOfUtcDay(new Date()) },
            status: {
              notIn: [SmsMessageStatus.CANCELLED, SmsMessageStatus.EXPIRED],
            },
          },
        });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      });

      it('defaults to 10 per number', async () => {
        build({ SMS_DAILY_CAP_PER_PHONE: undefined });
        today.toPhone = 9;
        await service.enqueue(PHONE, BODY);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

        today.toPhone = 10;
        await expect(service.enqueue(PHONE, BODY)).rejects.toThrow(
          ConflictException,
        );
      });
    });

    describe('B3: Myanmar mobile numbers only', () => {
      it.each([
        ['a Yangon landline', '+951234567'],
        ['a foreign number', '+14155550123'],
        ['too short', '+95912345'],
        ['too long', '+9591234567890'],
        ['not normalised', '09123456789'],
      ])(
        '400 for %s (%s), before anything else is looked at',
        async (_, phone) => {
          await expect(service.enqueue(phone, BODY)).rejects.toThrow(
            new BadRequestException(INVALID_SMS_PHONE_MESSAGE),
          );

          expect(tx.smsGatewayDevice.count).not.toHaveBeenCalled();
          expect(tx.$queryRaw).not.toHaveBeenCalled();
        },
      );

      it.each(['+9591234567', '+95912345678', '+959123456789'])(
        'queues %s (+959 and 7-9 digits)',
        async (phone) => {
          await service.enqueue(phone, BODY);
          expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        },
      );
    });

    it('takes the advisory lock before counting, so both cap checks and the insert are one step', async () => {
      await service.enqueue(PHONE, BODY);

      expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain(
        'pg_advisory_xact_lock',
      );
      const [perPhone, global] = tx.smsMessage.count.mock.invocationCallOrder;
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(perPhone);
      expect(perPhone).toBeLessThan(global);
      expect(global).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    });

    it('inserts one QUEUED row carrying the code id and expiry, then wakes the long-poll', async () => {
      const notify = jest.spyOn(waiter, 'notifyJobQueued');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

      await service.enqueue(PHONE, BODY, { otpCodeId: 'otp-1', expiresAt });

      const call = tx.$queryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain('INSERT INTO "sms_messages"');
      expect(sql).toContain(`'QUEUED'`);
      expect(sql).toContain('ON CONFLICT ("otpCodeId") DO NOTHING');
      const values = valuesOf(call);
      expect(values).toEqual(
        expect.arrayContaining(['otp-1', PHONE, BODY, expiresAt]),
      );
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.invocationCallOrder[0]).toBeGreaterThan(
        tx.$queryRaw.mock.invocationCallOrder[0],
      );
    });

    it('gives an SMS without an expiry five minutes', async () => {
      const before = Date.now();

      await service.enqueue(PHONE, BODY);

      const values = valuesOf(tx.$queryRaw.mock.calls[0]);
      const dates = values.filter((v): v is Date => v instanceof Date);
      const expiry = Math.max(...dates.map((d) => d.getTime()));
      expect(expiry - before).toBeGreaterThanOrEqual(DEFAULT_SMS_TTL_MS - 50);
      expect(expiry - before).toBeLessThanOrEqual(DEFAULT_SMS_TTL_MS + 50);
      expect(values).toContain(null); // no otpCodeId
    });

    it('a second SMS for the same code is a no-op: nothing thrown, nobody woken', async () => {
      tx.$queryRaw.mockResolvedValue([]); // ON CONFLICT DO NOTHING
      const notify = jest.spyOn(waiter, 'notifyJobQueued');

      await expect(
        service.enqueue(PHONE, BODY, { otpCodeId: 'otp-1' }),
      ).resolves.toBeUndefined();

      expect(notify).not.toHaveBeenCalled();
    });

    it('never logs the code, the body or the full phone number', async () => {
      await service.enqueue(PHONE, BODY, { otpCodeId: 'otp-1' });
      today.toPhone = 99;
      await expect(service.enqueue(PHONE, BODY)).rejects.toThrow();
      today.toPhone = 0;
      tx.smsGatewayDevice.count.mockResolvedValue(0);
      await expect(service.enqueue(PHONE, BODY)).rejects.toThrow();

      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) {
        expect(line).not.toContain('482913');
        expect(line).not.toContain(PHONE);
      }
    });
  });

  describe('enqueueWithin (inside the caller transaction)', () => {
    const callerTx = () =>
      tx as unknown as Parameters<SmsGatewayService['enqueueWithin']>[0];

    it('writes on the caller transaction, opens none of its own, and never wakes the phone itself', async () => {
      const notify = jest.spyOn(waiter, 'notifyJobQueued');

      await expect(
        service.enqueueWithin(callerTx(), PHONE, BODY, { otpCodeId: 'otp-1' }),
      ).resolves.toBe(true);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      // Only the caller knows when its transaction commits.
      expect(notify).not.toHaveBeenCalled();
      service.notifyJobQueued();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('resolves false for a code that is already queued', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(
        service.enqueueWithin(callerTx(), PHONE, BODY, { otpCodeId: 'otp-1' }),
      ).resolves.toBe(false);
    });
  });

  describe('leaseNext', () => {
    it('leases the oldest live QUEUED row in one UPDATE ... FOR UPDATE SKIP LOCKED', async () => {
      const expiresAt = new Date(Date.now() + 120_000);
      prisma.$queryRaw.mockResolvedValue([
        { id: JOB_ID, phone: PHONE, body: BODY, expiresAt },
      ]);
      const before = Date.now();

      const job = await service.leaseNext(DEVICE);

      expect(job).toEqual({
        id: JOB_ID,
        phone: PHONE,
        body: BODY,
        expiresAt: expiresAt.toISOString(),
      });
      const call = prisma.$queryRaw.mock.calls[0];
      const sql = sqlOf(call).replace(/\s+/g, ' ');
      expect(sql).toContain(`UPDATE "sms_messages"`);
      expect(sql).toContain(`"status" = 'LEASED'`);
      expect(sql).toContain(`"leaseExpiresAt" = LEAST(`);
      expect(sql).toContain(`"expiresAt")`);
      expect(sql).toContain(`WHERE "status" = 'QUEUED'`);
      expect(sql).toContain(`AND "expiresAt" > `);
      expect(sql).toContain('ORDER BY "createdAt" ASC');
      expect(sql).toContain('LIMIT 1 FOR UPDATE SKIP LOCKED');
      expect(sql).toContain('RETURNING "id", "phone", "body", "expiresAt"');
      // B5: nothing for a device whose last heartbeat said it cannot send.
      expect(sql).toContain(
        `AND NOT EXISTS ( SELECT 1 FROM "sms_gateway_devices" WHERE "id" = ? AND "canSend" = false )`,
      );
      const values = valuesOf(call);
      expect(values).toContain(DEVICE);
      const [leasedAt, leaseUntil] = values.filter(
        (v): v is Date => v instanceof Date,
      );
      expect(leasedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(leaseUntil.getTime() - leasedAt.getTime()).toBe(SMS_LEASE_MS);
    });

    it('returns null when nothing is queued', async () => {
      await expect(service.leaseNext(DEVICE)).resolves.toBeNull();
    });

    it('logs the message id and masked phone, never the body', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: JOB_ID, phone: PHONE, body: BODY, expiresAt: new Date() },
      ]);

      await service.leaseNext(DEVICE);

      expect(logged.join('\n')).toContain(JOB_ID);
      expect(logged.join('\n')).not.toContain('482913');
      expect(logged.join('\n')).not.toContain(PHONE);
    });
  });

  describe('pollJobs (long-poll)', () => {
    const leased = () => [
      {
        id: JOB_ID,
        phone: PHONE,
        body: BODY,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];

    it('counts as a heartbeat and returns a queued job at once', async () => {
      prisma.$queryRaw.mockResolvedValueOnce(leased());

      const result = await service.pollJobs(DEVICE, 25);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe(JOB_ID);
      expect(prisma.smsGatewayDevice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: DEVICE },
          update: { lastSeenAt: expect.any(Date) },
        }),
      );
    });

    it('holds an empty poll and returns the job as soon as one is queued', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(leased());
      const started = Date.now();

      const poll = service.pollJobs(DEVICE, 25);
      await new Promise((r) => setTimeout(r, 50));
      waiter.notifyJobQueued();
      const result = await poll;

      expect(result.jobs.map((j) => j.id)).toEqual([JOB_ID]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('returns no jobs once the wait is over', async () => {
      const result = await service.pollJobs(DEVICE, 0);

      expect(result).toEqual({ jobs: [] });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('stops without leasing when the phone drops the connection', async () => {
      const gone = new AbortController();

      const poll = service.pollJobs(DEVICE, 25, gone.signal);
      await new Promise((r) => setTimeout(r, 20));
      gone.abort();
      const result = await poll;

      expect(result).toEqual({ jobs: [] });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // the first, empty lease only
    });

    it('a newer poll from the same device releases the stale one without leasing', async () => {
      const stale = service.pollJobs(DEVICE, 25);
      await new Promise((r) => setTimeout(r, 20));

      prisma.$queryRaw.mockResolvedValueOnce(leased());
      const fresh = await service.pollJobs(DEVICE, 25);

      await expect(stale).resolves.toEqual({ jobs: [] });
      expect(fresh.jobs.map((j) => j.id)).toEqual([JOB_ID]);
    });
  });

  describe('recordResult', () => {
    const result = (overrides: Partial<JobResultDto> = {}): JobResultDto => ({
      status: SmsMessageStatus.SENT,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      ...overrides,
    });
    const row = (
      status: SmsMessageStatus,
      deviceId: string | null = DEVICE,
    ) => ({
      id: JOB_ID,
      status,
      deviceId,
      phone: PHONE,
    });

    it('404 for a job that does not exist', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(null);

      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).rejects.toThrow(NotFoundException);
    });

    it('404 for a job another device leased (and for one never leased)', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.LEASED, OTHER_DEVICE),
      );
      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).rejects.toThrow(NotFoundException);

      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.EXPIRED, null),
      );
      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('LEASED -> SENT stamps sentAt with the phone time, conditional on the status it read', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.LEASED),
      );
      const occurredAt = new Date(Date.now() - 5_000).toISOString();

      await expect(
        service.recordResult(DEVICE, JOB_ID, result({ occurredAt })),
      ).resolves.toEqual({ id: JOB_ID, status: SmsMessageStatus.SENT });

      expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith({
        where: {
          id: JOB_ID,
          deviceId: DEVICE,
          status: SmsMessageStatus.LEASED,
        },
        data: {
          status: SmsMessageStatus.SENT,
          sentAt: new Date(occurredAt),
          body: SMS_REDACTED,
          redactedAt: expect.any(Date),
        },
      });
    });

    it('privacy extra: every reported result blanks the body (the code) in the same write', async () => {
      for (const [from, reported] of [
        [SmsMessageStatus.LEASED, SmsMessageStatus.SENT],
        [SmsMessageStatus.LEASED, SmsMessageStatus.FAILED],
        [SmsMessageStatus.SENT, SmsMessageStatus.DELIVERED],
        [SmsMessageStatus.SENT, SmsMessageStatus.DELIVERY_FAILED],
        [SmsMessageStatus.UNKNOWN, SmsMessageStatus.SENT],
        [SmsMessageStatus.EXPIRED, SmsMessageStatus.FAILED],
      ] as const) {
        prisma.smsMessage.updateMany.mockClear();
        prisma.smsMessage.findUnique.mockResolvedValue(row(from));

        await service.recordResult(
          DEVICE,
          JOB_ID,
          result({ status: reported }),
        );

        expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: reported,
              body: SMS_REDACTED,
              redactedAt: expect.any(Date),
            }),
          }),
        );
      }
    });

    it('LEASED -> FAILED keeps the error code and message', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.LEASED),
      );

      await service.recordResult(
        DEVICE,
        JOB_ID,
        result({
          status: SmsMessageStatus.FAILED,
          errorCode: 'expired',
          errorMessage: 'Job expired before it could be sent',
        }),
      );

      expect(prisma.smsMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: SmsMessageStatus.FAILED,
            failedAt: expect.any(Date),
            errorCode: 'expired',
            errorMessage: 'Job expired before it could be sent',
          }),
        }),
      );
    });

    it('SENT -> DELIVERED stamps deliveredAt; SENT -> DELIVERY_FAILED stamps failedAt', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.SENT),
      );

      await service.recordResult(
        DEVICE,
        JOB_ID,
        result({ status: SmsMessageStatus.DELIVERED }),
      );
      await service.recordResult(
        DEVICE,
        JOB_ID,
        result({ status: SmsMessageStatus.DELIVERY_FAILED, errorCode: '3' }),
      );

      const [delivered, deliveryFailed] = prisma.smsMessage.updateMany.mock
        .calls as [{ data: Record<string, unknown> }][];
      expect(delivered[0].data).toEqual({
        status: SmsMessageStatus.DELIVERED,
        deliveredAt: expect.any(Date),
        body: SMS_REDACTED,
        redactedAt: expect.any(Date),
      });
      expect(deliveryFailed[0].data).toEqual({
        status: SmsMessageStatus.DELIVERY_FAILED,
        failedAt: expect.any(Date),
        errorCode: '3',
        errorMessage: null,
        body: SMS_REDACTED,
        redactedAt: expect.any(Date),
      });
    });

    it('a late SENT after the sweeper gave up (UNKNOWN) is still recorded', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.UNKNOWN),
      );

      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).resolves.toEqual({ id: JOB_ID, status: SmsMessageStatus.SENT });
    });

    it('a repeat of the same result is an idempotent 200 that writes nothing', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.SENT),
      );

      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).resolves.toEqual({ id: JOB_ID, status: SmsMessageStatus.SENT });
      expect(prisma.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('any other move is a 409 that writes nothing', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.DELIVERED),
      );

      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.smsMessage.updateMany).not.toHaveBeenCalled();
    });

    it('re-decides after losing a race (a twin report landed first)', async () => {
      prisma.smsMessage.findUnique
        .mockResolvedValueOnce(row(SmsMessageStatus.LEASED))
        .mockResolvedValueOnce(row(SmsMessageStatus.SENT));
      prisma.smsMessage.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.recordResult(DEVICE, JOB_ID, result()),
      ).resolves.toEqual({ id: JOB_ID, status: SmsMessageStatus.SENT });
      expect(prisma.smsMessage.updateMany).toHaveBeenCalledTimes(1);
    });

    it('never stores a time from the future (a phone with a fast clock)', async () => {
      prisma.smsMessage.findUnique.mockResolvedValue(
        row(SmsMessageStatus.LEASED),
      );
      const future = new Date(Date.now() + 3_600_000).toISOString();

      await service.recordResult(
        DEVICE,
        JOB_ID,
        result({ occurredAt: future }),
      );

      const data = (
        prisma.smsMessage.updateMany.mock.calls[0] as [
          { data: { sentAt: Date } },
        ]
      )[0].data;
      expect(data.sentAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('heartbeat', () => {
    it('upserts the device and answers with the server time and poll wait', async () => {
      const response = await service.heartbeat(DEVICE, {
        appVersion: '1.0.0',
        battery: 87,
        charging: true,
        signalLevel: 3,
        networkType: 'LTE',
        simOperator: 'ATOM',
        pendingResults: 2,
        lastError: null,
      });

      expect(response.pollWaitSeconds).toBe(25);
      expect(new Date(response.serverTime).toISOString()).toBe(
        response.serverTime,
      );
      const args = prisma.smsGatewayDevice.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        },
      ];
      expect(args[0].where).toEqual({ id: DEVICE });
      expect(args[0].update).toEqual({
        lastSeenAt: expect.any(Date),
        appVersion: '1.0.0',
        battery: 87,
        charging: true,
        signalLevel: 3,
        networkType: 'LTE',
        simOperator: 'ATOM',
        pendingResults: 2,
        lastError: null,
        canSend: true,
        notReadyReason: null,
      });
      expect(args[0].create).toEqual({ id: DEVICE, ...args[0].update });
    });

    it("B5: stores the phone's own canSend verdict and its reason", async () => {
      await service.heartbeat(DEVICE, {
        appVersion: '1.0.0',
        battery: 50,
        charging: false,
        pendingResults: 0,
        canSend: false,
        notReadyReason: 'no_service',
      });

      const update = (
        prisma.smsGatewayDevice.upsert.mock.calls[0] as [
          { update: Record<string, unknown> },
        ]
      )[0].update;
      expect(update).toMatchObject({
        canSend: false,
        notReadyReason: 'no_service',
      });
    });

    it('stores missing optional fields as null', async () => {
      await service.heartbeat(DEVICE, {
        appVersion: '1.0.0',
        battery: 50,
        charging: false,
        pendingResults: 0,
      });

      const update = (
        prisma.smsGatewayDevice.upsert.mock.calls[0] as [
          { update: Record<string, unknown> },
        ]
      )[0].update;
      expect(update).toMatchObject({
        signalLevel: null,
        networkType: null,
        simOperator: null,
        lastError: null,
        // An app that does not report canSend is taken as able.
        canSend: true,
        notReadyReason: null,
      });
    });

    describe('M-28 (partly): the "cannot send" alarm', () => {
      const beat = (canSend: boolean | undefined, reason?: string) =>
        service.heartbeat(DEVICE, {
          appVersion: '1.0.0',
          battery: 50,
          charging: true,
          pendingResults: 0,
          ...(canSend === undefined ? {} : { canSend }),
          ...(reason ? { notReadyReason: reason } : {}),
        });
      const alarms = () =>
        logged.filter((line) => line.includes('says it cannot send SMS'));
      const recoveries = () =>
        logged.filter((line) => line.includes('can send SMS again'));
      const rowSays = (canSend: boolean | null) =>
        prisma.smsGatewayDevice.findUnique.mockResolvedValue(
          canSend === null ? null : { canSend },
        );

      it('logs an ERROR line, with the reason and the token advice, when the verdict flips to "cannot send"', async () => {
        rowSays(true);

        await beat(false, 'no_service');

        expect(alarms()).toHaveLength(1);
        expect(alarms()[0]).toContain(DEVICE);
        expect(alarms()[0]).toContain('no_service');
        expect(alarms()[0]).toContain('503');
        expect(alarms()[0]).toContain('SMS_GATEWAY_TOKEN');
        expect(recoveries()).toHaveLength(0);
      });

      it('also for a first heartbeat (no row yet) that already says it cannot send', async () => {
        rowSays(null);

        await beat(false);

        expect(alarms()).toHaveLength(1);
        expect(alarms()[0]).toContain('no reason given');
      });

      it('never repeats the line while the verdict stays "cannot send" (a repeated forged heartbeat cannot flood the log)', async () => {
        rowSays(false);

        await beat(false, 'no_service');
        await beat(false, 'no_service');

        expect(alarms()).toHaveLength(0);
      });

      it('logs one plain line when the phone can send again, and nothing while it keeps saying so', async () => {
        rowSays(false);
        await beat(true);
        rowSays(true);
        await beat(true);
        await beat(undefined);

        expect(recoveries()).toHaveLength(1);
        expect(alarms()).toHaveLength(0);
      });

      it('reads the old verdict before writing the new one, keyed on the same device', async () => {
        await beat(true);

        expect(prisma.smsGatewayDevice.findUnique).toHaveBeenCalledWith({
          where: { id: DEVICE },
          select: { canSend: true },
        });
        const [read] =
          prisma.smsGatewayDevice.findUnique.mock.invocationCallOrder;
        const [write] = prisma.smsGatewayDevice.upsert.mock.invocationCallOrder;
        expect(read).toBeLessThan(write);
      });
    });
  });

  describe('status', () => {
    it('reports provider, online, the last device, today by status and both caps', async () => {
      build({ SMS_DAILY_CAP: 500, SMS_DAILY_CAP_PER_PHONE: 7 });
      const device = {
        id: DEVICE,
        lastSeenAt: new Date(Date.now() - 10_000),
        appVersion: '1.0.0',
        battery: 80,
        charging: true,
        signalLevel: 4,
        networkType: 'LTE',
        simOperator: 'ATOM',
        pendingResults: 0,
        lastError: null,
        canSend: true,
        notReadyReason: null,
      };
      prisma.smsGatewayDevice.findFirst.mockResolvedValue(device);
      prisma.smsMessage.groupBy.mockResolvedValue([
        { status: SmsMessageStatus.SENT, _count: { _all: 4 } },
        { status: SmsMessageStatus.DELIVERED, _count: { _all: 7 } },
        { status: SmsMessageStatus.UNKNOWN, _count: { _all: 1 } },
        { status: SmsMessageStatus.CANCELLED, _count: { _all: 2 } },
      ]);

      await expect(service.status()).resolves.toEqual({
        provider: 'phone-gateway',
        online: true,
        device,
        binding: EMPTY_BINDING,
        today: {
          queued: 0,
          leased: 0,
          sent: 4,
          delivered: 7,
          failed: 0,
          deliveryFailed: 0,
          expired: 0,
          unknown: 1,
          cancelled: 2,
        },
        dailyCap: 500,
        dailyCapPerPhone: 7,
      });
      const select = (
        prisma.smsGatewayDevice.findFirst.mock.calls[0] as [
          { select: Record<string, boolean> },
        ]
      )[0].select;
      expect(select).toMatchObject({ canSend: true, notReadyReason: true });
      expect(prisma.smsMessage.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdAt: { gte: startOfUtcDay(new Date()) } },
        }),
      );
    });

    it('H-5: shows the pinned phone (not whichever device was seen last) and the binding with its last refused device', async () => {
      const pinned = {
        ...EMPTY_BINDING,
        deviceId: DEVICE,
        pinnedAt: new Date('2026-10-06T08:00:00.000Z'),
        lastRejectedDeviceId: OTHER_DEVICE,
        lastRejectedAt: new Date('2026-10-06T09:00:00.000Z'),
        rejectedCount: 3,
      };
      binding.view.mockResolvedValue(pinned);

      await expect(service.status()).resolves.toMatchObject({
        binding: pinned,
      });
      expect(prisma.smsGatewayDevice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: DEVICE } }),
      );
    });

    it('is online exactly when enqueue would accept: a device seen in the window that did not say canSend=false', async () => {
      prisma.smsGatewayDevice.count.mockResolvedValue(0);
      await expect(service.status()).resolves.toMatchObject({
        online: false,
        device: null,
      });

      const notReady = {
        id: DEVICE,
        lastSeenAt: new Date(),
        canSend: false,
        notReadyReason: 'no_service',
      };
      prisma.smsGatewayDevice.findFirst.mockResolvedValue(notReady);
      await expect(service.status()).resolves.toMatchObject({
        online: false,
        device: notReady,
      });

      const where = (
        prisma.smsGatewayDevice.count.mock.calls[0] as [
          { where: { lastSeenAt: { gte: Date }; canSend: boolean } },
        ]
      )[0].where;
      expect(where.canSend).toBe(true);
      expect(
        Date.now() - where.lastSeenAt.gte.getTime(),
      ).toBeGreaterThanOrEqual(90_000 - 50);
    });
  });

  it('startOfUtcDay is UTC midnight whatever the local time zone', () => {
    expect(
      startOfUtcDay(new Date('2026-09-30T23:59:59.999Z')).toISOString(),
    ).toBe('2026-09-30T00:00:00.000Z');
    expect(
      startOfUtcDay(new Date('2026-10-01T00:00:00.000Z')).toISOString(),
    ).toBe('2026-10-01T00:00:00.000Z');
  });
});
