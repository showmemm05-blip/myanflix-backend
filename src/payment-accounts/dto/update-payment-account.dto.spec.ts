import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentAccountDto } from './create-payment-account.dto';
import { UpdatePaymentAccountDto } from './update-payment-account.dto';

/**
 * F-002: a note-only PATCH must not re-activate a retired account. Asserted as
 * "undefined / not an own property" rather than via Object.keys — tsconfig
 * targets ES2023, so every declared field is an own `undefined` prop.
 */
describe('UpdatePaymentAccountDto — no inherited isActive default', () => {
  it('{note} leaves isActive untouched and validates', async () => {
    const instance = plainToInstance(UpdatePaymentAccountDto, {
      note: 'only note',
    });

    expect(instance.isActive).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(instance, 'isActive')).toBe(
      false,
    );
    expect(await validate(instance)).toHaveLength(0);
  });

  it('{} carries no defined value at all', () => {
    const instance = plainToInstance(UpdatePaymentAccountDto, {}) as Record<
      string,
      unknown
    >;
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('keeps an explicit isActive: false', async () => {
    const instance = plainToInstance(UpdatePaymentAccountDto, {
      isActive: false,
    });

    expect(instance.isActive).toBe(false);
    expect(await validate(instance)).toHaveLength(0);
  });
});

describe('CreatePaymentAccountDto — isActive default belongs to Prisma', () => {
  it('leaves isActive undefined when the body omits it', async () => {
    const instance = plainToInstance(CreatePaymentAccountDto, {
      type: 'KBZPay',
      accountName: 'Kyaw Kyaw',
      accountNumber: '0907672630',
    });

    expect(instance.isActive).toBeUndefined();
    expect(await validate(instance)).toHaveLength(0);
  });
});
