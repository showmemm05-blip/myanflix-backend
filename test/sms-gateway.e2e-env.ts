/**
 * Imported FIRST by sms-gateway.e2e-spec.ts, before AppModule: ConfigModule
 * validates and snapshots the environment the moment app.module is
 * imported, so these must already be in place. Jest gives every test file
 * its own copy of process.env, so nothing here leaks into other specs
 * (e2e-setup.ts pins SMS_PROVIDER=log for them).
 */
export const E2E_SMS_GATEWAY_TOKEN =
  'e2e-sms-gateway-token-not-for-production-0123456789';
/** Low enough that the cap test can fill it; high enough for every other test. */
export const E2E_SMS_DAILY_CAP = 80;
/** Every other test queues at most two SMS to one number. */
export const E2E_SMS_DAILY_CAP_PER_PHONE = 3;

process.env.SMS_PROVIDER = 'phone-gateway';
process.env.SMS_GATEWAY_TOKEN = E2E_SMS_GATEWAY_TOKEN;
process.env.SMS_DAILY_CAP = String(E2E_SMS_DAILY_CAP);
process.env.SMS_DAILY_CAP_PER_PHONE = String(E2E_SMS_DAILY_CAP_PER_PHONE);
process.env.SMS_GATEWAY_OFFLINE_AFTER_SECONDS = '90';
