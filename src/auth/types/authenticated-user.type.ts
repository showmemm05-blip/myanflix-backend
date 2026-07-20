import type { Role } from '../../generated/prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  role: Role;
}
