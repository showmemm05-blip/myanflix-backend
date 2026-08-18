import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateReceivingAccountDto } from './update-receiving-account.dto';

const BASE = {
  receivingAccountType: 'KBZ Pay',
  receivingAccountName: 'Kyaw Kyaw',
  receivingAccountNumber: '0907672630',
};

async function validateTime(receivingTransactionTime: unknown) {
  const instance = plainToInstance(UpdateReceivingAccountDto, {
    ...BASE,
    receivingTransactionTime,
  });
  const errors = await validate(instance);
  return { instance, errors: errors.filter((e) => e.property === 'receivingTransactionTime') };
}

describe('UpdateReceivingAccountDto — receivingTransactionTime normalization', () => {
  it('accepts HH:MM:SS unchanged', async () => {
    const { instance, errors } = await validateTime('06:56:28');
    expect(errors).toHaveLength(0);
    expect(instance.receivingTransactionTime).toBe('06:56:28');
  });

  it('converts HH.MM.SS to HH:MM:SS', async () => {
    const { instance, errors } = await validateTime('06.56.28');
    expect(errors).toHaveLength(0);
    expect(instance.receivingTransactionTime).toBe('06:56:28');
  });

  it('rejects an out-of-range hour', async () => {
    expect((await validateTime('24.00.00')).errors).not.toHaveLength(0);
  });

  it('rejects an out-of-range minute', async () => {
    expect((await validateTime('06.60.28')).errors).not.toHaveLength(0);
  });

  it('rejects an out-of-range second', async () => {
    expect((await validateTime('06.56.60')).errors).not.toHaveLength(0);
  });

  it('rejects a value that includes a date', async () => {
    expect((await validateTime('2026-08-10 06:56:28')).errors).not.toHaveLength(0);
  });

  it('accepts midnight and the last second of the day as valid boundaries', async () => {
    expect((await validateTime('00.00.00')).errors).toHaveLength(0);
    expect((await validateTime('23.59.59')).errors).toHaveLength(0);
  });
});

describe('UpdateReceivingAccountDto — receivingTransactionCode', () => {
  async function validateCode(receivingTransactionCode: unknown) {
    const instance = plainToInstance(UpdateReceivingAccountDto, {
      ...BASE,
      receivingTransactionTime: '06:56:28',
      receivingTransactionCode,
    });
    const errors = await validate(instance);
    return errors.filter((e) => e.property === 'receivingTransactionCode');
  }

  it('is optional — the admin form no longer collects it', async () => {
    expect(await validateCode(undefined)).toHaveLength(0);
  });

  it('accepts exactly 6 alphanumeric characters when provided', async () => {
    expect(await validateCode('AB12CD')).toHaveLength(0);
  });

  it('rejects fewer than 6 characters when provided', async () => {
    expect(await validateCode('AB12C')).not.toHaveLength(0);
  });

  it('rejects more than 6 characters when provided', async () => {
    expect(await validateCode('AB12CDE')).not.toHaveLength(0);
  });
});

describe('UpdateReceivingAccountDto — receivingAccountSubname', () => {
  it('is optional', async () => {
    const instance = plainToInstance(UpdateReceivingAccountDto, {
      ...BASE,
      receivingTransactionTime: '06:56:28',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('accepts a short subname when provided', async () => {
    const instance = plainToInstance(UpdateReceivingAccountDto, {
      ...BASE,
      receivingTransactionTime: '06:56:28',
      receivingAccountSubname: 'K1',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
