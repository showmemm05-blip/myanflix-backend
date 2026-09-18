import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { BankEventBatchDto } from './bank-event-batch.dto';
import { BankScreenshotDto } from './bank-screenshot.dto';

/**
 * Run through the SAME ValidationPipe options AppModule registers
 * (whitelist + forbidNonWhitelisted + implicit conversion), because the
 * contract with the phone-monitor is "exactly these keys" — a stray key
 * must fail the whole batch, and every declared key must survive.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const validEvent = () => ({
  idempotencyKey: 'c'.repeat(64),
  deviceSerial: 'PIXEL10PRO',
  paymentAccountId: '11111111-1111-4111-8111-111111111111',
  direction: 'received',
  amount: 50000,
  currency: 'MMK',
  txCode: 'KBZ20260918AB12CD',
  txCodeLast6: 'AB12CD',
  occurredAt: '2026-09-18T09:41:12.000Z',
});

const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: BankEventBatchDto });

describe('BankEventBatchDto under the global ValidationPipe', () => {
  it('accepts the documented shape with every key, nested', async () => {
    const dto = (await validate({
      events: [validEvent()],
    })) as BankEventBatchDto;
    expect(dto.events).toHaveLength(1);
    expect(dto.events[0].amount).toBe(50000);
    expect(dto.events[0].direction).toBe('received');
  });

  it('accepts notificationText and an absent currency', async () => {
    const event = {
      ...validEvent(),
      notificationText: 'You received 50,000 MMK',
    };
    delete (event as { currency?: string }).currency;
    await expect(validate({ events: [event] })).resolves.toBeDefined();
  });

  it('rejects the WHOLE batch on an unknown key (forbidNonWhitelisted)', async () => {
    await expect(
      validate({
        events: [validEvent(), { ...validEvent(), screenshot: 'base64…' }],
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['idempotencyKey', 'ABC'],
    ['idempotencyKey', 'C'.repeat(64)],
    ['deviceSerial', ''],
    ['paymentAccountId', 'not-a-uuid'],
    ['direction', 'unknown'],
    ['amount', 0],
    ['amount', 12.345],
    ['currency', 'US'],
    ['txCode', 'AB-12'],
    ['txCodeLast6', 'AB12C'],
    ['occurredAt', 'yesterday'],
  ])('rejects a bad %s (%p)', async (field, value) => {
    await expect(
      validate({ events: [{ ...validEvent(), [field]: value }] }),
    ).rejects.toThrow();
  });

  it('rejects an empty batch and a batch over 100 events', async () => {
    await expect(validate({ events: [] })).rejects.toThrow();
    await expect(
      validate({ events: Array.from({ length: 101 }, validEvent) }),
    ).rejects.toThrow();
  });

  it('validates the screenshot text fields with the same key regex', async () => {
    await expect(
      pipe.transform(
        { idempotencyKey: 'c'.repeat(64), deviceSerial: 'PIXEL10PRO' },
        { type: 'body', metatype: BankScreenshotDto },
      ),
    ).resolves.toBeDefined();
    await expect(
      pipe.transform(
        { idempotencyKey: 'short' },
        { type: 'body', metatype: BankScreenshotDto },
      ),
    ).rejects.toThrow();
  });
});
