import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDepositDto } from './create-deposit.dto';

async function validateReference(reference: unknown) {
  const instance = plainToInstance(
    CreateDepositDto,
    { amount: 5000, paymentMethod: 'KBZ Pay', reference },
    { enableImplicitConversion: true },
  );
  const errors = await validate(instance);
  return errors.filter((e) => e.property === 'reference');
}

describe('CreateDepositDto — reference validation', () => {
  it('accepts a 6-digit string with leading zeros, unchanged', async () => {
    const instance = plainToInstance(
      CreateDepositDto,
      { amount: 5000, paymentMethod: 'KBZ Pay', reference: '000123' },
      { enableImplicitConversion: true },
    );
    expect(await validate(instance)).toHaveLength(0);
    expect(instance.reference).toBe('000123');
  });

  it('rejects a 5-digit reference', async () => {
    expect(await validateReference('12345')).not.toHaveLength(0);
  });

  it('rejects a 7-digit reference', async () => {
    expect(await validateReference('1234567')).not.toHaveLength(0);
  });

  it('rejects a non-numeric reference', async () => {
    expect(await validateReference('12a456')).not.toHaveLength(0);
  });

  it('rejects a raw JSON number whose value lost leading zeros before it arrived', async () => {
    // "000123" sent as a JS number is already 123 by the time it reaches
    // the backend — this is exactly the bug the string-only DTO shape
    // guards against, surfaced here as a length mismatch.
    expect(await validateReference(123)).not.toHaveLength(0);
  });

  it('does not reject a 6-digit value that happens to arrive as a JSON number with no leading zeros', async () => {
    // Documents actual behavior: enableImplicitConversion coerces this to
    // the string "123456" before validation, which passes the 6-digit
    // check. The frontend — not this DTO — is what must never let the
    // reference field be a number input in the first place.
    expect(await validateReference(123456)).toHaveLength(0);
  });
});
