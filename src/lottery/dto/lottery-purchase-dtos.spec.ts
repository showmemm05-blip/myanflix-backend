import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateLotteryPurchaseDto,
  PurchasePageQueryDto,
  TicketPageQueryDto,
} from './lottery-purchase.dto';

/** The same options as the global ValidationPipe in app.module.ts. */
const TRANSFORM = { enableImplicitConversion: true } as const;

async function errorsOf<T extends object>(
  Dto: new () => T,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(Dto, body, TRANSFORM);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, fields: errors.map((e) => e.property).sort() };
}

const KEY = '7f3b4d4e-1111-4c2a-9a9a-0123456789ab';
const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    number: String(i).padStart(6, '0'),
    quantity: 1,
  }));

describe('CreateLotteryPurchaseDto', () => {
  it('accepts a basket, trimming the numbers and coercing the figures', async () => {
    const { instance, fields } = await errorsOf(CreateLotteryPurchaseDto, {
      drawNo: '24',
      idempotencyKey: KEY,
      lines: [
        { number: ' 123456 ', quantity: '2' },
        { number: '000777', quantity: 3 },
      ],
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      drawNo: 24,
      idempotencyKey: KEY,
      lines: [
        { number: '123456', quantity: 2 },
        { number: '000777', quantity: 3 },
      ],
    });
    expect(
      (
        await errorsOf(CreateLotteryPurchaseDto, {
          drawNo: 1,
          idempotencyKey: KEY,
          lines: lines(50),
        })
      ).fields,
    ).toEqual([]);
  });

  it('refuses a missing or bad draw number and key', async () => {
    const base = { lines: lines(1) };
    expect((await errorsOf(CreateLotteryPurchaseDto, base)).fields).toEqual([
      'drawNo',
      'idempotencyKey',
    ]);
    expect(
      (
        await errorsOf(CreateLotteryPurchaseDto, {
          ...base,
          drawNo: 0,
          idempotencyKey: 'retry-1',
        })
      ).fields,
    ).toEqual(['drawNo', 'idempotencyKey']);
  });

  it('refuses an empty basket, over 50 lines, a repeated number, a bad number and a bad quantity', async () => {
    const base = { drawNo: 24, idempotencyKey: KEY };
    for (const body of [
      { ...base, lines: [] },
      { ...base, lines: lines(51) },
      {
        ...base,
        lines: [
          { number: '123456', quantity: 1 },
          { number: '123456', quantity: 2 },
        ],
      },
      { ...base, lines: [{ number: '12345', quantity: 1 }] },
      { ...base, lines: [{ number: '12a456', quantity: 1 }] },
      { ...base, lines: [{ number: '123456', quantity: 0 }] },
      { ...base, lines: [{ number: '123456', quantity: 101 }] },
      { ...base, lines: [{ number: '123456', quantity: 1.5 }] },
      { ...base, lines: [{ number: '123456' }] },
      { ...base, lines: ['123456'] },
      { ...base, lines: [{ number: '123456', quantity: 1, price: 1 }] },
    ]) {
      expect((await errorsOf(CreateLotteryPurchaseDto, body)).fields).toEqual([
        'lines',
      ]);
    }
  });

  it('refuses a field nobody asked for', async () => {
    expect(
      (
        await errorsOf(CreateLotteryPurchaseDto, {
          drawNo: 24,
          idempotencyKey: KEY,
          lines: lines(1),
          total: 1000,
        })
      ).fields,
    ).toEqual(['total']);
  });
});

describe('PurchasePageQueryDto / TicketPageQueryDto', () => {
  it('default to page 1 of 20', async () => {
    expect((await errorsOf(PurchasePageQueryDto, {})).instance).toEqual({
      page: 1,
      pageSize: 20,
    });
    expect((await errorsOf(TicketPageQueryDto, {})).instance).toEqual({
      page: 1,
      pageSize: 20,
    });
  });

  it('cap the page size at 100 for purchases and 200 for tickets', async () => {
    expect(
      (await errorsOf(PurchasePageQueryDto, { pageSize: 100 })).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(PurchasePageQueryDto, { pageSize: 101 })).fields,
    ).toEqual(['pageSize']);
    expect(
      (await errorsOf(TicketPageQueryDto, { pageSize: 200 })).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(TicketPageQueryDto, { pageSize: 201 })).fields,
    ).toEqual(['pageSize']);
  });

  it('take an optional draw number for tickets, whole and at least 1', async () => {
    const ok = await errorsOf(TicketPageQueryDto, { drawNo: '24' });
    expect(ok.fields).toEqual([]);
    expect(ok.instance.drawNo).toBe(24);
    expect((await errorsOf(TicketPageQueryDto, { drawNo: 0 })).fields).toEqual([
      'drawNo',
    ]);
    expect(
      (await errorsOf(TicketPageQueryDto, { drawNo: 'abc' })).fields,
    ).toEqual(['drawNo']);
    expect(
      (await errorsOf(PurchasePageQueryDto, { drawNo: 24 })).fields,
    ).toEqual(['drawNo']);
  });
});
