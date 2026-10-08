import { Prisma } from '../generated/prisma/client';

/**
 * True for Prisma's P2002: an insert or update hit a UNIQUE constraint
 * (username, phone, email, googleId …). Shared by the Google and the phone
 * sign-up so both recover from a taken username the same way instead of
 * letting the raw error surface as a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
