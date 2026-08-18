import type { Role } from '../../generated/prisma/client';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: Role;
}
