/**
 * Imported FIRST by deposits.e2e-spec.ts, before AppModule: ConfigModule
 * validates and snapshots the environment the moment app.module is
 * imported, so BANK_EVENTS_TOKEN must already be in place for the
 * phone-monitor routes (SEC-004: the device pin and the screenshot rule
 * are exercised over HTTP there). Jest gives every test file its own copy
 * of process.env, so nothing here leaks into other specs.
 */
export const E2E_BANK_EVENTS_TOKEN =
  'e2e-bank-events-token-not-for-production-0123456789';

process.env.BANK_EVENTS_TOKEN = E2E_BANK_EVENTS_TOKEN;
