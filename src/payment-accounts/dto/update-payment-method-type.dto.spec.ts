import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePaymentMethodTypeDto } from './create-payment-method-type.dto';
import { UpdatePaymentMethodTypeDto } from './update-payment-method-type.dto';

/**
 * F-002: a logo-only PATCH must not reset requiresBankName. Asserted as
 * "undefined / not an own property" rather than via Object.keys — tsconfig
 * targets ES2023, so every declared field is an own `undefined` prop.
 */
describe('UpdatePaymentMethodTypeDto — no inherited requiresBankName default', () => {
  it('{logoUrl} leaves requiresBankName untouched and validates', async () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {
      logoUrl: 'https://x/y.png',
    });

    expect(instance.requiresBankName).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(instance, 'requiresBankName'),
    ).toBe(false);
    expect(await validate(instance)).toHaveLength(0);
  });

  it('{} carries no defined value at all', () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {}) as Record<
      string,
      unknown
    >;
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('keeps an explicit requiresBankName: true', async () => {
    const instance = plainToInstance(UpdatePaymentMethodTypeDto, {
      requiresBankName: true,
    });

    expect(instance.requiresBankName).toBe(true);
    expect(await validate(instance)).toHaveLength(0);
  });
});

describe('CreatePaymentMethodTypeDto — requiresBankName default belongs to createType', () => {
  it('leaves requiresBankName undefined when the body omits it', async () => {
    const instance = plainToInstance(CreatePaymentMethodTypeDto, {
      label: 'x',
    });

    expect(instance.requiresBankName).toBeUndefined();
    expect(await validate(instance)).toHaveLength(0);
  });
});
