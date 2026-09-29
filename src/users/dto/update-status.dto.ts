import { IsIn } from 'class-validator';
import { UserStatus } from '../../generated/prisma/client';

/**
 * The statuses staff may set. CLOSED is deliberately absent (H-16): only the
 * owner closes an account (DELETE /users/me), and nobody reopens one.
 */
export const STAFF_SETTABLE_STATUSES = [
  UserStatus.ACTIVE,
  UserStatus.SUSPENDED,
  UserStatus.BANNED,
] as const;

export class UpdateStatusDto {
  @IsIn(STAFF_SETTABLE_STATUSES)
  status!: (typeof STAFF_SETTABLE_STATUSES)[number];
}
