import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DeviceHeartbeatDto } from './device-heartbeat.dto';
import { JobResultDto } from './job-result.dto';
import { PollJobsQueryDto } from './poll-jobs-query.dto';

/**
 * Through the SAME ValidationPipe options AppModule registers (whitelist +
 * forbidNonWhitelisted + implicit conversion): the contract with the
 * gateway app is "exactly these keys".
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const heartbeat = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: DeviceHeartbeatDto,
  }) as Promise<DeviceHeartbeatDto>;
const result = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: JobResultDto,
  }) as Promise<JobResultDto>;
const poll = (query: unknown) =>
  pipe.transform(query, {
    type: 'query',
    metatype: PollJobsQueryDto,
  }) as Promise<PollJobsQueryDto>;

const validHeartbeat = () => ({
  appVersion: '1.0.0 (1)',
  battery: 87,
  charging: true,
  signalLevel: 3,
  networkType: 'LTE',
  simOperator: 'ATOM',
  pendingResults: 0,
  lastError: null,
});

describe('DeviceHeartbeatDto', () => {
  it('accepts the documented shape, with nulls where the phone cannot tell', async () => {
    const dto = await heartbeat({
      ...validHeartbeat(),
      signalLevel: null,
      networkType: null,
      simOperator: null,
    });
    expect(dto).toMatchObject({
      battery: 87,
      charging: true,
      signalLevel: null,
      networkType: null,
      simOperator: null,
      lastError: null,
    });
  });

  it('reads charging "false" as false, not as a truthy string', async () => {
    const dto = await heartbeat({ ...validHeartbeat(), charging: 'false' });
    expect(dto.charging).toBe(false);
  });

  it('B5: accepts the optional canSend verdict and its reason, and leaves both out when the app does', async () => {
    await expect(
      heartbeat({
        ...validHeartbeat(),
        canSend: false,
        notReadyReason: 'no_service',
      }),
    ).resolves.toMatchObject({ canSend: false, notReadyReason: 'no_service' });
    await expect(
      heartbeat({ ...validHeartbeat(), canSend: 'false' }),
    ).resolves.toMatchObject({ canSend: false });
    await expect(
      heartbeat({ ...validHeartbeat(), canSend: true, notReadyReason: null }),
    ).resolves.toMatchObject({ canSend: true, notReadyReason: null });

    const without = await heartbeat(validHeartbeat());
    expect(without.canSend).toBeUndefined();
    expect(without.notReadyReason).toBeUndefined();
  });

  it.each([
    ['battery above 100', { battery: 101 }],
    ['a negative battery', { battery: -1 }],
    ['signal above 4', { signalLevel: 5 }],
    ['a fractional battery', { battery: 50.5 }],
    ['a negative pendingResults', { pendingResults: -1 }],
    ['an appVersion over 32 characters', { appVersion: 'v'.repeat(33) }],
    ['a networkType over 32 characters', { networkType: 'n'.repeat(33) }],
    ['a simOperator over 64 characters', { simOperator: 's'.repeat(65) }],
    ['a lastError over 200 characters', { lastError: 'e'.repeat(201) }],
    ['a canSend that is not a boolean', { canSend: 'maybe' }],
    ['a notReadyReason over 64 characters', { notReadyReason: 'r'.repeat(65) }],
    ['a notReadyReason that is not a string', { notReadyReason: 42 }],
    ['a stray key', { imei: '123' }],
  ])('rejects %s', async (_label, patch) => {
    await expect(heartbeat({ ...validHeartbeat(), ...patch })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a heartbeat missing a required key', async () => {
    const body: Record<string, unknown> = validHeartbeat();
    delete body.pendingResults;
    await expect(heartbeat(body)).rejects.toThrow(BadRequestException);
  });
});

describe('JobResultDto', () => {
  const occurredAt = '2026-09-30T10:00:00.000Z';

  it.each(['SENT', 'FAILED', 'DELIVERED', 'DELIVERY_FAILED'])(
    'accepts %s',
    async (status) => {
      await expect(result({ status, occurredAt })).resolves.toMatchObject({
        status,
      });
    },
  );

  it('accepts an error code and message', async () => {
    await expect(
      result({
        status: 'FAILED',
        errorCode: 'expired',
        errorMessage: 'Job expired before it could be sent',
        occurredAt,
      }),
    ).resolves.toMatchObject({ errorCode: 'expired' });
  });

  it.each([
    ['a status the phone may not set', { status: 'QUEUED', occurredAt }],
    ['a status the phone may not set', { status: 'UNKNOWN', occurredAt }],
    ['a missing occurredAt', { status: 'SENT' }],
    ['a non-ISO occurredAt', { status: 'SENT', occurredAt: 'yesterday' }],
    [
      'an errorCode over 64 characters',
      { status: 'FAILED', occurredAt, errorCode: 'c'.repeat(65) },
    ],
    [
      'an errorMessage over 200 characters',
      { status: 'FAILED', occurredAt, errorMessage: 'm'.repeat(201) },
    ],
    ['a stray key', { status: 'SENT', occurredAt, body: 'x' }],
  ])('rejects %s', async (_label, body) => {
    await expect(result(body)).rejects.toThrow(BadRequestException);
  });
});

describe('PollJobsQueryDto', () => {
  it('reads wait from the query string, 0-30', async () => {
    await expect(poll({ wait: '0' })).resolves.toEqual({ wait: 0 });
    await expect(poll({ wait: '30' })).resolves.toEqual({ wait: 30 });
    await expect(poll({})).resolves.toEqual({});
  });

  it.each(['31', '-1', '2.5', 'soon'])('rejects wait=%s', async (wait) => {
    await expect(poll({ wait })).rejects.toThrow(BadRequestException);
  });
});
