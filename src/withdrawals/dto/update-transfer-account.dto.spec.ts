import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTransferAccountDto } from './update-transfer-account.dto';

const BASE = {
  transferAccountType: 'KBZ Pay',
  transferAccountName: 'Kyaw Kyaw',
  transferAccountNumber: '0907672630',
  transferTransactionCode: 'AB12CD',
};

async function validateTime(transferTransactionTime: unknown) {
  const instance = plainToInstance(UpdateTransferAccountDto, {
    ...BASE,
    transferTransactionTime,
  });
  const errors = await validate(instance);
  return { instance, errors: errors.filter((e) => e.property === 'transferTransactionTime') };
}

describe('UpdateTransferAccountDto — transferTransactionTime normalization', () => {
  it('accepts HH:MM:SS unchanged', async () => {
    const { instance, errors } = await validateTime('06:56:28');
    expect(errors).toHaveLength(0);
    expect(instance.transferTransactionTime).toBe('06:56:28');
  });

  it('converts HH.MM.SS to HH:MM:SS', async () => {
    const { instance, errors } = await validateTime('06.56.28');
    expect(errors).toHaveLength(0);
    expect(instance.transferTransactionTime).toBe('06:56:28');
  });

  it('rejects an out-of-range hour', async () => {
    const { errors } = await validateTime('24.00.00');
    expect(errors).not.toHaveLength(0);
  });

  it('rejects an out-of-range minute', async () => {
    const { errors } = await validateTime('06.60.28');
    expect(errors).not.toHaveLength(0);
  });

  it('rejects an out-of-range second', async () => {
    const { errors } = await validateTime('06.56.60');
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a value that includes a date', async () => {
    const { errors } = await validateTime('2026-08-10 06:56:28');
    expect(errors).not.toHaveLength(0);
  });

  it('rejects free text no longer accepted now that a strict format is required', async () => {
    const { errors } = await validateTime('Aug 10 2:30pm');
    expect(errors).not.toHaveLength(0);
  });

  it('accepts midnight and the last second of the day as valid boundaries', async () => {
    expect((await validateTime('00.00.00')).errors).toHaveLength(0);
    expect((await validateTime('23.59.59')).errors).toHaveLength(0);
  });
});
