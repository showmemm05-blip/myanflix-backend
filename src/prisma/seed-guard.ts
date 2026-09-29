/**
 * H-2: the two rules every seed script obeys before it touches a database.
 *
 * - Never in production by accident. seed.ts wipes data and loads demo
 *   titles; both seeds write demo staff accounts. The first real Super Admin
 *   comes from `npm run create-superadmin`, never from a seed.
 * - No default password. Every seeded account gets the password the person
 *   running the seed chose for this run (SEED_PASSWORD); the repo holds none.
 */
export const SEED_PRODUCTION_OVERRIDE_ENV = 'ALLOW_SEED_IN_PRODUCTION';
export const SEED_PASSWORD_ENV = 'SEED_PASSWORD';

type Env = Record<string, string | undefined>;

export function assertSeedAllowed(
  script: string,
  env: Env = process.env,
): void {
  if (
    env.NODE_ENV === 'production' &&
    env[SEED_PRODUCTION_OVERRIDE_ENV] !== 'true'
  ) {
    throw new Error(
      `${script} refuses to run with NODE_ENV=production: it writes demo accounts` +
        `${script === 'seed.ts' ? ' and wipes existing data' : ''}. ` +
        'To create the first Super Admin, run "npm run create-superadmin". ' +
        `Only if you really mean to seed this database, set ${SEED_PRODUCTION_OVERRIDE_ENV}=true for this one run.`,
    );
  }
}

/** The password for every account this seed run creates. Never echoed. */
export function seedPassword(env: Env = process.env): string {
  const value = env[SEED_PASSWORD_ENV];
  if (!value) {
    throw new Error(
      `Set ${SEED_PASSWORD_ENV} for this run: every seeded account gets that password. There is no default.`,
    );
  }
  if (value.length < 8) {
    throw new Error(`${SEED_PASSWORD_ENV} must be at least 8 characters.`);
  }
  return value;
}
