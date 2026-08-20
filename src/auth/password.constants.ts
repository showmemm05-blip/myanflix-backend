/**
 * bcrypt cost factor for every password this platform ever hashes.
 *
 * Lives in its own leaf module (no imports) rather than in auth.service.ts so
 * UsersService can hash a self-service password change with the exact same
 * cost without importing AuthService — which would close the
 * auth -> users -> auth require cycle.
 */
export const PASSWORD_SALT_ROUNDS = 10;
