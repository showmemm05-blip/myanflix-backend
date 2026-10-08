/**
 * Imported FIRST by otp-dev-code.e2e-spec.ts, before AppModule (ConfigModule
 * validates and snapshots the environment when app.module is imported).
 * Jest gives every test file its own process.env, so nothing leaks.
 *
 * The phone gateway is switched ON (and no phone ever checks in, so it is
 * "offline"): a normal code request would answer 503. With OTP_DEV_CODE set
 * the gateway must never be reached, so every request still answers 200.
 * STREAM_PUBLIC_BASE_URL stays the localhost base e2e-setup.ts sets.
 */
export const E2E_OTP_DEV_CODE = '246810';

process.env.OTP_DEV_CODE = E2E_OTP_DEV_CODE;
process.env.OTP_CODE_PEPPER = 'e2e-test-otp-code-pepper-not-for-production-01';
process.env.SMS_PROVIDER = 'phone-gateway';
process.env.SMS_GATEWAY_TOKEN =
  'e2e-sms-gateway-token-not-for-production-0123456789';
