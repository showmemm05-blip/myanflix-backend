import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { IsBoolean, IsOptional, validate } from 'class-validator';
import { ToBoolean } from './to-boolean.decorator';

/**
 * Exercised WITH `enableImplicitConversion` on purpose — that is how the
 * global ValidationPipe runs (src/app.module.ts). Under it the executor
 * coerces the property with Boolean() before custom transforms, so a
 * value-based ToBoolean would silently see `true` for 'false' and this spec
 * would be the only thing catching that regression.
 */
class Dto {
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  flag?: boolean = false;
}

async function run(body: Record<string, unknown>) {
  const instance = plainToInstance(Dto, body, {
    enableImplicitConversion: true,
  });
  const errors = await validate(instance);
  return { instance, errors: errors.filter((e) => e.property === 'flag') };
}

describe('ToBoolean', () => {
  it.each([
    ['false', false],
    ['0', false],
    ['true', true],
    ['1', true],
    [' TRUE ', true],
    ['False', false],
  ])('reads the string %p as %p', async (raw, expected) => {
    const { instance, errors } = await run({ flag: raw });
    expect(errors).toHaveLength(0);
    expect(instance.flag).toBe(expected);
  });

  it.each([true, false])('passes the boolean %p through', async (raw) => {
    const { instance, errors } = await run({ flag: raw });
    expect(errors).toHaveLength(0);
    expect(instance.flag).toBe(raw);
  });

  it.each(['maybe', 'no', 'yes', ''])(
    'rejects the string %p with one error on the property',
    async (raw) => {
      const { errors } = await run({ flag: raw });
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isBoolean');
    },
  );

  it('rejects the number 1', async () => {
    const { errors } = await run({ flag: 1 });
    expect(errors).toHaveLength(1);
  });

  it('rejects an object', async () => {
    const { errors } = await run({ flag: {} });
    expect(errors).toHaveLength(1);
  });

  it('keeps the class initializer when the key is absent', async () => {
    const { instance, errors } = await run({});
    expect(errors).toHaveLength(0);
    expect(instance.flag).toBe(false);
  });

  it('lets null through under @IsOptional', async () => {
    const { instance, errors } = await run({ flag: null });
    expect(errors).toHaveLength(0);
    expect(instance.flag).toBeNull();
  });
});
