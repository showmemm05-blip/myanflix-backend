import { DEFAULT_DATABASE_POOL_MAX, resolvePoolMax } from './prisma.service';

describe('resolvePoolMax', () => {
  it("keeps node-postgres' default of 10 when DATABASE_POOL_MAX is unset or empty", () => {
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
    expect(resolvePoolMax(undefined)).toBe(10);
    expect(resolvePoolMax('')).toBe(10);
  });

  it('uses the validated number, or a numeric string', () => {
    expect(resolvePoolMax(20)).toBe(20);
    expect(resolvePoolMax('25')).toBe(25);
  });

  it('falls back to the default for anything that is not a whole number of at least 1', () => {
    expect(resolvePoolMax(0)).toBe(10);
    expect(resolvePoolMax(-3)).toBe(10);
    expect(resolvePoolMax(2.5)).toBe(10);
    expect(resolvePoolMax('lots')).toBe(10);
  });
});
