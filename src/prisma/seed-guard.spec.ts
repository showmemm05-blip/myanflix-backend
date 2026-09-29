import {
  SEED_PASSWORD_ENV,
  SEED_PRODUCTION_OVERRIDE_ENV,
  assertSeedAllowed,
  seedPassword,
} from './seed-guard';

describe('seed guard (H-2)', () => {
  describe('assertSeedAllowed', () => {
    it('refuses NODE_ENV=production and points at the bootstrap command', () => {
      expect(() =>
        assertSeedAllowed('seed.ts', { NODE_ENV: 'production' }),
      ).toThrow(/NODE_ENV=production[\s\S]*npm run create-superadmin/);
    });

    it('only an explicit override lets it run in production', () => {
      expect(() =>
        assertSeedAllowed('seed.ts', {
          NODE_ENV: 'production',
          [SEED_PRODUCTION_OVERRIDE_ENV]: 'yes',
        }),
      ).toThrow();
      expect(() =>
        assertSeedAllowed('seed.ts', {
          NODE_ENV: 'production',
          [SEED_PRODUCTION_OVERRIDE_ENV]: 'true',
        }),
      ).not.toThrow();
    });

    it('runs anywhere that is not production', () => {
      expect(() =>
        assertSeedAllowed('seed.ts', { NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() => assertSeedAllowed('seed.ts', {})).not.toThrow();
    });
  });

  describe('seedPassword — there is no default', () => {
    it('refuses to run without SEED_PASSWORD', () => {
      expect(() => seedPassword({})).toThrow(
        new RegExp(`Set ${SEED_PASSWORD_ENV}`),
      );
    });

    it('refuses a password shorter than 8 characters', () => {
      expect(() => seedPassword({ [SEED_PASSWORD_ENV]: 'short' })).toThrow(/8/);
    });

    it('returns the value that was set', () => {
      expect(seedPassword({ [SEED_PASSWORD_ENV]: 'a-local-dev-pass' })).toBe(
        'a-local-dev-pass',
      );
    });

    it('never echoes the value in its error', () => {
      expect(() => seedPassword({ [SEED_PASSWORD_ENV]: 'tiny' })).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('tiny') as unknown as string,
        }),
      );
    });
  });
});
